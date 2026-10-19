/**
 * logic/holiday.js —— 节假日 / 调休数据（内置默认表 + 云端下发）
 *
 * 设计目标：离线可用，联网自动更新。
 *   1. 内置一份权威默认表（BUILTIN_RECORDS），保证首次启动、断网、云函数未部署时也能判定
 *   2. 云端 holidays 集合可下发增量/覆盖，用于内置表过期后的更新（如 2027 年安排公布后）
 *   3. 结果缓存到 storage，启动时先用缓存渲染，再异步刷新，失败静默降级
 *
 * 数据来源与口径：
 *   内置表取自《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7号，
 *   2025-11-04 发布）。type 只有两种：
 *     - holiday 法定节假日放假日期 → 静默（dnd-rule 第 1 优先级）
 *     - makeup  调休上班/补课日     → 正常提醒（dnd-rule 第 5 优先级）
 *
 * ⚠️ 大学场景的口径提醒：国务院通知里的「X 月 X 日上班」面向机关企事业单位，
 *   高校不一定照此补课。这里的 makeup 仅用于「该日按工作日处理」，
 *   学校若另有安排，应由云端下发覆盖，或用户用「自定义不提醒日期」处理。
 *
 * 云端下发优先级：同一 date 上，云端记录覆盖内置记录。
 *   这样学校校历的自定义补课日、以及内置表过期后的新数据都能生效。
 */

const { weekToDate, formatDate } = require('../utils/week');

const CACHE_KEY = 'holiday_cache';
/** 云端数据的缓存有效期：6 小时。过期后会尝试刷新，失败也不影响使用 */
const CACHE_TTL = 6 * 60 * 60 * 1000;

/**
 * 内置默认表：2026 年法定节假日（国务院办公厅 2025-11-04 公布）
 *
 * 元旦 1/1-1/3（1/4 上班）
 * 春节 2/15-2/23（2/14、2/28 上班）
 * 清明 4/4-4/6（无调休）
 * 劳动节 5/1-5/5（5/9 上班）
 * 端午 6/19-6/21（无调休）
 * 中秋 9/25-9/27（无调休）
 * 国庆 10/1-10/7（9/20、10/10 上班）
 */
