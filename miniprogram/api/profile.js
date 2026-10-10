/**
 * api/profile.js —— 用户档案 CRUD
 *
 * 登录链路：微信登录 → 换取用户会话 → 首次登录自动创建档案并生成邀请码。
 *
 * 身份模型（全项目统一约定）：
 *   对外一律用 owner_id 表示「当前登录身份」，由本模块的 normalizeProfile 保证存在。
 *   本地模式下 owner_id 是本模块生成的模拟身份；
 *   云模式下它是平台写入文档的 _openid（首次登录回读文档后回填到 owner_id 字段）。
 *   注意：_openid 本身由平台写入、客户端不可伪造；回填的 owner_id 只是它的别名，
 *   不要用它去覆盖或代替平台鉴权。
 */
const { getClient, getMode } = require('./client');
const { fetchAll } = require('./doc');
const store = require('./store');

const TABLE = 'profiles';

const LOCAL_OWNER_KEY = 'kxb:local_owner';

/**
 * 生成 6 位邀请码：大写字母 + 数字，去掉易混淆字符（0/O/1/I）
 */
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * 归一化档案记录，保证返回值一定带 owner_id。
 *
 * 背景（本项目的身份模型统一约定）：
 *   本地模式下 owner_id 是我们自己生成的模拟身份；
 *   云模式下身份由平台写入文档的 `_openid`，档案文档本身**不含** owner_id 字段。
 * 若直接把云端记录原样返回，`profile.owner_id` 会是 undefined，
 * 进而让 app.globalData.openid 变成空值，`找搭子` 的 bindFriend /
 * listCoursesByOwner 全部拿到空身份（历史上就是这里出的隐患）。
 *
 * 这里把三种来源收敛成唯一的 owner_id，取值优先级：
 *   1. 已有的 owner_id（本地模式 / 云模式下已回填过的文档）
 *   2. 平台写入的 _openid
 *   3. 兜底用文档 id（local 模式的 id / 云模式的 _id）
 *
 * @param {object|null} rec
 * @returns {object|null}
 */
function normalizeProfile(rec) {
  if (!rec) return null;
  const ownerId = rec.owner_id || rec._openid || rec.id || rec._id || null;
  return ownerId ? { ...rec, owner_id: ownerId } : rec;
}

/**
 * 回读云档案并把 owner_id 补齐（幂等）。
 *
 * 为什么需要回读：云数据库 `add()` 只返回 `_id`，`_openid` 是平台写入的、
 * 必须再取一次文档才能拿到。拿到后把它写进文档的 owner_id 字段，好处有二：
 *   1. 客户端拿到的档案始终带 owner_id → app.globalData.openid 不再为空；
 *   2. 「按 owner_id 查课程 / 绑定关系」的语义在云模式与本地模式保持一致。
 *
 * 回填失败（例如集合权限限制更新）不阻断登录，仅降级为用 _openid 临时充当身份。
 *
 * @param {object} db   云数据库实例
 * @param {object|string} docOrId 已有文档对象，或文档 _id
 * @returns {Promise<object>} 归一化后的档案
 */
async function backfillCloudOwner(db, docOrId) {
  const id = typeof docOrId === 'string' ? docOrId : docOrId._id;

  let doc = typeof docOrId === 'string' ? null : docOrId;
  if (!doc) {
    const res = await db.collection(TABLE).doc(id).get();
    doc = (res && res.data) || {};
  }

  const ownerId = doc.owner_id || doc._openid || doc.id || id;

  if (id && doc.owner_id !== ownerId) {
    try {
      await db.collection(TABLE).doc(id).update({ data: { owner_id: ownerId } });
    } catch (e) {
      console.warn('[profile] 回填 owner_id 失败（不影响登录）', e);
    }
  }

  return normalizeProfile({ ...doc, id, owner_id: ownerId });
}

/**
 * 云模式登录：优先走 auth 云函数（服务端以 OPENID 为身份锚点找/建档案）。
 *
 * 为什么优先走云函数（微信登录的正路）：
 *   1. 身份由平台保证 —— 服务端 getWXContext().OPENID，客户端无法伪造；
 *   2. 邀请码服务端查重，杜绝撞码（PRIVATE 权限下客户端查不了全表）；
 *   3. 档案由服务端一次性建好并带全 owner_id，不再需要回读回填补丁。
 *
 * 兜底：云函数未部署 / 调用失败时，回退到旧客户端链路（建档案 + 回读回填），
 * 保证登录永不因单个环节失败而完全不可用。
 */
