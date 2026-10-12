/**
 * 云函数 calendarFeed —— 课表订阅日历（.ics 源）
 *
 * 两种调用方式，走同一个入口：
 *
 *   1. wx.cloud.callFunction（小程序内，可信身份来自 getWXContext().OPENID）
 *      - action `ensure`     取订阅链接；没有 token 就生成一个存进 profile
 *      - action `reset`      重新生成 token —— 旧链接同时作废
 *      - action `syncConfig` 把提醒配置（静音课程 / 提前分钟 / 作息）推到云端
 *      → 返回 { ok, token, url, ... }
 *
 *   2. HTTP 访问服务（手机日历 App 定期来拉，无人值守）
 *      GET /calendar?token=xxx → text/calendar 的 .ics 文本
 *      这条链路**没有小程序登录态**，只能靠 token 认人，所以 token 必须够随机，
 *      且提供「重新生成」作废旧链接。
 *
 * 为什么这么绕：见 lib/ics.js 的注释。`wx.addPhoneRepeatCalendar` 在安卓上
 * 一次并发十几条只进 1~2 条，且微信没有删除日历事件的接口。订阅日历把方向
 * 反过来（日历主动拉），整学期一次到位，改课刷新即生效。
 *
 * ⚠️ 安全边界：
 *   1. HTTP 侧只认 token，绝不信任请求里带的任何身份字段；
 *   2. token 只存在 profile 里，不随课表等数据外泄；
 *   3. HTTP 侧用云函数的 admin 权限读数据（PRIVATE 集合客户端读不到别人数据，
 *      云函数能读，所以这里必须先凭 token 定位到具体用户再查，绝不能全表扫）。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const PROFILES = 'profiles';
const TIMETABLES = 'timetables';
const COURSES = 'courses';

/**
 * HTTP 访问服务的域名前缀
 *
 * 开通「HTTP 访问服务」后，在云开发控制台 → HTTP 网关 / 云函数详情 → 自定义域名
 * 里能看到实际域名，形如
 *   https://xxxx.service.tcloudbase.com
 *   https://xxxx.ap-shanghai.app.tcloudbase.com
 *
 * 本项目已开通，域名写在下面的 DEFAULT_FEED_BASE 里作为兜底：
 * 环境变量 CALENDAR_FEED_BASE 优先（换域名 / 换环境时不用改代码重新部署）。
 *
 * ⚠️ 换环境或换域名时必须改这里（或配环境变量），否则小程序端拿到的
 *    订阅链接指向旧域名，用户复制过去拉不到日历。
 */
const DEFAULT_FEED_BASE =
  'https://kexiaoban-d6gwihpzhf7c3752e-1502280527.ap-shanghai.app.tcloudbase.com';

const FEED_BASE = process.env.CALENDAR_FEED_BASE || DEFAULT_FEED_BASE;

/** HTTP 触发路径（与控制台配置的触发路径保持一致） */
const FEED_PATH = process.env.CALENDAR_FEED_PATH || '/calendar';

/** 单次 get 上限：云函数端 100 条，超出静默截断，必须分页拉全量 */
const PAGE_SIZE = 100;

/**
 * lib 改成**延迟加载**：云函数若加载阶段就崩（子目录没进产物 / 依赖缺失），
 * 平台只会笼统报 `functions execute fail`，看不出真正原因。放进 main 里 try/catch
 * 才能把 MODULE_NOT_FOUND 这类信息带回来。
 */
let libCache = null;
function loadLib() {
  if (libCache) return libCache;
  libCache = {
    ics: require('./ics'),
    schedule: require('./schedule')
  };
  return libCache;
}

const ok = (data) => Object.assign({ ok: true }, data);
const fail = (error, message) => ({ ok: false, error, message: message || '' });

/** 生成订阅 token：32 位小写十六进制，够随机也够好复制 */
function genToken() {
  let s = '';
  const chars = 'abcdef0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

/** 分页拉全量：云函数端单次 get() 上限 100 条，超出会被静默截断 */
async function fetchAll(query) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < 50; i++) {
    const res = await query.skip(skip).limit(PAGE_SIZE).get();
    const rows = (res && res.data) || [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    skip += rows.length;
  }
  return out;
}

function feedUrl(token) {
  if (!FEED_BASE) return '';
  const base = String(FEED_BASE).replace(/\/+$/, '');
  return `${base}${FEED_PATH}?token=${token}`;
}

/* ===================== 小程序侧（凭 OPENID） ===================== */

async function ensure(openid, event) {
  const reset = event && event.reset === true;
  const col = db.collection(PROFILES);
  const found = await col.where({ _openid: openid }).limit(1).get();
  let profile = (found && found.data && found.data[0]) || null;

  if (!profile) {
    return fail('NO_PROFILE', '还没有用户档案，请先在「我的」里登录');
  }

  let token = profile.calendar_token;
  if (reset || !token) {
    token = genToken();
    await col.doc(profile._id).update({
      data: { calendar_token: token, calendar_token_updated_at: Date.now() }
    });
  }

  return ok({
    token,
    url: feedUrl(token),
    feedBaseReady: !!FEED_BASE,
    reset: !!reset
  });
}

