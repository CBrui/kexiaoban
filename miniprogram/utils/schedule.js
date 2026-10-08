/**
 * utils/schedule.js —— 作息时间工具（支持自定义节数）
 *
 * 核心能力：
 *   1. 由「分段节数 + 起始时间 + 单节时长」动态生成完整的节次时间表
 *   2. 节次 → 时间区间的查询（如第 1 节 → 08:00-08:45）
 *   3. 连堂课的时间段合并（如第 1-2 节 → 08:00-09:40）
 *   4. 生成渲染用的节次轴（含休息分隔行）
 *
 * 设计要点：不写死 12 节。节数变化时，整条时间轴自动重算，
 * 网格结构随之改变，为后续「拍照识别课表」适配不同学校作息留出空间。
 */
const { SCHEDULE } = require('../config');

const SCHEDULE_STORAGE_KEY = 'kxb:schedule';

/* ==================== 分钟与时间字符串互转 ==================== */

/** "08:00" → 480 */
function toMinutes(str) {
  if (!str || typeof str !== 'string') return 0;
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** 480 → "08:00" */
function toTimeStr(minutes) {
  const total = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ==================== 配置读取与保存 ==================== */

/**
 * 读取用户自定义作息（未设置则用 config.js 默认值）
 * @returns {object} SCHEDULE 结构的副本
 */
function getSchedule() {
  let saved = null;
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      saved = wx.getStorageSync(SCHEDULE_STORAGE_KEY);
    }
  } catch (e) {
    saved = null;
  }

  if (saved && Array.isArray(saved.segments) && saved.segments.length) {
    return {
      ...SCHEDULE,
      ...saved,
      segments: saved.segments.map((s) => ({ ...s }))
    };
  }

  return {
    ...SCHEDULE,
    segments: SCHEDULE.segments.map((s) => ({ ...s }))
  };
}

/**
 * 保存作息配置
 */
function saveSchedule(schedule) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(SCHEDULE_STORAGE_KEY, schedule);
    }
  } catch (e) {
    console.error('[schedule] 保存失败', e);
  }
}

/**
 * 恢复默认作息
 */
function resetSchedule() {
  try {
    if (typeof wx !== 'undefined' && wx.removeStorageSync) {
      wx.removeStorageSync(SCHEDULE_STORAGE_KEY);
    }
  } catch (e) {
    /* ignore */
  }
  return getSchedule();
}

/* ==================== 时间轴生成（核心） ==================== */

/**
 * 根据作息配置生成完整的节次时间表
 *
 * 算法：
 *   对每个时段，从 startFirst 开始，
 *   每节占用 duration 分钟，节与节之间留 breakWithinSegment 分钟课间；
 *   时段结束后，按下一段的 startFirst 决定休息时长。
 *
 * @param {object} [schedule] 作息配置，默认取 getSchedule()
 * @returns {{
 *   slots: Array<{slot:number, start:string, end:string, segment:string, segmentLabel:string}>,
 *   segments: Array<{key:string, label:string, slots:number[], start:string, end:string}>,
 *   breaks: Array<{afterSlot:number, label:string, start:string, end:string}>,
 *   totalSlots: number
 * }}
 */