async function ensureProfileCloud(db) {
  try {
    const res = await getClient().callFunction({
      name: 'auth',
      data: { action: 'login' }
    });
    const r = (res && res.result) || null;
    // 只有拿到平台真实身份 `_openid` 的档案才可信。
    // 旧版 auth 服务端建档没有写 `_openid`（历史坑），返回的 owner_id 会退化成
    // 档案文档 _id，与课程真实的 `_openid` 对不上 —— 找搭子必然读不到对方课程，
    // 且表现为「老用户正常、新用户不行」。遇到这种情况一律回退到客户端建档链路，
    // 由客户端建出带正确 `_openid` 的档案，从而自愈。
    if (r && r.ok && r.profile && r.profile._openid) {
      return normalizeProfile(r.profile);
    }
    console.warn('[profile] auth.login 未返回有效身份（缺少 _openid），回退客户端建档链路',
      r && (r.error || r.message || r.profile));
  } catch (e) {
    console.warn('[profile] auth 云函数不可用（可能未部署），回退客户端建档链路', e);
  }
  return null;
}

/**
 * 登录并确保档案存在
 * @returns {Promise<object|null>} 档案记录（一定带 owner_id）
 */
async function ensureProfile() {
  if (getMode() === 'cloud') {
    const db = getClient().database();

    // 0. 微信登录正路：服务端找/建档案
    const viaCloud = await ensureProfileCloud(db);
    if (viaCloud) return viaCloud;

    // 1. 查档案（行级安全策略保证只返回当前用户的记录）
    const found = await db.collection(TABLE).get();
    if (found.data && found.data.length > 0) {
      return await backfillCloudOwner(db, found.data[0]);
    }

    // 2. 不存在则创建（不指定 owner_id，平台会自动写入 _openid）
    const inviteCode = genInviteCode();
    const created = await db.collection(TABLE).add({
      data: {
        nickname: '',
        avatar_url: '',
        college: '',
        major: '',
        class_name: '',
        invite_code: inviteCode,
        free_note: '',
        wake_slot: 1,
        sleep_slot: 6,
        updated_at: Date.now()
      }
    });

    // 3. 回读文档拿到 _openid 并回填 owner_id，再返回
    return await backfillCloudOwner(db, created._id);
  }

  // 本地模式：用固定 owner 标识模拟登录态
  let ownerId = '';
  try {
    ownerId = wx.getStorageSync(LOCAL_OWNER_KEY) || '';
  } catch (e) {
    ownerId = '';
  }
  if (!ownerId) {
    ownerId = 'local-' + Math.random().toString(36).slice(2, 10);
    try {
      wx.setStorageSync(LOCAL_OWNER_KEY, ownerId);
    } catch (e) {
      /* ignore */
    }
  }

  const rows = await store.select(TABLE, { owner_id: ownerId });
  if (rows.length > 0) return normalizeProfile(rows[0]);

  return normalizeProfile(await store.insert(TABLE, {
    owner_id: ownerId,
    nickname: '我',
    avatar_url: '',
    college: '',
    major: '',
    class_name: '',
    invite_code: genInviteCode(),
    free_note: '',
    wake_slot: 1,
    sleep_slot: 6,
    updated_at: Date.now()
  }));
}

/**
 * 更新档案
 */
async function updateProfile(id, patch) {
  const payload = { ...patch, updated_at: Date.now() };
  if (getMode() === 'cloud') {
    const db = getClient().database();
    await db.collection(TABLE).doc(id).update({ data: payload });
    return { ...payload, id };
  }
  return store.update(TABLE, id, payload);
}

/**
 * 通过邀请码查找同学
 * @returns {Promise<object|null>} 档案记录（一定带 owner_id）
 */
