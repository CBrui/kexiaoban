/**
 * 云函数 auth —— 微信登录（服务端身份锚点）
 *
 * 为什么需要它：
 *   原链路是「客户端 db.add() 建档案 → 再回读拿 _openid 回填 owner_id」，
 *   存在三个问题：
 *     1. 建档在客户端，极端情况下并发重复建档；
 *     2. 邀请码由客户端随机生成，PRIVATE 权限下客户端无法查重（可能撞码）；
 *     3. 必须靠 backfillCloudOwner 补丁回读补 owner_id。
 *   云函数运行在服务端，`cloud.getWXContext().OPENID` 就是微信登录后的唯一身份
 *   —— 这就是云开发下的「微信登录」正路：身份由平台保证，档案由服务端建档。
 *
 * 安全边界：
 *   1. 身份一律取 getWXContext().OPENID，绝不信任客户端传入的身份；
 *   2. 邀请码服务端生成 + 查重，杜绝撞码；
 *   3. 只回传档案自身字段，不透出其它用户数据。
 *
 * 动作（event.action）：
 *   - `login`：→ { ok, profile }   找不到档案则自动创建（幂等）
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PROFILES = 'profiles';

// 邀请码字符集：大写字母 + 数字，去掉易混淆字符（0/O/1/I）
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// 撞码重试次数（31^6 ≈ 8.9 亿种组合，通常第 1 次就成功）
const MAX_CODE_RETRY = 5;

const ok = (data) => Object.assign({ ok: true }, data);
const fail = (error, message) => ({ ok: false, error, message: message || '' });

function genInviteCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/**
 * 归一化档案：保证 owner_id / id 两个字段都在。
 * 与客户端 api/profile.js 的 normalizeProfile 保持同一口径。
 */
function normalize(doc) {
  if (!doc) return null;
  const owner = doc.owner_id || doc._openid || doc._id || null;
  return Object.assign({}, doc, {
    id: doc._id,
    owner_id: owner,
    // 清掉服务端内部字段，避免透出
    _id: undefined
  });
}

/**
 * 按 _openid 找档案；找不到则服务端建档（邀请码查重后写入）。
 */
async function login(openid) {
  // 1. 已有档案直接返回
  const found = await db.collection(PROFILES).where({ _openid: openid }).limit(1).get();
  if (found.data && found.data.length) {
    return ok({ profile: normalize(found.data[0]) });
  }

  // 2. 新用户：生成唯一邀请码后建档（_openid 由平台自动写入）
  let lastErr = null;
  for (let i = 0; i < MAX_CODE_RETRY; i++) {
    const invite_code = genInviteCode();
    try {
      // 查重：PRIVATE 权限只挡客户端，云函数具备管理端权限，可以全表查
      const dup = await db.collection(PROFILES).where({ invite_code }).limit(1).get();
      if (dup.data && dup.data.length) continue;

      const created = await db.collection(PROFILES).add({
        data: {
          nickname: '',
          avatar_url: '',
          college: '',
          major: '',
          class_name: '',
          invite_code,
          free_note: '',
          wake_slot: 1,
          sleep_slot: 6,
          created_via: 'auth.login',
          updated_at: Date.now()
        }
      });

      // 回读，拿到平台写入的 _openid
      const doc = await db.collection(PROFILES).doc(created._id).get();
      return ok({ profile: normalize(doc.data) });
    } catch (e) {
      lastErr = e;
      console.warn('[auth] 建档第 ' + (i + 1) + ' 次失败，重试', e);
    }
  }
  return fail('CREATE_PROFILE_FAILED', '创建用户档案失败：' + String((lastErr && lastErr.message) || lastErr));
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '未取得微信登录身份');

  const action = event && event.action;
  try {
    if (action === 'login') return await login(OPENID);
    return fail('UNKNOWN_ACTION', '未知动作：' + action);
  } catch (e) {
    console.error('[auth] 执行失败', action, e);
    return fail('INTERNAL', String((e && e.message) || e));
  }
};