function buildTimeline(schedule) {
  const cfg = schedule || getSchedule();
  const segments = cfg.segments || [];
  const within = Number(cfg.breakWithinSegment) || 0;

  const slots = [];
  const segmentMeta = [];
  const breaks = [];
  const breakMap = {};
  for (const b of cfg.segmentBreaks || []) {
    breakMap[b.afterKey] = b;
  }

  let slotNo = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const count = Math.max(0, Number(seg.slots) || 0);
    if (count === 0) {
      // 节数为 0 的时段直接跳过，不产生任何行
      continue;
    }

    const duration = Number(seg.duration) || 45;
    let cursor = toMinutes(seg.startFirst);
    const segSlots = [];
    const segStart = toTimeStr(cursor);

    for (let k = 0; k < count; k++) {
      slotNo += 1;
      const startMin = cursor;
      const endMin = cursor + duration;

      slots.push({
        slot: slotNo,
        start: toTimeStr(startMin),
        end: toTimeStr(endMin),
        segment: seg.key,
        segmentLabel: seg.label
      });

      segSlots.push(slotNo);
      cursor = endMin + within;
    }

    const segEnd = toTimeStr(cursor - within); // 最后一节结束时间（减掉多余的课间）

    segmentMeta.push({
      key: seg.key,
      label: seg.label,
      slots: segSlots,
      start: segStart,
      end: segEnd
    });

    // 时段之间的休息（非最后一段）
    const lastSlotOfSeg = segSlots[segSlots.length - 1];
    const nextSeg = segments[i + 1];
    if (breakMap[seg.key] && nextSeg) {
      const nextStart = toMinutes(nextSeg.startFirst);
      breaks.push({
        afterSlot: lastSlotOfSeg,
        label: breakMap[seg.key].label,
        start: segEnd,
        end: toTimeStr(nextStart)
      });
    } else if (breakMap[seg.key] && !nextSeg) {
      // 末段也配置了休息标签时，仍展示但未知结束时间
      breaks.push({
        afterSlot: lastSlotOfSeg,
        label: breakMap[seg.key].label,
        start: segEnd,
        end: ''
      });
    }
  }

  return {
    slots,
    segments: segmentMeta,
    breaks,
    totalSlots: slots.length
  };
}

/* ==================== 查询接口 ==================== */

/**
 * 取单节完整时间区间
 * @returns {{slot:number, start:string, end:string}|null}
 */
function getSlotTime(slot) {
  const timeline = buildTimeline();
  return timeline.slots.find((s) => s.slot === Number(slot)) || null;
}

/**
 * 取区间时间：startSlot 起连续 slotCount 节
 * @returns {{start:string, end:string}|null}
 */
function getRangeTime(startSlot, slotCount) {
  const timeline = buildTimeline();
  const s = Number(startSlot);
  const n = Number(slotCount) || 1;
  const first = timeline.slots.find((x) => x.slot === s);
  const last = timeline.slots.find((x) => x.slot === s + n - 1);
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

/**
 * 节次时间文本
 *   n <= 1 → "08:00-08:45"（完整区间）
 *   n > 1  → "08:00-09:40"（连堂合并）
 */
function formatSlotTime(slot, slotCount) {
  const n = Number(slotCount) || 1;
  const range = n <= 1
    ? (() => {
        const t = getSlotTime(slot);
        return t ? { start: t.start, end: t.end } : null;
      })()
    : getRangeTime(slot, n);

  if (!range) return '';
  return `${range.start}-${range.end}`;
}

/**
 * 生成渲染用的节次轴：在每个节次后按需插入休息分隔行
 *
 * @returns {Array<{type:'slot'|'break', slot?, start?, end?, label?}>}
 */
function buildSlotAxis(schedule) {
  const timeline = buildTimeline(schedule);
  const breakAfter = {};
  for (const b of timeline.breaks) {
    breakAfter[b.afterSlot] = b;
  }

  const axis = [];
  for (const s of timeline.slots) {
    axis.push({
      type: 'slot',
      slot: s.slot,
      start: s.start,
      end: s.end,
      segment: s.segment,
      segmentLabel: s.segmentLabel
    });

    if (breakAfter[s.slot]) {
      const b = breakAfter[s.slot];
      axis.push({
        type: 'break',
        label: b.label,
        start: b.start,
        end: b.end,
        time: b.end ? `${b.start}-${b.end}` : b.start,
        after: s.slot
      });
    }
  }

  return axis;
}

/**
 * 判断某节次之后是否有休息
 */
function getBreakAfter(slot) {
  const timeline = buildTimeline();
  return timeline.breaks.find((b) => b.afterSlot === Number(slot)) || null;
}

/**
 * 取当前总节数（用于校验课程是否越界）
 */
function getTotalSlots(schedule) {
  return buildTimeline(schedule).totalSlots;
}

/**
 * 时段分组（供设置页与统计展示）
 */
function buildSlotGroups(schedule) {
  return buildTimeline(schedule).segments;
}

module.exports = {
  toMinutes,
  toTimeStr,
  getSchedule,
  saveSchedule,
  resetSchedule,
  buildTimeline,
  getSlotTime,
  getRangeTime,
  formatSlotTime,
  buildSlotAxis,
  buildSlotGroups,
  getBreakAfter,
  getTotalSlots,
  SCHEDULE_STORAGE_KEY
};
