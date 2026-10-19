/**
 * lib/schedule.js —— 节次 → 起止时间（云函数内复刻版）
 *
 * ⚠️ 与 miniprogram/utils/schedule.js 的 buildTimeline 同源。
 *    云函数读不到小程序的本地配置，所以这里内置一份默认作息；
 *    若用户改过节次设置，小程序端会把自定义作息写进 profile 一并传过来
 *    （见 index.js 的 feedConfig.schedule），此时以传入的为准。
 *
 * 一节 = 一个「大节」：高校课堂按大节上课，默认 95 分钟（45+45 与中间休息）。
 */
const pad = (n) => String(n).padStart(2, '0');

/** 默认作息：与 miniprogram/config.js 的 SCHEDULE 保持一致 */
const DEFAULT_SCHEDULE = {
  segments: [
    { key: 'morning', label: '上午', slots: 2, startFirst: '08:00', duration: 95 },
    { key: 'afternoon', label: '下午', slots: 2, startFirst: '14:00', duration: 95 },
    { key: 'evening', label: '晚间', slots: 2, startFirst: '19:00', duration: 95 }
  ],
  breakWithinSegment: 20
};

function toMinutes(timeStr) {
  const p = String(timeStr || '').split(':');
  return Number(p[0]) * 60 + Number(p[1] || 0);
}

function toTimeStr(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * 生成节次时间轴
 * @returns {{slots: Array<{slot:number, start:string, end:string}>}}
 */
function buildTimeline(cfg) {
  const c = cfg || DEFAULT_SCHEDULE;
  const segments = c.segments || [];
  const within = Number(c.breakWithinSegment) || 0;

  const slots = [];
  let slotNo = 0;

  for (const seg of segments) {
    const count = Math.max(0, Number(seg.slots) || 0);
    if (count === 0) continue;

    const duration = Number(seg.duration) || 45;
    let cursor = toMinutes(seg.startFirst);

    for (let k = 0; k < count; k++) {
      slotNo += 1;
      slots.push({
        slot: slotNo,
        start: toTimeStr(cursor),
        end: toTimeStr(cursor + duration)
      });
      cursor = cursor + duration + within;
    }
  }

  return { slots };
}

/**
 * 取区间时间：startSlot 起连续 slotCount 节
 * @returns {{start:string, end:string}|null}
 */
function getRangeTime(startSlot, slotCount, cfg) {
  const timeline = buildTimeline(cfg);
  const s = Number(startSlot);
  const n = Number(slotCount) || 1;
  const first = timeline.slots.find((x) => x.slot === s);
  const last = timeline.slots.find((x) => x.slot === s + n - 1);
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

module.exports = { buildTimeline, getRangeTime, DEFAULT_SCHEDULE };
