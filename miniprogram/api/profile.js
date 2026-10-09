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
 * 登录并确保档案存在
 * @returns {Promise<object|null>} 档案记录（一定带 owner_id）
 */
async function ensureProfile() {
  if (getMode() === 'cloud') {
    const db = getClient().database();

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
        college: '',
        major: '',
        class_name: '',
        invite_code: inviteCode,
        free_note: '',
        wake_slot: 1,
        sleep_slot: 12,
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
    college: '',
    major: '',
    class_name: '',
    invite_code: genInviteCode(),
    free_note: '',
    wake_slot: 1,
    sleep_slot: 12,
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
    const db = getClient().database();
    const res = await db.collection(TABLE).where({ invite_code: normalized }).get();
    return normalizeProfile((res.data && res.data[0]) || null);
  }
  const rows = await store.select(TABLE, { invite_code: normalized });
  return normalizeProfile(rows[0] || null);
}

/**
 * 建立同学关系（单向绑定）
 * 单独建表，不要直接在 profiles 里塞数组。
 *
 * 说明：owner_id 是「当前登录身份」的规范化别名（见 normalizeProfile），
 * 云模式下它等于平台写入的 _openid —— 显式写进关系表，是为了让
 * 「按 owner_id 查关系」在云 / 本地两种模式下语义一致、也便于排查。
 */
async function bindFriend(myOwnerId, friendOwnerId) {
  if (!myOwnerId || !friendOwnerId) {
    throw new Error('绑定失败：用户标识缺失');
  }
  if (myOwnerId === friendOwnerId) {
    throw new Error('不能绑定自己');
  }

  const TABLE_REL = 'relations';

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const exist = await db
      .collection(TABLE_REL)
      .where({ friend_owner_id: friendOwnerId })
      .get();
    if (exist.data && exist.data.length) return exist.data[0];
    const res = await db.collection(TABLE_REL).add({
      data: { owner_id: myOwnerId, friend_owner_id: friendOwnerId, created_at: Date.now() }
    });
    return { id: res._id, owner_id: myOwnerId, friend_owner_id: friendOwnerId };
  }

  const rows = await store.select(TABLE_REL, { owner_id: myOwnerId, friend_owner_id: friendOwnerId });
  if (rows.length) return rows[0];
  return store.insert(TABLE_REL, {
    owner_id: myOwnerId,
    friend_owner_id: friendOwnerId,
    created_at: Date.now()
  });
}

/**
 * 列出已绑定的同学
 */
async function listFriends(myOwnerId) {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection('relations').get();
    return res.data || [];
  }
  return store.select('relations', { owner_id: myOwnerId });
}

module.exports = {
  ensureProfile,
  updateProfile,
  findByInviteCode,
  bindFriend,
  listFriends,
  genInviteCode,
  normalizeProfile
};