const BUILTIN_RECORDS = [
  // —— 元旦 ——
  { date: '2026-01-01', type: 'holiday', name: '元旦' },
  { date: '2026-01-02', type: 'holiday', name: '元旦' },
  { date: '2026-01-03', type: 'holiday', name: '元旦' },
  { date: '2026-01-04', type: 'makeup', name: '元旦调休上班' },

  // —— 春节 ——
  { date: '2026-02-14', type: 'makeup', name: '春节调休上班' },
  { date: '2026-02-15', type: 'holiday', name: '春节' },
  { date: '2026-02-16', type: 'holiday', name: '春节' },
  { date: '2026-02-17', type: 'holiday', name: '春节' },
  { date: '2026-02-18', type: 'holiday', name: '春节' },
  { date: '2026-02-19', type: 'holiday', name: '春节' },
  { date: '2026-02-20', type: 'holiday', name: '春节' },
  { date: '2026-02-21', type: 'holiday', name: '春节' },
  { date: '2026-02-22', type: 'holiday', name: '春节' },
  { date: '2026-02-23', type: 'holiday', name: '春节' },
  { date: '2026-02-28', type: 'makeup', name: '春节调休上班' },

  // —— 清明 ——
  { date: '2026-04-04', type: 'holiday', name: '清明节' },
  { date: '2026-04-05', type: 'holiday', name: '清明节' },
  { date: '2026-04-06', type: 'holiday', name: '清明节' },

  // —— 劳动节 ——
  { date: '2026-05-01', type: 'holiday', name: '劳动节' },
  { date: '2026-05-02', type: 'holiday', name: '劳动节' },
  { date: '2026-05-03', type: 'holiday', name: '劳动节' },
  { date: '2026-05-04', type: 'holiday', name: '劳动节' },
  { date: '2026-05-05', type: 'holiday', name: '劳动节' },
  { date: '2026-05-09', type: 'makeup', name: '劳动节调休上班' },

  // —— 端午 ——
  { date: '2026-06-19', type: 'holiday', name: '端午节' },
  { date: '2026-06-20', type: 'holiday', name: '端午节' },
  { date: '2026-06-21', type: 'holiday', name: '端午节' },

  // —— 中秋 ——
  { date: '2026-09-25', type: 'holiday', name: '中秋节' },
  { date: '2026-09-26', type: 'holiday', name: '中秋节' },
  { date: '2026-09-27', type: 'holiday', name: '中秋节' },

  // —— 国庆 ——
  { date: '2026-09-20', type: 'makeup', name: '国庆调休上班' },
  { date: '2026-10-01', type: 'holiday', name: '国庆节' },
  { date: '2026-10-02', type: 'holiday', name: '国庆节' },
  { date: '2026-10-03', type: 'holiday', name: '国庆节' },
  { date: '2026-10-04', type: 'holiday', name: '国庆节' },
  { date: '2026-10-05', type: 'holiday', name: '国庆节' },
  { date: '2026-10-06', type: 'holiday', name: '国庆节' },
  { date: '2026-10-07', type: 'holiday', name: '国庆节' },
  { date: '2026-10-10', type: 'makeup', name: '国庆调休上班' },

  // 2027 年只放元旦：1 月 1 日放假是《全国年节及纪念日放假办法》明文规定的法定节日，
  // 不依赖每年的调休通知，所以可以提前收录。其余 2027 年假期要等国办通知
  // （通常前一年 11 月发布）出来后由云端下发，不在这里猜测。
  { date: '2027-01-01', type: 'holiday', name: '元旦' }
];

/** 内置表的版本标识：内置数据每次修订都要 +1，便于云端判断客户端是否过期 */
const BUILTIN_VERSION = '2026.1';

/**
 * 规范化一条记录：过滤脏数据，补默认值
 * @returns {?{date:string, type:string, name:string}}
 */
function normalize(rec) {
  if (!rec || typeof rec.date !== 'string') return null;
  // 只接受 YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) return null;
  const type = rec.type === 'makeup' ? 'makeup' : 'holiday';
  return { date: rec.date, type, name: rec.name || (type === 'makeup' ? '调休' : '节假日') };
}

/**
 * 合并两组记录：后出现的（patch）覆盖先出现的（base）同 date 记录
 * @param {Array} base
 * @param {Array} patch
 * @returns {Array} 按日期升序
 */
function mergeRecords(base, patch) {
  const map = {};
  (base || []).forEach((r) => {
    const n = normalize(r);
    if (n) map[n.date] = n;
  });
  (patch || []).forEach((r) => {
    const n = normalize(r);
    if (n) map[n.date] = n;
  });
  return Object.keys(map).sort().map((d) => map[d]);
}

/**
 * 从云端拉取节假日记录
 *
 * 走云函数而不是客户端直查：holidays 集合若沿用默认的「仅创建者可读写」权限，
 * 客户端直查会**静默返回空**（不报错），很容易被误判成「没有数据」。
 * 云函数用 admin 权限读，不受集合权限限制。
 *
 * @returns {Promise<{ok:boolean, records:Array, version:string, error:string}>}
 */
function fetchCloud() {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      resolve({ ok: false, records: [], version: '', error: '云环境不可用' });
      return;
    }
    wx.cloud.callFunction({
      name: 'holidaySync',
      data: { action: 'getHolidays', builtinVersion: BUILTIN_VERSION },
      success(res) {
        const r = (res && res.result) || {};
        if (r.ok === false) {
          resolve({ ok: false, records: [], version: '', error: r.error || '云函数返回失败' });
          return;
        }
        const list = Array.isArray(r.records) ? r.records : [];
        resolve({ ok: true, records: list, version: r.version || '', error: '' });
      },
      fail(err) {
        resolve({
          ok: false,
          records: [],
          version: '',
          error: (err && err.errMsg) || '调用云函数失败'
        });
      }
    });
  });
}

