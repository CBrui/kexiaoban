/**
 * logic/shift-date.js —— 调课指令里的「相对时间」解析
 *
 * 把自然语言里的日期说法（今天 / 上周二 / 10月14日 / 第6周周三）
 * 统一折算成课表模型真正需要的东西：**第几周 + 星期几**。
 *
 * 为什么不直接存日期：本项目课程是「周次规则」模型
 * （day_of_week + start_slot + weeks），不是日历事件模型。
 * 渲染与「找搭子」对齐全部按 `${week}-${day}-${slot}` 取点，
 * 所以调课指令最终必须落到 (week, dayOfWeek) 才有用。
 *
 * 依赖注入学期起始日，便于测试固定时间。
 */
const {
  weekToDate,
  currentWeekOf,
  todayPosition,
  weekdayOf,
  formatDate,
  startOfDay,
  MAX_WEEK
} = require('../utils/week');

/** 中文数字 / 阿拉伯数字 → 星期编号（1=周一 ... 7=周日） */
const WEEKDAY_MAP = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7
};

/** 「上上周 / 上周 / 本周 / 下周 / 下下周」对应的周偏移 */
const WEEK_OFFSET = {
  上上周: -2, 上上星期: -2, 上上个星期: -2,
  上周: -1, 上星期: -1, 上个星期: -1, 上一周: -1,
  本周: 0, 这周: 0, 这个星期: 0, 这星期: 0, 这一周: 0,
  下周: 1, 下星期: 1, 下个星期: 1, 下一周: 1,
  下下周: 2, 下下星期: 2
};

/** 「今天 / 明天 / 后天 / 昨天 / 前天」对应的天偏移 */
const DAY_OFFSET = {
  今天: 0, 今日: 0, 当天: 0, 当日: 0,
  明天: 1, 明日: 1, 次日: 1,
  后天: 2, 明后天: 2,
  昨天: -1, 昨日: -1,
  前天: -2
};

function shiftDays(date, n) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + Number(n || 0));
  return d;
}

/**
 * 把 (周次, 星期) 折算回一个具体日期，便于展示「改的是哪一天」
 */
function dateOfWeekDay(ctx, week, dayOfWeek) {
  try {
    return weekToDate(ctx.termStartMonday, week, dayOfWeek);
  } catch (e) {
    return null;
  }
}

/**
 * 解析「X月X日」「X/X」「X-X」这类具体日期
 * @returns {Date|null}
 */
function parseCalendarDate(text, today) {
  const s = String(text || '');
  const now = new Date(today);

  // 10月14日 / 10月14号 / 10.14
  let m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (!m) {
    // 10/14 或 10-14（注意别误吃课程里的 "1-16周"）
    m = s.match(/(?:^|[^\d])(\d{1,2})\s*[/\-]\s*(\d{1,2})(?!\s*周)/);
  }
  if (!m) return null;

  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let year = now.getFullYear();
  let d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);

  // 跨年兜底：说的是明年1月的调课（比如12月提到「1月5日」），
  // 按当前年算会落在过去，这时候 +1 年才合理。
  const diffDays = Math.round((d.getTime() - startOfDay(now).getTime()) / 86400000);
  if (diffDays < -180) {
    d = new Date(year + 1, month - 1, day);
    d.setHours(0, 0, 0, 0);
  }
  return d;
}

/**
 * 解析「第6周周三」这类直接按教学周表达的说法
 * @returns {{week:number, dayOfWeek:number}|null}
 */
function parseTermWeekExpr(text) {
  const s = String(text || '');
  const m = s.match(/第?\s*(\d{1,2})\s*周\s*(?:[的]?\s*)?(?:周|星期|礼拜)?\s*([一二三四五六日天1-7])/);
  if (!m) return null;

  const week = parseInt(m[1], 10);
  const dayOfWeek = WEEKDAY_MAP[m[2]];
  if (!week || week < 1 || week > MAX_WEEK) return null;
  if (!dayOfWeek) return null;

  return { week, dayOfWeek };
}

/**
 * 把一段文字里的日期说法解析成课表坐标
 *
 * @param {string} text 含日期的表述，如「上周二」
 * @param {object} ctx { termStartMonday, today, maxWeek }
 * @returns {object|null} { week, dayOfWeek, date, label, inTerm } —— 解析不出返回 null
 */
