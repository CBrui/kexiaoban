/**
 * 云函数 findBuddy —— 「找搭子」的服务端数据入口
 *
 * 为什么必须走云函数：
 *   `courses` / `profiles` 两个集合的权限都是「仅创建者可读写」(PRIVATE)，
 *   客户端直接查询只能读到自己的数据 ——
 *     · 按邀请码找同学（findByInviteCode）查不到别人的 profiles
 *     · 读对方课程（listCoursesByOwner）查不到别人的 courses
 *   两者在云模式下都会返回空。云函数运行在服务端、具备管理端权限，可跨用户
 *   读取，是绕过集合权限的唯一正路（把集合放开为「所有人可读」会泄露全部数据，
 *   不可取）。
 *
 * 安全边界：
 *   1. 调用者身份一律取 `cloud.getWXContext().OPENID`，绝不信任客户端传入的身份。
 *   2. `findProfile` 以「持有邀请码」为授权 —— 邀请码即本 App 的分享凭据，
 *      用户拿到对方的邀请码才可能发起找搭子。
 *   3. `getCourses` 要求调用者与目标之间**已存在绑定关系**（relations 由客户端
 *      bindFriend 写入），否则拒绝，避免仅凭对方身份标识就读取其课程。
 *
 * 动作（event.action）：
 *   - `findProfile`：{ inviteCode } → { ok, profile|null }
 *   - `getCourses` ：{ friendOwnerId } → { ok, courses, hasTimetable }
 *   - `listFriends`：→ { ok, friends:[{owner_id, nickname, avatar_url, ...}] }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PROFILES = 'profiles';
const COURSES = 'courses';
const RELATIONS = 'relations';
const TIMETABLES = 'timetables';

const ok = (data) => Object.assign({ ok: true }, data);
const fail = (error, message) => ({ ok: false, error, message: message || '' });

/**
 * 归一化档案身份：云端老文档的 owner_id 不一定回填过，统一回退到平台写入的 _openid。
 * （与客户端 api/profile.js 的 normalizeProfile 保持一致的口径）
 */
function ownerIdOf(doc) {
  return doc.owner_id || doc._openid || doc._id || null;
}

/**
 * 按邀请码查同学档案。
 * 只回传找搭子必需的展示字段，不整份透出档案文档。
 */
async function findProfile(inviteCode) {
  const code = String(inviteCode || '').trim().toUpperCase();
  if (!code) return fail('INVALID_CODE', '邀请码为空');

  const res = await db.collection(PROFILES).where({ invite_code: code }).limit(1).get();
  const doc = (res.data && res.data[0]) || null;
  if (!doc) return ok({ profile: null });

  const ownerId = ownerIdOf(doc);
  if (!ownerId) return fail('BAD_PROFILE', '对方档案缺少身份标识');

  return ok({
    profile: {
      owner_id: ownerId,
      nickname: doc.nickname || '',
      college: doc.college || '',
      major: doc.major || '',
      class_name: doc.class_name || ''
    }
  });
}

/**
 * 取对方全部课程（跨课表合并 —— 找搭子关心的是「对方所有课程造成的占用」，
 * 因此**不**按 timetable_id 过滤，与客户端原有语义一致）。
 *
 * 同时回报 `hasTimetable`：客户端「找搭子」在对方无课程时要把人跳过，
 * 但**「没建课表」和「建了课表、只是还没录课程」是两回事**，
 * 提示语需要区分（前者该去建表，后者该去录课程），因此这里顺手统计一下
 * 对方的课表数，把判断依据一并回传，避免客户端只能笼统地报「没建课表」。
 */
async function getCourses(friendOwnerId, myOwnerId) {
  const fid = String(friendOwnerId || '').trim();
  if (!fid) return fail('INVALID_FRIEND', '缺少对方身份标识');
  if (fid === myOwnerId) return fail('SELF', '不能和自己找搭子');

  // 授权校验：必须已建立「我 → 对方」的绑定关系（relations 由客户端写入）。
  // 用 `_openid`（平台按调用者身份自动写入，客户端不可伪造、也不会随业务字段变动）
  // 作为主判据；再兜一层 `owner_id`，兼容历史上把身份写进 owner_id 的关系记录。
  const _ = db.command;
  const rel = await db.collection(RELATIONS)
    .where(_.or([
      { _openid: myOwnerId, friend_owner_id: fid },
      { owner_id: myOwnerId, friend_owner_id: fid }
    ]))
    .limit(1)
    .get();
  if (!rel.data || !rel.data.length) {
    return fail('NO_RELATION', '尚未与该同学建立关系，无法读取其课表');
  }

  const res = await db.collection(COURSES).where({ _openid: fid }).get();

  // 对方是否至少有一张课表（用于区分「没建课表」与「课表没录课程」）。
  // 统计失败不影响课程返回，降级为「未知」（按 false 处理即可）。
  let hasTimetable = false;
  try {
    const tRes = await db.collection(TIMETABLES).where({ _openid: fid }).count();
    hasTimetable = (tRes.total || 0) > 0;
  } catch (e) {
    console.warn('[findBuddy] 统计对方课表数失败（不影响课程返回）', e);
  }

  return ok({ courses: res.data || [], hasTimetable });
}

