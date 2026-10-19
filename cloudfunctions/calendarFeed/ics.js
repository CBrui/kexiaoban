/**
 * lib/ics.js —— 课表 → ICS（iCalendar）文本
 *
 * 为什么需要它：
 *   `wx.addPhoneRepeatCalendar` 那条路在安卓上走不通 —— 一次并发十几条写入
 *   只进 1~2 条，还要用户在弹窗里点十几次「继续」，而且微信**没有删除日历
 *   事件的接口**，改课后旧事件删不掉。
 *
 *   订阅日历把方向反过来：不再由小程序往日历里「写」，而是让手机日历定期
 *   来「拉」一个 .ics 文件。于是：
 *     - 整学期全部节次一次到位，不受并发与点击手势限制；
 *     - 改课 / 删课 / 调休后刷新订阅即生效，旧事件由日历客户端自己消失；
 *     - 单双周用 `RRULE:FREQ=WEEKLY;INTERVAL=2` 原生表达，不必按周拆成 N 条。
 *
 * 本模块是纯函数，不依赖 wx-server-sdk，可在 Node 下直接单测。
 *
 * 两条硬约束（写错客户端就解析失败）：
 *   1. 行长度 ≤ 75 字节（不是字符！中文一个字 3 字节），超出必须折行：
 *      续行以 CRLF + **一个空格** 开头。折行不能切断多字节字符。
 *   2. 文本里的 `\` `;` `,` 必须转义，换行写成 `\n`。
 */
const { parseWeeks, weekToDateStr } = require('./week');
const { getRangeTime } = require('./schedule');

/** 东八区固定偏移（中国不实行夏令时，可写死） */
const TZ_OFFSET_HOURS = 8;

const pad = (n) => String(n).padStart(2, '0');

/**
 * 'YYYY-MM-DD' + 'HH:mm'（北京时间）→ ICS 的 UTC 时间串 'YYYYMMDDTHHMMSSZ'
 *
 * 全程 Date.UTC 手工计算：云函数环境时区不保证东八区，用 Date + setHours
 * 会差 8 小时。
 */
function toIcsUtc(dateStr, timeStr) {
  const d = String(dateStr || '').split('-');
  const t = String(timeStr || '').split(':');
  const y = Number(d[0]);
  const mo = Number(d[1]);
  const day = Number(d[2]);
  const h = Number(t[0]);
  const mi = Number(t[1]);
  if (![y, mo, day, h, mi].every(Number.isFinite)) return '';

  const ts = new Date(Date.UTC(y, mo - 1, day, h - TZ_OFFSET_HOURS, mi, 0));
  return (
    `${ts.getUTCFullYear()}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())}` +
    `T${pad(ts.getUTCHours())}${pad(ts.getUTCMinutes())}${pad(ts.getUTCSeconds())}Z`
  );
}