/**
 * 读取缓存
 * @returns {?{records:Array, version:string, source:string, updatedAt:number}}
 */
function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (!raw) return null;
    const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!c || !Array.isArray(c.records)) return null;
    return c;
  } catch (e) {
    return null;
  }
}

function writeCache(obj) {
  try {
    wx.setStorageSync(CACHE_KEY, obj);
  } catch (e) {
    /* 存储失败不影响使用，下一次启动会重新拉 */
  }
}

/**
 * 加载日历数据（同步返回可用数据 + 可选异步刷新）
 *
 * 用法：
 *   const cal = holiday.loadCalendar();          // 立即返回（缓存 / 内置）
 *   holiday.refresh().then(cal => ...);          // 联网刷新，失败静默降级
 *
 * @returns {{records:Array, source:string, version:string, updatedAt:number}}
 *   source: 'cache' | 'builtin'
 */
function loadCalendar() {
  const cache = readCache();
  if (cache && Array.isArray(cache.records) && cache.records.length) {
    return {
      records: cache.records,
      source: 'cache',
      version: cache.version || '',
      updatedAt: cache.updatedAt || 0
    };
  }
  return {
    records: mergeRecords(BUILTIN_RECORDS, []),
    source: 'builtin',
    version: BUILTIN_VERSION,
    updatedAt: 0
  };
}

/**
 * 判断缓存是否过期（过期才值得联网刷一次）
 */
function isStale(cache) {
  if (!cache || !cache.updatedAt) return true;
  return Date.now() - cache.updatedAt > CACHE_TTL;
}

/**
 * 联网刷新：拉云端 → 与内置合并 → 写缓存
 * 任何一步失败都静默降级到「内置表 + 已有缓存」，绝不抛错打断页面。
 *
 * @param {boolean} [force=false] 忽略缓存有效期，强制拉一次（手动刷新按钮用）
 * @returns {Promise<{records:Array, source:string, version:string, updatedAt:number, error:string}>}
 */
async function refresh(force) {
  const cache = readCache();
  if (!force && !isStale(cache)) {
    return {
      records: cache.records,
      source: 'cache',
      version: cache.version || '',
      updatedAt: cache.updatedAt || 0,
      error: ''
    };
  }

  const cloud = await fetchCloud();
  if (!cloud.ok) {
    // 云端不可用：有缓存用缓存，没缓存用内置
    const fallback = loadCalendar();
    return Object.assign({}, fallback, { error: cloud.error });
  }

  // 云端覆盖内置：同一日期以云端为准
  const merged = mergeRecords(BUILTIN_RECORDS, cloud.records);
  const payload = {
    records: merged,
    source: 'cloud',
    version: cloud.version || BUILTIN_VERSION,
    updatedAt: Date.now(),
    error: ''
  };
  writeCache(payload);
  return payload;
}

/**
 * 把记录整理成 dnd-rule 需要的索引（{ 'YYYY-MM-DD': 'holiday' | 'makeup' }）
 * @param {Array} records
 */
function toIndex(records) {
  const index = {};
  (records || []).forEach((r) => {
    const n = normalize(r);
    if (n) index[n.date] = n.type;
  });
  return index;
}

/**
 * 带名称的索引（{ 'YYYY-MM-DD': {type, name} }）
 *
 * 课表页要在日期表头上标出「这天是国庆」，光有 type 不够，所以另给一份带名字的。
 * toIndex 保持原样不动 —— 它是 dnd-rule / calendar-sync 的数据契约，不能改结构。
 *
 * @param {Array} records
 */
