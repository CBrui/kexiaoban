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
const { parseWeeks, weekToDate, formatDate } = require('../utils/week');

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
  const holidayIndex = o.holidayIndex || null;
  const skippedHolidays = [];
  const dates = [];
  for (const w of weeks) {
    const d = weekToDate(o.termStartMonday, w, dayOfWeek);
    // weekToDate 返回的是 Date 对象，查节假日索引必须先转成 'YYYY-MM-DD'
    const dateStr = formatDate(d);
    const startStamp = stampOf(d, range.start);
    if (!startStamp) continue;
    if (excludePast && startStamp <= Math.floor(now.getTime() / 1000)) continue;
    // 法定节假日不上课，日历里也不该响。
    // 只剔 holiday，不剔 makeup —— 调休日该上的课照常。
    if (holidayIndex && holidayIndex[dateStr] === 'holiday') {
      skippedHolidays.push(dateStr);
      continue;
    }
    dates.push({ week: w, date: d, startStamp, endStamp: stampOf(d, range.end) });
  }
  if (!dates.length) {
    return { events: [], reason: '这门课已经全部上完了（或全部落在节假日）' };
  }

  // 按「周次是否连续」切成若干段：连续段写成一条「每周重复」，
  // 孤立周写成单条。这样节假日把学期打断成两段时，是 2 条重复事件
  // 而不是十几条零散事件。
  const events = splitIntoRuns(dates).map((run) => {
    const first = run[0];
    const last = run[run.length - 1];
    if (run.length >= 2) {
      return Object.assign({}, base, {
        kind: 'repeat',
        startTime: first.startStamp,
        endTime: first.endStamp,
        repeatInterval: 'week',
        repeatEndTime: endOfDayStamp(last.date),
        _courseId: c.id,
        _weeks: `${first.week}-${last.week}`
      });
    }
    return Object.assign({}, base, {
      kind: 'single',
      startTime: first.startStamp,
      endTime: first.endStamp,
      _courseId: c.id,
      _weeks: String(first.week)
    });
  });

  return { events, skippedHolidays };
}

/**
 * 把按周升序的日期切成连续段（相邻周次差 1 视为同一段）
 * @param {Array<{week:number}>} dates
 * @returns {Array<Array>}
 */
function splitIntoRuns(dates) {
  const runs = [];
  let cur = null;
  for (const d of dates) {
    if (cur && d.week === cur[cur.length - 1].week + 1) {
      cur.push(d);
    } else {
      cur = [d];
      runs.push(cur);
    }
  }
  return runs;
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

/**
 * 事件去重键
 *
 * 微信**没有删除日历事件的 API**，一旦写进去就删不掉。重试同步时若不跳过已写入的，
 * 日历里就会堆出两份一模一样的课。这里给每条事件一个稳定 key，写入成功后记进 storage，
 * 下次同步时据此跳过。
 */
function eventKey(ev) {
  if (!ev) return '';
  return [ev.title || '', ev.startTime || 0, ev.repeatInterval || '', ev.repeatEndTime || 0].join('|');
}

/**
 * 判断失败原因是否为「必须在用户点击手势中调用」
 *
 * 真机实测踩坑：日历写入 API 要求调用发生在用户点击的同步调用栈里，
 * 一旦在循环里 `await` 上一条写完再写下一条，后续调用就脱离了手势上下文，
 * 全部报 `addPhoneRepeatCalendar:fail can only be invoked by user TAP gesture`。
 * 表现是「第一条成功、后面全失败」。
 */
function isGestureError(errMsg) {
  return /TAP gesture/i.test(String(errMsg || ''));
}

/**
 * 同步结果汇总（纯函数，供页面直接渲染）
 * @param {number} ok    成功条数
 * @param {Array<{title:string, err:string}>} fails 失败明细
 * @returns {{level: 'all'|'partial'|'none', text: string}}
 */
function summarizeSyncResult(ok, fails) {
  const list = Array.isArray(fails) ? fails : [];
  const total = ok + list.length;

  if (!list.length && ok > 0) {
    return {
      level: 'all',
      text: `已写入 ${ok} 条日历事件，课前由手机日历提醒。\n改课后旧事件需在手机日历里手动删除 —— 微信不支持删除日历事件。`
    };
  }

  if (ok === 0 && list.length) {
    const reasons = uniqueReasons(list);
    const gesture = list.some((f) => isGestureError(f.err));
    return {
      level: 'none',
      text: `一条都没写进去（共 ${total} 条）。\n${reasons}\n\n${
        gesture
          ? '提示：日历写入必须在点击后的同步操作中完成，请直接点「同步到手机日历」按钮，不要在弹窗里等待太久。'
          : '请检查是否授予了日历权限。'
      }`
    };
  }

  if (ok > 0 && list.length) {
    const reasons = uniqueReasons(list);
    return {
      level: 'partial',
      text: `成功 ${ok} 条，失败 ${list.length} 条。\n${reasons}\n\n再点一次可补写失败的 —— 已写进去的会自动跳过，不会重复。`
    };
  }

  return { level: 'none', text: '' };
}

/** 失败原因去重，最多展示 3 条 */
function uniqueReasons(fails) {
  const seen = [];
  fails.forEach((f) => {
    const r = String((f && f.err) || '未知错误').trim();
    if (seen.indexOf(r) === -1) seen.push(r);
  });
  return seen.slice(0, 3).map((r) => `· ${r}`).join('\n');
}

module.exports = {
  buildCalendarPlan,
  planCourse,
  stampOf,
  endOfDayStamp,
  isContinuous,
  splitIntoRuns,
  eventKey,
  isGestureError,
  summarizeSyncResult,
  MAX_EVENTS
};