/** JS 时间戳（毫秒）→ ICS UTC 时间串 */
function stampToIcsUtc(ms) {
  const t = new Date(ms);
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`
  );
}

/** ICS 文本转义：反斜杠、分号、逗号、换行 */
function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * 按 RFC 5545 折行：每行 ≤ 75 字节，续行以 CRLF + 空格开头
 * 逐码点累加字节数，绝不切断多字节字符（否则中文会变乱码）。
 */
function foldLine(line) {
  const text = String(line == null ? '' : line);
  const out = [];
  let cur = '';
  let bytes = 0;
  let isFirst = true;

  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = isFirst ? 74 : 73; // 续行首那个空格也占 1 字节
    if (bytes + size > limit) {
      out.push(cur);
      isFirst = false;
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += size;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * 把周次数组切成若干「等差段」
 *
 * RRULE 的 INTERVAL 是常量，所以只有相邻间隔恒定的一段才能合成一条重复事件：
 *   [1,2,3,4]    → 一段，INTERVAL=1（每周）
 *   [1,3,5,7]    → 一段，INTERVAL=2（单周/双周）
 *   [1,2,3,5,6]  → [1,2,3] + [5,6]（间隔从 1 变 2，必须拆）
 *
 * @returns {Array<{weeks:number[], interval:number}>}
 */
function splitSegments(weeks) {
  const w = (weeks || []).slice().sort((a, b) => a - b);
  if (!w.length) return [];

  const groups = [];
  let cur = [w[0]];
  let step = null;

  for (let i = 1; i < w.length; i++) {
    const delta = w[i] - w[i - 1];
    if (step === null) step = delta;
    if (delta === step && (step === 1 || step === 2)) {
      cur.push(w[i]);
    } else {
      groups.push(cur);
      cur = [w[i]];
      step = null;
    }
  }
  groups.push(cur);

  return groups.map((g) => ({
    weeks: g,
    interval: g.length >= 2 && g[1] - g[0] === 2 ? 2 : 1
  }));
}

/** 事件 UID：必须稳定，日历客户端靠它判断「更新还是新增」 */
function makeUid(course, segIndex) {
  const raw = String((course && (course.id || course._id)) || '');
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const fallback = [
    course && course.name,
    course && course.day_of_week,
    course && course.start_slot
  ].join('-');
  const base = safe || String(fallback).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'course';
  return `${base}-${segIndex}@kexiaoban`;
}

/**
 * 一门课 → 若干条 VEVENT 文本
 * @returns {string[]}
 */
function buildEvents(course, opts) {
  return buildEventsEx(course, opts).lines;
}

/**
 * 同 buildEvents，额外返回「因放假被整段剔除」的段数，供调用方给出准确原因
 *
 * 为什么要区分：日历 App 不看我们的免打扰判定，放假当天照样响铃。
 * 唯一让它闭嘴的办法是**那天根本没有这个事件**，所以避假必须做在生成侧。
 *
 * @returns {{lines: string[], holidaySkipped: number, exdateCount: number}}
 */
function buildEventsEx(course, opts) {
  const o = opts || {};
  const c = course || {};
  const weeks = parseWeeks(c.weeks);
  if (!weeks.length) return { lines: [], holidaySkipped: 0, exdateCount: 0 };

  const dayOfWeek = Number(c.day_of_week);
  const startSlot = Number(c.start_slot);
  if (!(dayOfWeek >= 1 && dayOfWeek <= 7) || !startSlot) {
    return { lines: [], holidaySkipped: 0, exdateCount: 0 };
  }

  const range = getRangeTime(startSlot, Number(c.slot_count) || 1, o.schedule);
  if (!range) return { lines: [], holidaySkipped: 0, exdateCount: 0 };

  const lines = [];
  const lead = Number(o.leadMinutes || 0);
  const holidayIndex = o.holidayIndex || null;
  let holidaySkipped = 0;
  let exdateCount = 0;

  splitSegments(weeks).forEach((seg, idx) => {
    const firstWeek = seg.weeks[0];
    const dateStr = weekToDateStr(o.termStartMonday, firstWeek, dayOfWeek);
    const dtStart = toIcsUtc(dateStr, range.start);
    const dtEnd = toIcsUtc(dateStr, range.end);
    if (!dtStart || !dtEnd) return;

    /**
     * 法定节假日不上课 → 用 EXDATE 把这些日期从重复事件里剔除。
     * 只剔 holiday，不剔 makeup —— 调休上班日该上的课照常。
     */
    const exdates = [];
    if (holidayIndex) {
      for (const w of seg.weeks) {
        const d = weekToDateStr(o.termStartMonday, w, dayOfWeek);
        if (holidayIndex[d] !== 'holiday') continue;
        const ex = toIcsUtc(d, range.start);
        if (ex) exdates.push(ex);
      }
      // 这一段的每一次上课都落在假期里 → 整段不生成
      if (exdates.length && exdates.length === seg.weeks.length) {
        holidaySkipped += 1;
        return;
      }
    }
    exdateCount += exdates.length;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${makeUid(c, idx)}`);
    lines.push(`DTSTAMP:${o.dtStamp}`);
    lines.push(`DTSTART:${dtStart}`);
    lines.push(`DTEND:${dtEnd}`);
    if (seg.weeks.length >= 2) {
      /**
       * ⚠️ 有 EXDATE 时改用 UNTIL、不用 COUNT。
       * RFC 5545 规定 COUNT 计数的是 RRULE 展开的实例数、EXDATE 之后剔除，
       * 但各家客户端实现并不统一：若某客户端先剔除再计数，末周的课就会被截断。
       * UNTIL 只划定时间上界，展开结果不受剔除影响，恒等于「到末周为止的每一周」。
       */
      if (exdates.length) {
        const lastWeek = seg.weeks[seg.weeks.length - 1];
        const until = toIcsUtc(weekToDateStr(o.termStartMonday, lastWeek, dayOfWeek), range.end);
        lines.push(`RRULE:FREQ=WEEKLY;INTERVAL=${seg.interval};UNTIL=${until}`);
      } else {
        lines.push(`RRULE:FREQ=WEEKLY;INTERVAL=${seg.interval};COUNT=${seg.weeks.length}`);
      }
    }
    if (exdates.length) lines.push(`EXDATE:${exdates.join(',')}`);
    lines.push(`SUMMARY:${escapeText(c.name || '上课')}`);
    if (c.location) lines.push(`LOCATION:${escapeText(c.location)}`);

    const desc = [c.teacher ? `教师：${c.teacher}` : '', `第 ${formatWeeks(seg.weeks)} 周`]
      .filter(Boolean)
      .join('\n');
    lines.push(`DESCRIPTION:${escapeText(desc)}`);

    /**
     * ⚠️ 闹钟格式**必须**对齐 Apple 日历原生导出的写法（`ACTION:AUDIO` +
     * `ATTACH;VALUE=URI:Basso`），不能用 `ACTION:DISPLAY`：
     *   1. DISPLAY 只弹一段文本、不响铃，iOS 与部分安卓 ROM 在订阅日历里
     *      会把它显示成「无提醒」（用户实测反馈），AUDIO 才是带响铃的提醒；
     *   2. `ATTACH;VALUE=URI:Basso` 是 Apple 用的默认铃声标识，缺了它部分
     *      客户端认为这个闹钟没有声音资源而忽略；
     *   3. `TRIGGER` 显式写 `VALUE=DURATION`（RFC 5545 虽允许省略，但显式
     *      声明在某些解析器上更稳）。
     */
    if (lead > 0) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:AUDIO');
      lines.push(`DESCRIPTION:${escapeText(`${c.name || '上课'} 即将开始`)}`);
      lines.push(`TRIGGER;VALUE=DURATION:-PT${lead}M`);
      lines.push('ATTACH;VALUE=URI:Basso');
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  });

  return { lines, holidaySkipped, exdateCount };
}