function toDetailMap(records) {
  const map = {};
  (records || []).forEach((r) => {
    const n = normalize(r);
    if (n) map[n.date] = { type: n.type, name: n.name || '' };
  });
  return map;
}

/**
 * 某一周 7 天各自的节假日类型（供课表页把假期列标灰）
 *
 * @param {object} index  toIndex / toDetailMap 产出的索引
 * @param {string} termStartMonday  第 1 周周一 'YYYY-MM-DD'
 * @param {number} week   周次
 * @returns {Array<string>} 下标 0 = 周一，值为 '' | 'holiday' | 'makeup'
 */
function dayTypesOf(index, termStartMonday, week) {
  const out = [];
  const idx = index || {};
  for (let d = 1; d <= 7; d++) {
    // ⚠️ weekToDate 返回的是 **Date 对象**，查字符串索引前必须 formatDate
    const key = formatDate(weekToDate(termStartMonday, week, d));
    const hit = idx[key];
    const type = typeof hit === 'string' ? hit : (hit && hit.type);
    out.push(type === 'holiday' || type === 'makeup' ? type : '');
  }
  return out;
}

/**
 * 日期表头上的小标记文字
 * 放假优先显示假期名（「国庆」比「休」好认）；调休上班日标「班」
 *
 * @returns {string} '' 表示普通日
 */
function dayMarkText(index, dateStr) {
  const idx = index || {};
  const hit = idx[dateStr];
  if (!hit) return '';
  const type = typeof hit === 'string' ? hit : hit.type;
  const name = typeof hit === 'string' ? '' : (hit.name || '');
  if (type === 'holiday') return name || '休';
  if (type === 'makeup') return '班';
  return '';
}

/**
 * 把零散的日期合并成「假期段」，便于界面展示「国庆 10/1-10/7」
 * 只合并同 name 且日期连续的 holiday；makeup 不合并（它们本身是散点）
 *
 * @param {Array} records
 * @param {string} [fromDate] 只看该日期之后的段（含当天）
 * @returns {Array<{name:string, start:string, end:string, days:number}>}
 */
function groupHolidays(records, fromDate) {
  const list = (records || [])
    .map(normalize)
    .filter((r) => r && r.type === 'holiday')
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const groups = [];
  list.forEach((r) => {
    const last = groups[groups.length - 1];
    const prevDay = last ? nextDate(last.end) : null;
    if (last && last.name === r.name && prevDay === r.date) {
      last.end = r.date;
      last.days += 1;
    } else {
      groups.push({ name: r.name, start: r.date, end: r.date, days: 1 });
    }
  });

  if (!fromDate) return groups;
  return groups.filter((g) => g.end >= fromDate);
}

/**
 * 日期加一天（本地时区，够用：只用于判断「是否连续」）
 * @param {string} date "YYYY-MM-DD"
 */
function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d + 1);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/**
 * 即将到来的假期（含今天），最多 limit 条
 * @param {Array} records
 * @param {string} [fromDate='今天']
 * @param {number} [limit=3]
 */
function upcoming(records, fromDate, limit) {
  const from = fromDate || todayString();
  return groupHolidays(records, from).slice(0, limit || 3);
}

function todayString() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/**
 * 人类可读的来源说明（界面展示用）
 */
function sourceText(source, error) {
  if (error) return '云端不可用，已用内置表';
  if (source === 'cloud') return '云端已更新';
  if (source === 'cache') return '本地缓存';
  return '内置默认表';
}

module.exports = {
  BUILTIN_RECORDS,
  BUILTIN_VERSION,
  CACHE_KEY,
  normalize,
  mergeRecords,
  toIndex,
  toDetailMap,
  dayTypesOf,
  dayMarkText,
  groupHolidays,
  upcoming,
  nextDate,
  todayString,
  sourceText,
  loadCalendar,
  refresh,
  fetchCloud,
  isStale
};