async function findByInviteCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;

  if (getMode() === 'cloud') {
    // profiles 是「仅创建者可读写」(PRIVATE)，客户端直查只能读到自己的档案，
    // 按邀请码找不到同学 → 必须走云函数（服务端管理权限）跨用户查询。
    const res = await getClient().callFunction({
      name: 'findBuddy',
      data: { action: 'findProfile', inviteCode: normalized }
    });
    const r = (res && res.result) || null;
    if (!r || !r.ok) {
      throw new Error('查询同学失败：' + ((r && r.message) || (r && r.error) || '未知错误'));
    }
    return normalizeProfile(r.profile || null);
  }
  const rows = await store.select(TABLE, { invite_code: normalized });
  return normalizeProfile(rows[0] || null);
}

/**
 * 建立同学关系（单向绑定）
 * 单独建表，不要直接在 profiles 里塞数组。
 *
 * @param {string} myOwnerId 我的身份标识
 * @param {string} friendOwnerId 对方身份标识
 * @param {object} [friendMeta] 对方展示信息 { nickname, avatar_url }，存进关系表
 *        —— 找搭子页的多选列表直接用它显示昵称，避免为显示名字再查一轮档案
 *
 * 说明：owner_id 是「当前登录身份」的规范化别名（见 normalizeProfile），
 * 云模式下它等于平台写入的 _openid —— 显式写进关系表，是为了让
 * 「按 owner_id 查关系」在云 / 本地两种模式下语义一致、也便于排查。
 */
async function bindFriend(myOwnerId, friendOwnerId, friendMeta) {
  if (!myOwnerId || !friendOwnerId) {
    throw new Error('绑定失败：用户标识缺失');
  }
  if (myOwnerId === friendOwnerId) {
    throw new Error('不能绑定自己');
  }

  const TABLE_REL = 'relations';
  const meta = {
    friend_nickname: (friendMeta && friendMeta.nickname) || '',
    friend_avatar_url: (friendMeta && friendMeta.avatar_url) || '',
    // 分组：默认为空串（未分组）。未分组的同学会在下次登录时被清理（见 cleanupUngroupedFriends）
    group: (friendMeta && friendMeta.group) || ''
  };

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const exist = await db
      .collection(TABLE_REL)
      .where({ friend_owner_id: friendOwnerId })
      .get();
    if (exist.data && exist.data.length) {
      // 老关系缺昵称时补一次（幂等）
      const rel = exist.data[0];
      if (meta.friend_nickname && !rel.friend_nickname) {
        try {
          await db.collection(TABLE_REL).doc(rel._id).update({ data: meta });
        } catch (e) {
          console.warn('[profile] 补存好友昵称失败（不影响绑定）', e);
        }
      }
      return rel;
    }
    const res = await db.collection(TABLE_REL).add({
      data: Object.assign(
        { owner_id: myOwnerId, friend_owner_id: friendOwnerId, created_at: Date.now() },
        meta
      )
    });
    return Object.assign(
      { id: res._id, owner_id: myOwnerId, friend_owner_id: friendOwnerId },
      meta
    );
  }

  const rows = await store.select(TABLE_REL, { owner_id: myOwnerId, friend_owner_id: friendOwnerId });
  if (rows.length) return rows[0];
  return store.insert(TABLE_REL, Object.assign(
    { owner_id: myOwnerId, friend_owner_id: friendOwnerId, created_at: Date.now() },
    meta
  ));
}

/**
 * 列出已绑定的同学（本地模式 / 旧链路，只回关系表原始记录）
 */
async function listFriends(myOwnerId) {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    // 好友数超过 20 时，直接 get() 会静默只回前 20 条
    return await fetchAll(db.collection('relations'));
  }
  return store.select('relations', { owner_id: myOwnerId });
}

/**
 * 列出已绑定同学（带昵称/头像），供找搭子页多选列表。
 * 云模式走 findBuddy.listFriends（服务端补齐 PRIVATE 档案里的昵称），
 * 失败时回退到关系表里的 friend_nickname。
 */