/** 周次数组的紧凑写法：[1,2,3,5] → "1-3,5" */
function formatWeeks(weeks) {
  const w = (weeks || []).slice().sort((a, b) => a - b);
  if (!w.length) return '';
  const parts = [];
  let start = w[0];
  let prev = w[0];
  for (let i = 1; i <= w.length; i++) {
    if (w[i] === prev + 1) {
      prev = w[i];
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = w[i];
    prev = w[i];
  }
  return parts.join(',');
}

/**
 * 生成整份 ICS
 *
 * @param {object} opts
 * @param {Array}  opts.courses              课程列表
 * @param {string} opts.termStartMonday      第 1 周周一 'YYYY-MM-DD'
 * @param {number} [opts.leadMinutes=15]     提前提醒分钟数（0 = 不设闹钟）
 * @param {Array}  [opts.silentCourses]      已静音的课程 id（不写进日历）
 * @param {object} [opts.schedule]           作息配置，缺省用内置默认
 * @param {object} [opts.holidayIndex]       节假日索引 {'YYYY-MM-DD': 'holiday'|'makeup'}，
 *                                           放假当天的课用 EXDATE 剔除；不传则不避假
 * @param {string} [opts.calendarName='课小伴课表']
 * @param {Date}   [opts.now]                生成时间（DTSTAMP），便于测试固定
 * @returns {{ics: string, eventCount: number, exdateCount: number, skipped: Array}}
 */
function buildIcs(opts) {
  const o = opts || {};
  const silent = (o.silentCourses || []).map((x) => String(x));
  const dtStamp = stampToIcsUtc((o.now || new Date()).getTime());
  const calName = o.calendarName || '课小伴课表';

  const body = [];
  const skipped = [];
  let eventCount = 0;
  let exdateCount = 0;

  for (const c of o.courses || []) {
    if (!c) continue;
    if (c.id != null && silent.indexOf(String(c.id)) !== -1) {
      skipped.push({ name: c.name, reason: '这门课已单独关闭提醒' });
      continue;
    }
    const r = buildEventsEx(c, {
      termStartMonday: o.termStartMonday,
      schedule: o.schedule,
      leadMinutes: o.leadMinutes == null ? 15 : o.leadMinutes,
      dtStamp,
      holidayIndex: o.holidayIndex
    });
    if (!r.lines.length) {
      skipped.push({
        name: c.name,
        reason: r.holidaySkipped ? '这门课的上课日都在假期里' : '周次或节次无法识别'
      });
      continue;
    }
    body.push(...r.lines);
    eventCount += r.lines.filter((l) => l === 'BEGIN:VEVENT').length;
    exdateCount += r.exdateCount;
  }

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kexiaoban//course-schedule//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H'
  ];

  // 逐行折行后用 CRLF 连接；末尾再补一个 CRLF（RFC 5545 要求）
  const all = head.concat(body, ['END:VCALENDAR']);
  return {
    ics: all.map(foldLine).join('\r\n') + '\r\n',
    eventCount,
    exdateCount,
    skipped
  };
}

module.exports = {
  buildIcs,
  buildEvents,
  buildEventsEx,
  splitSegments,
  escapeText,
  foldLine,
  toIcsUtc,
  stampToIcsUtc,
  formatWeeks,
  makeUid
};
