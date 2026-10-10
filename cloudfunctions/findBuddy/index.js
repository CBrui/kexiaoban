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
 *   - `getCourses` ：{ friendOwnerId } → { ok, courses }
 *   - `listFriends`：→ { ok, friends:[{owner_id, nickname, avatar_url, ...}] }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PROFILES = 'profiles';
const COURSES = 'courses';
const RELATIONS = 'relations';

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
 */
async function getCourses(friendOwnerId, myOwnerId) {
  const fid = String(friendOwnerId || '').trim();
  if (!fid) return fail('INVALID_FRIEND', '缺少对方身份标识');
  if (fid === myOwnerId) return fail('SELF', '不能和自己找搭子');

  // 授权校验：必须已建立「我 → 对方」的绑定关系（relations 由客户端写入）
  const rel = await db.collection(RELATIONS)
    .where({ owner_id: myOwnerId, friend_owner_id: fid })
    .limit(1)
    .get();
  if (!rel.data || !rel.data.length) {
    return fail('NO_RELATION', '尚未与该同学建立关系，无法读取其课表');
  }

  const res = await db.collection(COURSES).where({ _openid: fid }).get();
  return ok({ courses: res.data || [] });
}

/**
 * 列出与我绑定的同学（带昵称/头像），供找搭子页的多选列表展示。
 *
 * 为什么走云函数：relations 只有「我 → 对方」方向的文档能被我读到，
 * 但对方的 profiles 是 PRIVATE 的，昵称必须由服务端补齐。
 * 只回传与我存在绑定关系的同学的展示字段，不透出其它任何数据。
 */
async function listFriends(openid) {
  const rels = await db.collection(RELATIONS).where({ owner_id: openid }).get();
  const ids = Array.from(new Set(
    (rels.data || []).map((r) => r && r.friend_owner_id).filter(Boolean)
  ));
  if (!ids.length) return ok({ friends: [] });

  const _ = db.command;
  const res = await db.collection(PROFILES).where({ _openid: _.in(ids) }).get();

  // 以关系表为准（保证顺序与去重），档案缺失的同学回退为空昵称
  const byId = {};
  (res.data || []).forEach((doc) => { byId[ownerIdOf(doc)] = doc; });

  const friends = ids.map((id) => {
    const doc = byId[id] || {};
    return {
      owner_id: id,
      nickname: doc.nickname || '',
      avatar_url: doc.avatar_url || '',
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
