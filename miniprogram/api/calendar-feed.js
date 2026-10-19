/**
 * api/calendar-feed.js —— 课表订阅日历（.ics 源）的小程序侧入口
 *
 * 三个动作都走云函数 calendarFeed（服务端凭 OPENID 认人）：
 *   - ensureFeed()      拿订阅链接；服务端没有 token 就生成一个存进 profile
 *   - resetFeed()       重新生成 token —— 旧链接立刻作废
 *   - syncFeedConfig()  把提醒配置（静音课程 / 提前分钟 / 作息）推到云端
 *
 * 为什么配置也要推云端：手机日历来拉 .ics 时**没有小程序登录态**，
 * 云函数只能凭 token 认人，读不到本机的 storage。静音课程、提前提醒分钟数、
 * 自定义作息这些存在本地的配置，必须同步一份到云端，订阅出来的日历才对得上。
 *
 * ⚠️ 本模块依赖云环境，USE_CLOUD=false 时一律返回 notReady ——
 *    订阅日历是纯云端能力，没有云环境就没有链接可言。
 */
const { getClient, getMode } = require('./client');

const FN = 'calendarFeed';

async function call(action, data) {
  if (getMode() !== 'cloud') {
    return { ok: false, error: 'NO_CLOUD', message: '未启用云环境，订阅日历不可用' };
  }
  const res = await getClient().callFunction({
    name: FN,
    data: Object.assign({ action: action }, data || {})
  });
  const r = (res && res.result) || null;
  if (!r || !r.ok) {
    const err = new Error((r && r.message) || (r && r.error) || '订阅日历服务未就绪');
    err.code = (r && r.error) || 'FEED_FAIL';
    throw err;
  }
  return r;
}

/**
 * 取订阅链接（没有就由服务端生成）
 * @param {boolean} [reset] 传 true 表示强制重新生成，旧链接作废
 * @returns {Promise<{ok:boolean, url:string, token:string, feedBaseReady:boolean}>}
 *          feedBaseReady=false 表示云函数还没配 HTTP 域名，url 会是空串
 */
async function ensureFeed(reset) {
  return call(reset ? 'reset' : 'ensure', { reset: reset === true });
}

/** 重新生成订阅链接（作废旧链接） */
async function resetFeed() {
  return ensureFeed(true);
}

/**
 * 把提醒配置推到云端
 * @param {{silentCourses: string[], leadMinutes: number, schedule: object}} cfg
 */
async function syncFeedConfig(cfg) {
  const c = cfg || {};
  return call('syncConfig', {
    silentCourses: c.silentCourses || [],
    leadMinutes: Number(c.leadMinutes) || 15,
    schedule: c.schedule || null
  });
}

module.exports = { ensureFeed, resetFeed, syncFeedConfig };
