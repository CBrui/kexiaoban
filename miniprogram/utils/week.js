/**
 * utils/week.js —— 周次解析与日期换算
 *
 * 这是课程展开算法的前置依赖。周次维度是本项目最重要的技术决策：
 * 只有把「周次」显式解析出来，单双周课程才能被正确处理，
 * 否则「找搭子」会把可用的空档算没。
 *
 * 支持的写法：
 *   "1-16"        第 1 至 16 周每周
 *   "1-16 单"     第 1-16 周的奇数周
 *   "1-16 双"     第 1-16 周的偶数周
 *   "3,5,7"       指定周次
 *   "1-8,10-16"   多段区间
 *   "1-16单,17-18" 区间与单双周混写
 */

const MAX_WEEK = 30;

/**
 * 解析周次规则文本 → 周次数组（升序）
 * @param {string} text 周次规则描述
 * @returns {number[]} 周次数组，如 [1,3,5,...,15]
 */
function parseWeeks(text) {
  if (!text || typeof text !== 'string') return [];

  const isOdd = /单/.test(text);
  const isEven = /双/.test(text);

  // 去掉「单双周」字样及其「周」后缀，只留数字区间部分
  // 「第」也一并去掉：课表截图里常写成「第1-16周」，模型会原样搬过来，
  // 不去掉的话下面的区间正则匹配不上，整条周次会被判为无效。
  const body = text.replace(/(单|双)周?/g, '').replace(/周/g, '').replace(/第/g, '').trim();
  if (!body) return [];

  const result = new Set();

  for (const seg of body.split(/[,，、\s]+/)) {
    const s = seg.trim();
    if (!s) continue;

    const range = s.match(/^(\d+)\s*[-~至]\s*(\d+)$/);
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
 * 周次 + 星期 → 具体日期
 * @param {string|Date} termStartMonday 学期第 1 周周一的日期
 * @param {number} week 周次（从 1 开始）
 * @param {number} dayOfWeek 星期几（1=周一 ... 7=周日）
 * @returns {Date}
 */
function weekToDate(termStartMonday, week, dayOfWeek) {
  const base = new Date(termStartMonday);
  if (isNaN(base.getTime())) {
    throw new Error('weekToDate: 学期起始日期无效');
  }
  base.setHours(0, 0, 0, 0);
  const offsetDays = (week - 1) * 7 + (dayOfWeek - 1);
  base.setDate(base.getDate() + offsetDays);
  return base;
}

/**
 * 日期 → "YYYY-MM-DD" 格式化（本地时区，不经过 UTC）
 */
function formatDate(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把任意日期归一到「当天 00:00:00」，消除时分秒对日期差计算的干扰
 */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 两个日期相差的整天数（b - a），按本地日历天计算
 */
function daysBetween(a, b) {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 86400000);
}

/**
 * 日期 → 星期几（1=周一 ... 7=周日）
 * JS 的 getDay() 里 0=周日，需要转换为「周一为一周之始」的编号
 */
function weekdayOf(date) {
  const d = new Date(date);
  const jsDay = d.getDay(); // 0=周日
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * 今天 → 对应学期的第几周（clamp 到 [1, maxWeek]）
 *
 * 算法：用「今天」与「学期第 1 周周一」的整天差算周序号。
 * 差值为负（学期未开始）时返回 1；超出最大周次时返回 maxWeek。
 *
 * @param {string|Date} termStartMonday 学期第 1 周周一日期
 * @param {Date} [today] 参照日期，默认取当前时间（便于测试注入）
 * @param {number} [maxWeek] 学期总周数上限
 * @returns {number} 周次，范围 [1, maxWeek]
 */
function currentWeekOf(termStartMonday, today, maxWeek) {
  const max = Number(maxWeek) > 0 ? Number(maxWeek) : MAX_WEEK;
  const base = new Date(termStartMonday);
  if (isNaN(base.getTime())) return 1;

  const now = today ? new Date(today) : new Date();
  const diff = daysBetween(base, now);
  if (diff < 0) return 1; // 学期还没开始

  const week = Math.floor(diff / 7) + 1;
  if (week < 1) return 1;
  if (week > max) return max; // 学期已结束，停在最后一周
  return week;
}

/**
 * 今天是本学期内的第几天（用于判断「今天」落在哪一列）
 * 返回值同时给出周次与星期，便于页面直接定位。
 *
 * @returns {{ week:number, dayOfWeek:number, inTerm:boolean, date:string }}
 *          inTerm=false 表示今天不在学期范围内（开学前 / 放假后）
 */
function todayPosition(termStartMonday, today, maxWeek) {
  const max = Number(maxWeek) > 0 ? Number(maxWeek) : MAX_WEEK;
  const base = new Date(termStartMonday);
  const now = today ? new Date(today) : new Date();

  if (isNaN(base.getTime())) {
    return { week: 1, dayOfWeek: weekdayOf(now), inTerm: false, date: formatDate(now) };
  }

  const diff = daysBetween(base, now);
  const week = Math.floor(diff / 7) + 1;
  const inTerm = diff >= 0 && week <= max;

  return {
    week: inTerm ? week : clampWeek(week, max),
    dayOfWeek: weekdayOf(now),
    inTerm,
    date: formatDate(now)
  };
}

function clampWeek(week, max) {
  if (week < 1) return 1;
  if (week > max) return max;
  return week;
}

/**
 * 当前时刻 "HH:MM"（用于课表当前时间指示线）
 */
function currentTimeStr(date) {
  const d = date ? new Date(date) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 判断「今天」是否就是给定的 (周次, 星期) —— 用于表头高亮与列高亮
 */
function isToday(termStartMonday, week, dayOfWeek, today) {
  const pos = todayPosition(termStartMonday, today);
  return pos.inTerm && pos.week === Number(week) && pos.dayOfWeek === Number(dayOfWeek);
}

/**
 * 把周次数组压缩为易读文本，如 [1,3,5,7] → "1,3,5,7"
 * 连续区间折为 "1-4"
 */
function formatWeeks(weeks) {
  if (!weeks || !weeks.length) return '';
  const sorted = Array.from(new Set(weeks)).sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(',');
}

module.exports = {
  parseWeeks,
  weekToDate,
  formatDate,
  formatWeeks,
  startOfDay,
  daysBetween,
  weekdayOf,
  currentWeekOf,
  todayPosition,
  currentTimeStr,
  isToday,
  MAX_WEEK
};