function resolveDateExpr(text, ctx) {
  if (!text || !ctx) return null;

  const s = String(text).trim();
  const today = ctx.today ? new Date(ctx.today) : new Date();
  const maxWeek = Number(ctx.maxWeek) > 0 ? Number(ctx.maxWeek) : MAX_WEEK;
  const pos = todayPosition(ctx.termStartMonday, today, maxWeek);

  // 1) 今天 / 明天 / 昨天 这类按天偏移
  for (const key of Object.keys(DAY_OFFSET)) {
    if (s.indexOf(key) !== -1) {
      const d = shiftDays(today, DAY_OFFSET[key]);
      const week = currentWeekOf(ctx.termStartMonday, d, maxWeek);
      const dayOfWeek = weekdayOf(d);
      return {
        week,
        dayOfWeek,
        date: formatDate(d),
        label: key,
        inTerm: week >= 1 && week <= maxWeek
      };
    }
  }

  // 2) 第6周周三 —— 教学周直接表达，周次不随「今天」漂移
  const termExpr = parseTermWeekExpr(s);
  if (termExpr) {
    const d = dateOfWeekDay(ctx, termExpr.week, termExpr.dayOfWeek);
    return {
      week: termExpr.week,
      dayOfWeek: termExpr.dayOfWeek,
      date: d ? formatDate(d) : '',
      label: `第${termExpr.week}周`,
      inTerm: true
    };
  }

  // 3) 上上周X / 上周X / 本周X / 下周X / 周X
  //    先匹配带修饰的（上/下），避免「上周二」被裸「周二」先吃掉
  const keys = Object.keys(WEEK_OFFSET).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (s.indexOf(key) === -1) continue;
    const rest = s.slice(s.indexOf(key) + key.length);
    const dm = rest.match(/^\s*(?:周|星期|礼拜)?\s*([一二三四五六日天1-7])/);
    if (!dm) continue;

    const dayOfWeek = WEEKDAY_MAP[dm[1]];
    if (!dayOfWeek) continue;

    // 关键口径（用户已确认）：「上周二」= 上一**自然周**的周二，
    // 即在当前教学周上做周偏移，而不是往回找最近一次周二。
    const week = pos.week + WEEK_OFFSET[key];
    if (week < 1) return null;

    const d = dateOfWeekDay(ctx, week, dayOfWeek);
    return {
      week,
      dayOfWeek,
      date: d ? formatDate(d) : '',
      label: `${key}周${dm[1]}`,
      inTerm: week <= maxWeek
    };
  }

  // 4) 裸「周二」「周日」（不带上下修饰）→ 当前周
  const bare = s.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (bare) {
    const dayOfWeek = WEEKDAY_MAP[bare[1]];
    if (dayOfWeek) {
      const d = dateOfWeekDay(ctx, pos.week, dayOfWeek);
      return {
        week: pos.week,
        dayOfWeek,
        date: d ? formatDate(d) : '',
        label: `周${bare[1]}`,
        inTerm: pos.inTerm
      };
    }
  }

  // 5) YYYY-MM-DD / YYYY/MM/DD —— 大模型常直接输出这种格式
  const iso = s.match(/(\d{4})\s*[-\/年]\s*(\d{1,2})\s*[-\/月]\s*(\d{1,2})\s*日?/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const mo = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const date = new Date(y, mo - 1, d);
      date.setHours(0, 0, 0, 0);
      const week = currentWeekOf(ctx.termStartMonday, date, maxWeek);
      return {
        week,
        dayOfWeek: weekdayOf(date),
        date: formatDate(date),
        label: formatDate(date),
        inTerm: week >= 1 && week <= maxWeek
      };
    }
  }

  // 6) 10月14日 这类具体日期
  const cd = parseCalendarDate(s, today);
  if (cd) {
    const week = currentWeekOf(ctx.termStartMonday, cd, maxWeek);
    const dayOfWeek = weekdayOf(cd);
    return {
      week,
      dayOfWeek,
      date: formatDate(cd),
      label: formatDate(cd),
      inTerm: week >= 1 && week <= maxWeek
    };
  }

  return null;
}

module.exports = {
  resolveDateExpr,
  parseCalendarDate,
  parseTermWeekExpr,
  WEEKDAY_MAP
};
