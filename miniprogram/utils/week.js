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
  const body = text.replace(/(单|双)周?/g, '').replace(/周/g, '').trim();
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
 * 日期 → { year, month, day } 格式化
 */
function formatDate(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  MAX_WEEK
};