/**
 * 列出与我绑定的同学（带昵称/头像），供找搭子页的多选列表展示。
 *
 * 为什么走云函数：relations 只有「我 → 对方」方向的文档能被我读到，
 * 但对方的 profiles 是 PRIVATE 的，昵称必须由服务端补齐。
 * 只回传与我存在绑定关系的同学的展示字段，不透出其它任何数据。
 *
 * ⚠️ 昵称为什么要「多级兜底」（踩过的坑）：
 *   关系表里存的是**绑定那一刻**对方的 `owner_id`。而历史上服务端建档没有写
 *   `_openid`，导致新用户每次登录都会新建一份档案、身份（owner_id）随之改变 ——
 *   于是老绑定指向的 id 再也解析不到对方档案，名字就退化成「同学+身份尾号」，
 *   看起来像「名字也跟着邀请码一起变了」。
 *   这里做两件事把名字尽量找回来：
 *     1. 档案解析同时按 `_openid` / `owner_id` / `_id` 三种键命中
 *        （兼容「客户端建档」「服务端建档」以及身份退化成文档 _id 的历史数据）；
 *     2. 仍解析不到时，回退到**绑定当时存进关系表的 `friend_nickname`**，
 *        而不是直接给空——空会让客户端拿会变的身份尾号凑名字。
 *   注意：这只修复「显示名」。若对方身份确实已变，读其课程仍会失败，
 *   需要对方重新分享邀请码、重新绑定一次（见 README「登录与身份」）。
 */
async function listFriends(openid) {
  const _ = db.command;

  // 关系表由客户端 bindFriend 写入，平台会自动带上 `_openid`，用它查最可靠；
  // 再兜一层 `owner_id`，兼容把身份写在 owner_id 的关系记录。
  const rels = await db.collection(RELATIONS)
    .where(_.or([{ _openid: openid }, { owner_id: openid }]))
    .get();

  const relList = (rels.data || []).filter((r) => r && r.friend_owner_id);
  const ids = Array.from(new Set(relList.map((r) => r.friend_owner_id)));
  if (!ids.length) return ok({ friends: [] });

  // 以关系表为准（保证顺序与去重），并按好友 id 建索引，供昵称兜底
  const relByFriend = {};
  relList.forEach((r) => {
    if (!relByFriend[r.friend_owner_id]) relByFriend[r.friend_owner_id] = r;
  });

  // 档案解析：三种身份键都试（解析失败不影响返回，改用关系表昵称兜底）
  let docs = [];
  try {
    const res = await db.collection(PROFILES).where(_.or([
      { _openid: _.in(ids) },
      { owner_id: _.in(ids) },
      { _id: _.in(ids) }
    ])).get();
    docs = res.data || [];
  } catch (e) {
    console.warn('[findBuddy] 解析同学档案失败，改用关系表昵称兜底', e);
  }

  // 一份档案可能同时被多个键命中，三个键都登记，谁先到用谁
  const byId = {};
  docs.forEach((doc) => {
    [doc._openid, doc.owner_id, doc._id].forEach((k) => {
      if (k && !byId[k]) byId[k] = doc;
    });
  });

  const friends = ids.map((id) => {
    const doc = byId[id] || {};
    const rel = relByFriend[id] || {};
    return {
      owner_id: id,
      // 名字三级兜底：当前档案 → 绑定当时存的昵称 → 交给客户端用身份尾号兜底
      nickname: doc.nickname || rel.friend_nickname || '',
      avatar_url: doc.avatar_url || rel.friend_avatar_url || '',
      college: doc.college || '',
      major: doc.major || '',
      class_name: doc.class_name || ''
    };
  });
  return ok({ friends });
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '未取得调用者身份');

  const action = event && event.action;
  try {
    if (action === 'findProfile') return await findProfile(event.inviteCode);
    if (action === 'getCourses') return await getCourses(event.friendOwnerId, OPENID);
    if (action === 'listFriends') return await listFriends(OPENID);
    return fail('UNKNOWN_ACTION', '未知动作：' + action);
  } catch (e) {
    console.error('[findBuddy] 执行失败', action, e);
    return fail('INTERNAL', String((e && e.message) || e));
  }
};