/** 把提醒配置推到云端：静音课程、提前分钟、自定义作息 */
async function syncConfig(openid, event) {
  const col = db.collection(PROFILES);
  const found = await col.where({ _openid: openid }).limit(1).get();
  const profile = (found && found.data && found.data[0]) || null;
  if (!profile) return fail('NO_PROFILE', '还没有用户档案，请先在「我的」里登录');

  const prev = profile.calendar_feed || {};
  const next = Object.assign({}, prev, {
    silentCourses: Array.isArray(event.silentCourses) ? event.silentCourses : prev.silentCourses || [],
    leadMinutes: Number.isFinite(Number(event.leadMinutes)) ? Number(event.leadMinutes) : prev.leadMinutes || 15,
    schedule: event.schedule && event.schedule.segments ? event.schedule : prev.schedule || null,
    updated_at: Date.now()
  });

  await col.doc(profile._id).update({ data: { calendar_feed: next } });
  return ok({ synced: true });
}

/* ===================== HTTP 侧（凭 token） ===================== */

function parseQueryString(raw) {
  const out = {};
  String(raw || '')
    .split('&')
    .forEach((pair) => {
      if (!pair) return;
      const idx = pair.indexOf('=');
      const k = idx === -1 ? pair : pair.slice(0, idx);
      const v = idx === -1 ? '' : pair.slice(idx + 1);
      try {
        out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch (e) {
        out[k] = v;
      }
    });
  return out;
}

function pickQuery(event) {
  const q = event.queryStringParameters;
  if (!q) return {};
  if (typeof q === 'object') return q;
  // 部分网关把查询参数整串塞成字符串（可能是 JSON，也可能是 a=1&b=2）
  try {
    return JSON.parse(q);
  } catch (e) {
    return parseQueryString(q);
  }
}

function pickToken(event) {
  const q = pickQuery(event);
  if (q && q.token) return String(q.token);

  if (event.body) {
    try {
      const b = JSON.parse(event.body);
      if (b && b.token) return String(b.token);
    } catch (e) {
      const m = String(event.body).match(/token=([\w-]+)/);
      if (m) return m[1];
    }
  }
  return '';
}

/** 按 token 找档案 → 读当前课表 → 读课程 → 生成 ICS */
async function handleHttp(event) {
  const token = pickToken(event);
  if (!token) return textResponse(400, '缺少 token 参数');

  const found = await db.collection(PROFILES).where({ calendar_token: token }).limit(1).get();
  const profile = (found && found.data && found.data[0]) || null;
  if (!profile) return textResponse(404, '订阅链接已失效，请在小程序里重新生成');

  const openid = profile.owner_id || profile._openid;
  if (!openid) return textResponse(404, '档案缺少身份信息');

  // 当前课表：优先 is_current，退化到第一张
  const tts = await db.collection(TIMETABLES).where({ _openid: openid }).get();
  const list = (tts && tts.data) || [];
  const current =
    list.find((t) => t.is_current === true || t.is_current === 'true') || list[0] || null;
  if (!current) return textResponse(404, '还没有课表');

  const courses = await fetchAll(
    db.collection(COURSES).where({ timetable_id: String(current.id || current._id) })
  );

  const feed = profile.calendar_feed || {};
  const { buildIcs } = loadLib().ics;
  const { DEFAULT_SCHEDULE } = loadLib().schedule;
  const result = buildIcs({
    courses: courses || [],
    termStartMonday: current.term_start_monday,
    leadMinutes: Number.isFinite(Number(feed.leadMinutes)) ? Number(feed.leadMinutes) : 15,
    silentCourses: Array.isArray(feed.silentCourses) ? feed.silentCourses : [],
    schedule: feed.schedule || DEFAULT_SCHEDULE,
    calendarName: current.name ? `${current.name} · 课小伴` : '课小伴课表'
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="kexiaoban.ics"',
      'Cache-Control': 'no-cache'
    },
    body: result.ics
  };
}

function textResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: message
  };
}

/* ===================== 入口 ===================== */

function isHttpEvent(event) {
  return !!(event && (event.httpMethod || event.headers || event.queryStringParameters));
}

exports.main = async (event, context) => {
  const e = event || {};

  try {
    loadLib();
  } catch (err) {
    console.error('[calendarFeed] 加载 lib 失败', err);
    return textResponse(500, '云函数依赖加载失败：' + ((err && err.message) || err));
  }

  if (isHttpEvent(e)) {
    try {
      return await handleHttp(e);
    } catch (err) {
      console.error('[calendarFeed] HTTP 生成失败', err);
      return textResponse(500, '生成日历失败：' + ((err && err.message) || err));
    }
  }

  // 小程序调用：身份只认平台给的 OPENID
  const wxCtx = (cloud.getWXContext && cloud.getWXContext()) || {};
  const openid = wxCtx.OPENID || (context && context.OPENID);
  if (!openid) return fail('NO_AUTH', '取不到登录身份，请先在「我的」里登录');

  try {
    if (e.action === 'syncConfig') return await syncConfig(openid, e);
    return await ensure(openid, e);
  } catch (err) {
    console.error('[calendarFeed] 处理失败', err);
    return fail('INTERNAL', (err && err.message) || String(err));
  }
};
