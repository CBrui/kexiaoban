/**
 * logic/calendar-sync.js —— 课表 → 手机系统日历事件的映射层
 *
 * 为什么需要这一层：
 *   小程序**没有本地通知能力**（退后台后 JS 定时器失效，也没有 App 那种
 *   LocalNotification），「课前提醒」要真的响起来，只能借系统日历这条通道：
 *   wx.addPhoneRepeatCalendar / wx.addPhoneCalendar 把课写进用户的手机日历，
 *   由手机自带的日历 App 到点弹通知（后台、锁屏都能响）。
 *
 *   本模块只负责「算」，不碰 wx API —— 把所有规则集中成纯函数，才能在 Node
 *   下单测。真机调用的容错（授权拒绝、单条失败）留在页面层。
 *
 * 三条绕不开的限制（页面必须如实告诉用户）：
 *   1. 微信**只提供写入，没有删除接口**：改课后重新同步会留下旧事件，得让用户
 *      自己去系统日历里删。所以这里默认跳过已过去的课（excludePast），减少垃圾。
 *   2. 「每周重复」表达不了单双周：repeatInterval 只有 day/week/month/year。
 *      连续周次才能用 week 重复；单周 / 双周 / 跳跃周次只能按周各写一条。
 *   3. 只能在**真机**上调通，模拟器与开发者工具都调不动日历。
 */
const { parseWeeks, weekToDate } = require('../utils/week');

/** 一次同步的事件数量上限：超过就该让用户确认，避免把日历刷爆 */
const MAX_EVENTS = 120;

/** 把 'YYYY-MM-DD' + 'HH:mm' 组合成本地时间戳（秒，日历 API 要的单位） */
function stampOf(dateObj, timeStr) {
  const parts = String(timeStr || '').split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  const d = new Date(dateObj.getTime());
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 某天 23:59:59 的时间戳：用作重复事件的结束边界 */
function endOfDayStamp(dateObj) {
  const d = new Date(dateObj.getTime());
  d.setHours(23, 59, 59, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 周次数组是否连续（连续才能折叠成「每周重复」一条事件） */
function isContinuous(weeks) {
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i] - weeks[i - 1] !== 1) return false;
  }
  return true;
}

/**
 * 把一门课换算成日历事件参数
 * @param {object} course { id, name, teacher, location, day_of_week, start_slot, slot_count, weeks }
 * @param {object} opts
 * @param {string} opts.termStartMonday  学期第一周的周一 'YYYY-MM-DD'
 * @param {number} [opts.leadMinutes]    提前提醒分钟数 → alarmOffset
 * @param {boolean}[opts.excludePast]    跳过今天之前已上的课（默认 true）
 * @param {Date}   [opts.now]            参照时间，便于测试固定「今天」
 * @param {function}[opts.rangeTime]     取节次起止时间，返回 {start,end}（注入以便单测）
 * @returns {{events: Array, reason?: string}} reason 有值表示这门课被跳过的原因
 */
function planCourse(course, opts) {
  const c = course || {};
  const o = opts || {};
  const rangeFn = o.rangeTime;
  const now = o.now || new Date();
  const excludePast = o.excludePast !== false;

  const weeks = parseWeeks(c.weeks).slice().sort((a, b) => a - b);
  if (!weeks.length) return { events: [], reason: '周次为空或无法识别' };

  const dayOfWeek = Number(c.day_of_week);
  const startSlot = Number(c.start_slot);
  if (!(dayOfWeek >= 1 && dayOfWeek <= 7) || !startSlot) {
    return { events: [], reason: '缺星期或节次' };
  }

  const range = rangeFn ? rangeFn(startSlot, Number(c.slot_count) || 1) : null;
  if (!range || !range.start || !range.end) return { events: [], reason: '取不到该节次的时间' };

  const base = {
    title: c.name || '上课',
    description: [c.teacher ? `教师：${c.teacher}` : '', c.location ? `地点：${c.location}` : '']
      .filter(Boolean).join('\n'),
    location: c.location || '',
    alarm: true,
    alarmOffset: Number(o.leadMinutes || 0) * 60,
    allDay: false
  };

  // 未来（或今天尚未开始）的上课日期
  const dates = [];
  for (const w of weeks) {
    const d = weekToDate(o.termStartMonday, w, dayOfWeek);
    const startStamp = stampOf(d, range.start);
    if (!startStamp) continue;
    if (excludePast && startStamp <= Math.floor(now.getTime() / 1000)) continue;
    dates.push({ week: w, date: d, startStamp, endStamp: stampOf(d, range.end) });
  }
  if (!dates.length) return { events: [], reason: '这门课已经全部上完了' };

  // 连续周次 → 一条「每周重复」；否则按实际每周各写一条
  const weeksLeft = dates.map((x) => x.week);
  if (dates.length >= 2 && isContinuous(weeksLeft)) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    return {
      events: [Object.assign({}, base, {
        kind: 'repeat',
        startTime: first.startStamp,
        endTime: first.endStamp,
        repeatInterval: 'week',
        repeatEndTime: endOfDayStamp(last.date),
        _courseId: c.id,
        _weeks: `${first.week}-${last.week}`
      })]
    };
  }

  return {
    events: dates.map((x) => Object.assign({}, base, {
      kind: 'single',
      startTime: x.startStamp,
      endTime: x.endStamp,
      _courseId: c.id,
      _weeks: String(x.week)
    }))
  };
}

/**
 * 生成整张课表的同步计划
 * @param {Array} courses 课程列表
 * @param {object} opts   同 planCourse，另支持：
 *                        silentCourses 已静音的课程 id（静音的课不写进日历）
 *                        maxEvents     事件上限，超出则截断并置 truncated
 * @returns {{events: Array, skipped: Array, truncated: boolean, totalCourses: number}}
 */
function buildCalendarPlan(courses, opts) {
  const o = opts || {};
  const silent = (o.silentCourses || []).map((x) => String(x));
  const maxEvents = o.maxEvents || MAX_EVENTS;
  const events = [];
  const skipped = [];
  let truncated = false;

  for (const c of courses || []) {
    if (c && c.id != null && silent.indexOf(String(c.id)) !== -1) {
      skipped.push({ name: c.name, reason: '这门课已单独关闭提醒' });
      continue;
    }
    const r = planCourse(c, o);
    if (r.reason) {
      skipped.push({ name: c && c.name, reason: r.reason });
      continue;
    }
    if (events.length + r.events.length > maxEvents) {
      truncated = true;
      break;
    }
    events.push(...r.events);
  }

  return {
    events,
    skipped,
    truncated,
    totalCourses: (courses || []).length
  };
}

module.exports = {
  buildCalendarPlan,
  planCourse,
  stampOf,
  endOfDayStamp,
  isContinuous,
  MAX_EVENTS
};
