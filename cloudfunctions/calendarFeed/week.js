/**
 * lib/week.js —— 周次解析与「周次 → 日期」换算（云函数内复刻版）
 *
 * ⚠️ 与 miniprogram/utils/week.js 同源。
 *    云函数运行在服务端，无法 require 小程序目录里的模块，只能复刻一份。
 *    改 miniprogram/utils/week.js 的 parseWeeks 时，这里必须同步 ——
 *    test/run.js 里有对比用例盯着两边行为一致，漂移会被测试抓出来。
 *
 *    与小程序版唯一的差异是 weekToDateStr 返回 'YYYY-MM-DD' 字符串而非 Date：
 *    云函数环境的时区不保证是东八区，用 Date 做日期运算会踩时区坑，
 *    这里全程走 Date.UTC 手工计算，结果与运行环境 TZ 无关。
 */
const MAX_WEEK = 30;

const pad = (n) => String(n).padStart(2, '0');

/**
 * 解析周次规则文本 → 周次数组（升序）
 *
 * 支持的写法（与小程序版一致）：
 *   "1-16"、"1-16 单"、"1-16 双"、"3,5,7"、"1-8,10-16"、"1-16单,17-18"、第1-16周
 */
function parseWeeks(text) {
  if (!text || typeof text !== 'string') return [];

  const isOdd = /单/.test(text);
  const isEven = /双/.test(text);

  const body = text
    .replace(/(单|双)周?/g, '')
    .replace(/周/g, '')
    .replace(/第/g, '')
    .trim();

  // 只写了「单周」/「双周」而没有区间：按整学期展开，再由学期总周数裁剪
  if (!body) {
    if (!isOdd && !isEven) return [];
    const all = [];
    for (let i = 1; i <= MAX_WEEK; i++) all.push(i);
    return isOdd ? all.filter((w) => w % 2 === 1) : all.filter((w) => w % 2 === 0);
  }

  const result = new Set();

  for (const seg of body.split(/[,，、\s]+/)) {
    const s = seg.trim();
    if (!s) continue;

    // 区间连接符兼容半角/全角短横、波浪线、破折号与「至」
    const range = s.match(/^(\d+)\s*[-~—–－〜～至]\s*(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      for (let i = start; i <= end; i++) {
        if (i >= 1 && i <= MAX_WEEK) result.add(i);
      }
      continue;
    }

    if (/^\d+$/.test(s)) {
      const v = parseInt(s, 10);
      if (v >= 1 && v <= MAX_WEEK) result.add(v);
    }
  }

  let weeks = Array.from(result).sort((a, b) => a - b);
  if (isOdd) weeks = weeks.filter((w) => w % 2 === 1);
  if (isEven) weeks = weeks.filter((w) => w % 2 === 0);
  return weeks;
}

/**
 * 周次 + 星期 → 日期字符串 'YYYY-MM-DD'
 *
 * 全程用 Date.UTC 计算，不碰本地时区：云函数环境的 TZ 可能是 UTC，
 * 若用 new Date(...) + setHours 会算出差 8 小时的日期。
 */
function weekToDateStr(termStartMonday, week, dayOfWeek) {
  const parts = String(termStartMonday || '').split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error('weekToDateStr: 学期起始日期无效 ' + termStartMonday);
  }

  const offsetDays = (Number(week) - 1) * 7 + (Number(dayOfWeek) - 1);
  const t = new Date(Date.UTC(y, m - 1, d) + offsetDays * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

module.exports = { parseWeeks, weekToDateStr, MAX_WEEK };
