/**
 * api/profile.js —— 用户档案 CRUD
 *
 * 登录链路：微信登录 → 换取用户会话 → 首次登录自动创建档案并生成邀请码。
 * 数据隔离铁律：owner_id 由系统按登录身份自动写入，客户端不得自行指定。
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
 * 登录并确保档案存在
 * @returns {Promise<object|null>} 档案记录
 */
async function ensureProfile() {
  if (getMode() === 'cloud') {
    const db = getClient().database();

    // 1. 查档案（行级安全策略保证只返回当前用户的记录）
    const found = await db.collection(TABLE).get();
    if (found.data && found.data.length > 0) {
      return found.data[0];
    }

    // 2. 不存在则创建（不指定 owner_id）
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
    return { id: created._id, invite_code: inviteCode };
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
  if (rows.length > 0) return rows[0];

  return store.insert(TABLE, {
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
  });
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
 * @returns {Promise<object|null>}
 */
async function findByInviteCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).where({ invite_code: normalized }).get();
    return (res.data && res.data[0]) || null;
  }
  const rows = await store.select(TABLE, { invite_code: normalized });
  return rows[0] || null;
}

/**
 * 建立同学关系（单向绑定）
 * 单独建表，不要直接在 profiles 里塞数组。
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
      data: { friend_owner_id: friendOwnerId, created_at: Date.now() }
    });
    return { id: res._id, friend_owner_id: friendOwnerId };
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
  genInviteCode
};