async function listFriendProfiles(myOwnerId) {
  // 分组信息存在关系表里，而关系表是「仅创建者可读写」——客户端可直读自己的关系，
  // 因此先把它拿到，作为 group 的权威来源（不依赖云函数版本）。
  let rels = [];
  try {
    rels = (await listFriends(myOwnerId)) || [];
  } catch (e) {
    rels = [];
  }
  const relByOwner = {};
  rels.forEach((r) => {
    if (r && r.friend_owner_id) relByOwner[r.friend_owner_id] = r;
  });

  if (getMode() === 'cloud') {
    try {
      const res = await getClient().callFunction({
        name: 'findBuddy',
        data: { action: 'listFriends' }
      });
      const r = (res && res.result) || null;
      if (r && r.ok && Array.isArray(r.friends)) {
        // 昵称/头像由服务端补齐，分组以本地关系表为准（服务端 listFriends 也回传，
        // 但即便云函数是旧版没回传 group，这里也能兜住）
        return r.friends.map((f) => {
          const rel = relByOwner[f.owner_id] || {};
          return Object.assign({}, f, { group: rel.group || f.group || '' });
        });
      }
      console.warn('[profile] listFriends 未成功，回退关系表昵称', r && (r.error || r.message));
    } catch (e) {
      console.warn('[profile] listFriends 云函数不可用，回退关系表昵称', e);
    }
  }

  return rels
    .filter((r) => r && r.friend_owner_id)
    .map((r) => ({
      owner_id: r.friend_owner_id,
      nickname: r.friend_nickname || '',
      avatar_url: r.friend_avatar_url || '',
      group: r.group || ''
    }));
}

/**
 * 设置某位同学的分组。
 * 关系表是「仅创建者可读写」，客户端可直接查/改自己的关系，无需走云函数。
 * @param {string} friendOwnerId 对方身份
 * @param {string} group 分组名（空串 = 取消分组）
 * @returns {Promise<object|null>} 更新后的关系记录；不存在返回 null
 */
async function updateFriendGroup(friendOwnerId, group) {
  if (!friendOwnerId) throw new Error('缺少好友标识');
  const g = String(group || '').trim();
  const TABLE_REL = 'relations';

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const exist = await db.collection(TABLE_REL).where({ friend_owner_id: friendOwnerId }).get();
    if (!exist.data || !exist.data.length) return null;
    const rel = exist.data[0];
    await db.collection(TABLE_REL).doc(rel._id).update({ data: { group: g } });
    return Object.assign({}, rel, { id: rel._id, group: g });
  }

  const rows = await store.select(TABLE_REL, { friend_owner_id: friendOwnerId });
  if (!rows.length) return null;
  await store.update(TABLE_REL, rows[0].id, { group: g });
  return Object.assign({}, rows[0], { group: g });
}

/**
 * 删除某位同学（解除绑定关系）。
 * @param {string} friendOwnerId 对方身份
 * @returns {Promise<boolean>} 是否删除了至少一条
 */
async function removeFriend(friendOwnerId) {
  if (!friendOwnerId) throw new Error('缺少好友标识');
  const TABLE_REL = 'relations';

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const exist = await db.collection(TABLE_REL).where({ friend_owner_id: friendOwnerId }).get();
    const list = exist.data || [];
    for (const rel of list) {
      await db.collection(TABLE_REL).doc(rel._id).remove();
    }
    return list.length > 0;
  }

  const rows = await store.select(TABLE_REL, { friend_owner_id: friendOwnerId });
  for (const r of rows) await store.remove(TABLE_REL, r.id);
  return rows.length > 0;
}

/**
 * 清理「未分组」的同学（产品约定：未分组的同学下次登录时删除）。
 * 云端由 findBuddy 的 cleanupFriends 动作执行；本地模式无此语义，直接返回 0。
 * @returns {Promise<number>} 删除的关系条数
 */
async function cleanupUngroupedFriends() {
  if (getMode() !== 'cloud') return 0;
  try {
    const res = await getClient().callFunction({
      name: 'findBuddy',
      data: { action: 'cleanupFriends' }
    });
    const r = (res && res.result) || null;
    return (r && r.ok && r.removed) || 0;
  } catch (e) {
    console.warn('[profile] 清理未分组同学失败（不影响登录）', e);
    return 0;
  }
}

module.exports = {
  ensureProfile,
  updateProfile,
  findByInviteCode,
  bindFriend,
  listFriends,
  listFriendProfiles,
  updateFriendGroup,
  removeFriend,
  cleanupUngroupedFriends,
  genInviteCode,
  normalizeProfile
};
