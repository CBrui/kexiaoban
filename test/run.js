/**
 * test/run.js —— 核心算法单元测试（Node 可直接运行）
 *
 * 覆盖文档中标注的全部高风险点：
 *   - 单双周解析与展开（周次维度）
 *   - 空闲对齐（单双周不得误判为每周占用）
 *   - 免打扰六步优先级（调休日 vs 节假日）
 *
 * 运行：node test/run.js
 */
const path = require('path');

// 最小化 wx 全局桩，使业务模块可在 Node 下 require
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  removeStorageSync: () => {},
  cloud: null
};

const M = path.resolve(__dirname, '../miniprogram');
const {
  parseWeeks,
  formatWeeks,
  weekToDate,
  formatDate,
  startOfDay,
  daysBetween,
  weekdayOf,
  currentWeekOf,
  todayPosition,
  currentTimeStr,
  isToday
} = require(path.join(M, 'utils/week'));
const { expandCourse, expandAll, toWeekGrid } = require(path.join(M, 'logic/course-expand'));
const { alignFree, alignFreeWithRange, alignGrid, alignFreeMulti, alignGridMulti, isCounterpartEmpty } = require(path.join(M, 'logic/free-align'));
const { shouldNotify, shouldNotifyWithCalendar, buildCalendarIndex, inSilentRange } = require(path.join(M, 'logic/dnd-rule'));
const { colorOf, softOf, buildColorMap, PALETTE } = require(path.join(M, 'utils/color'));
const schedule = require(path.join(M, 'utils/schedule'));
const { normalizeProfile } = require(path.join(M, 'api/profile'));

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实际 ${a}`);
}

function group(title) {
  console.log(`\n${title}`);
}

/* ============ 1. 周次解析 ============ */
group('【1】周次解析 parseWeeks');
eq('1-16 → 连续 16 周', parseWeeks('1-16'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
eq('1-16 单 → 奇数周', parseWeeks('1-16 单'), [1,3,5,7,9,11,13,15]);
eq('1-16 双 → 偶数周', parseWeeks('1-16 双'), [2,4,6,8,10,12,14,16]);
eq('3,5,7 → 指定周次', parseWeeks('3,5,7'), [3,5,7]);
eq('1-8,10-16 → 多段区间', parseWeeks('1-8,10-16'), [1,2,3,4,5,6,7,8,10,11,12,13,14,15,16]);
eq('1-16单（无空格）→ 奇数周', parseWeeks('1-16单'), [1,3,5,7,9,11,13,15]);
eq('空字符串 → 空数组', parseWeeks(''), []);
eq('undefined → 空数组', parseWeeks(undefined), []);
eq('"第1-16周" → 容错解析', parseWeeks('1-16周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);

/* ============ 2. 周次格式化 ============ */
group('【2】周次格式化 formatWeeks');
eq('连续区间折叠', formatWeeks([1,2,3,4,6,7]), '1-4,6-7');
eq('单点不折叠', formatWeeks([3]), '3');
eq('空数组', formatWeeks([]), '');

/* ============ 3. 课程展开（核心） ============ */
group('【3】课程展开 expandCourse —— 周次维度是关键');
const singleWeekCourse = { day_of_week: 1, start_slot: 1, slot_count: 2, weeks: '1-16 单' };
const singlePoints = expandCourse(singleWeekCourse);
ok('单周课程只展开奇数周', singlePoints.every((p) => Number(p.split('-')[0]) % 2 === 1), singlePoints.slice(0, 4).join(','));
eq('单周课程点数 = 8 周 × 2 节', singlePoints.length, 16);
ok('包含第 1 周周一第 1 节', singlePoints.indexOf('1-1-1') !== -1);
ok('不包含第 2 周（偶数周）', singlePoints.indexOf('2-1-1') === -1);

const fullCourse = { day_of_week: 3, start_slot: 5, slot_count: 3, weeks: '1-16' };
const fullPoints = expandCourse(fullCourse);
eq('全周课程点数 = 16 × 3', fullPoints.length, 48);
ok('包含第 16 周周三第 7 节', fullPoints.indexOf('16-3-7') !== -1);

/* ============ 4. 占用集合并 ============ */
group('【4】占用集合并 expandAll');
const merged = expandAll([singleWeekCourse, fullCourse]);
ok('并集包含单周课的点', merged.has('1-1-1'));
ok('并集包含全周课的点', merged.has('1-3-5'));
ok('并集基数正确', merged.size === 16 + 48, `实际 ${merged.size}`);

/* ============ 5. 周网格 ============ */
group('【5】周网格 toWeekGrid');
const grid = toWeekGrid(merged, [1, 2]);
eq('周网格覆盖两周', Object.keys(grid).length, 2);
ok('第 1 周周一第 1 节被占用', grid[1][0][0] === true);
ok('第 2 周周一第 1 节空闲（单周课不占偶数周）', grid[2][0][0] === false);

/* ============ 6. 空闲对齐（核心风险） ============ */
group('【6】空闲对齐 alignFree —— 单双周不得误判');
// A 单周周一 1-2 节有课；B 完全没有周一课
const A = [{ day_of_week: 1, start_slot: 1, slot_count: 2, weeks: '1-16 单' }];
const B = [{ day_of_week: 3, start_slot: 1, slot_count: 2, weeks: '1-16' }];

const align = alignFree(A, B);
const week2 = align.result.find((r) => r.week === 2);
const week1 = align.result.find((r) => r.week === 1);

ok('第 2 周周一第 1 节是共同空闲（A 单周课不占偶数周）',
  !!week2 && week2.slots.some((s) => s.day === 1 && s.from === 1),
  JSON.stringify(week2));

ok('第 1 周周一第 1 节不是空闲（A 单周课占用）',
  !!week1 && !week1.slots.some((s) => s.day === 1 && s.from === 1),
  JSON.stringify(week1));

/* ============ 7. 完全冲突场景 ============ */
group('【7】无共同空闲场景');
const C = [{ day_of_week: 1, start_slot: 1, slot_count: 12, weeks: '1-1' }];
const D = [{ day_of_week: 1, start_slot: 1, slot_count: 12, weeks: '1-1' }];
const conflict = alignFree(C, D);
const week1Conflict = conflict.result.find((r) => r.week === 1);
ok('完全冲突时该周无共同空闲时段',
  !week1Conflict || !week1Conflict.slots.some((s) => s.day === 1),
  JSON.stringify(week1Conflict));

/* ============ 8. 起床/就寝节次裁剪 ============ */
group('【8】起床/就寝节次裁剪');
// 双方各有一门周一的课，制造出全周（除周一被占部分）的空闲，再裁剪到 3-5 节
const trimA = [{ day_of_week: 1, start_slot: 1, slot_count: 2, weeks: '1-2' }];
const trimB = [{ day_of_week: 2, start_slot: 1, slot_count: 2, weeks: '1-2' }];
const clipped = alignFreeWithRange(trimA, trimB, { wakeSlot: 3, sleepSlot: 5 });
ok('裁剪后时段限制在 3-5 节',
  clipped.length > 0 && clipped.every((w) => w.slots.every((s) => s.from >= 3 && s.to <= 5)),
  JSON.stringify(clipped[0]));

// 双方都无课程时，周次集合为空 —— 结果应为空（由 isCounterpartEmpty 兜底提示）
const clippedEmpty = alignFreeWithRange([], [], { wakeSlot: 3, sleepSlot: 5 });
ok('双方均无课程时结果为空', clippedEmpty.length === 0, JSON.stringify(clippedEmpty));

/* ============ 9. 对方未建课表 ============ */
group('【9】对方未建课表判定');
ok('空数组 → true', isCounterpartEmpty([]) === true);
ok('undefined → true', isCounterpartEmpty(undefined) === true);
ok('有课程 → false', isCounterpartEmpty([{ id: 1 }]) === false);

/* ============ 10. 免打扰判定（六步优先级） ============ */
group('【10】免打扰六步优先级 shouldNotify');
const baseCfg = { silentDates: [], silentRanges: [], silentCourses: [], globalMute: false };
const baseCtx = { date: '2026-10-12', timeStr: '09:45', userConfig: baseCfg, course: { id: 1 } };

ok('普通日 → 正常提醒', shouldNotify(baseCtx).notify === true);

ok('法定节假日 → 不提醒',
  shouldNotify({ ...baseCtx, isHoliday: true }).notify === false);

ok('自定义不提醒日期 → 不提醒',
  shouldNotify({ ...baseCtx, userConfig: { ...baseCfg, silentDates: ['2026-10-12'] } }).notify === false);

ok('落入免打扰时段 → 不提醒',
  shouldNotify({ ...baseCtx, timeStr: '12:30', userConfig: { ...baseCfg, silentRanges: [{ from: '12:00', to: '14:00' }] } }).notify === false);

ok('调休补课日 → 正常提醒',
  shouldNotify({ ...baseCtx, isMakeupWorkday: true }).notify === true);

ok('该课程静音 → 不提醒',
  shouldNotify({ ...baseCtx, userConfig: { ...baseCfg, silentCourses: [1] } }).notify === false);

ok('全局关闭 → 不提醒',
  shouldNotify({ ...baseCtx, userConfig: { ...baseCfg, globalMute: true } }).notify === false);

/* ============ 11. 优先级冲突（最高风险点） ============ */
group('【11】优先级冲突 —— 第 1 步 vs 第 4 步');
// 场景：调休补课日，但用户同时设置了该日不提醒 → 应按第 2 步静默
const r1 = shouldNotify({
  date: '2026-09-27',
  timeStr: '09:45',
  isMakeupWorkday: true,
  userConfig: { ...baseCfg, silentDates: ['2026-09-27'] },
  course: { id: 1 }
});
ok('调休日 + 自定义不提醒 → 按第 2 步静默', r1.notify === false, r1.reason);

// 场景：法定节假日落在周末 → 最高优先级静默
const r2 = shouldNotify({
  date: '2026-10-03',
  timeStr: '09:45',
  isHoliday: true,
  isMakeupWorkday: false,
  userConfig: baseCfg,
  course: { id: 1 }
});
ok('法定节假日落在周末 → 静默', r2.notify === false, r2.reason);

// 场景：节假日 + 调休标记同时存在（数据异常）→ 节假日优先
const r3 = shouldNotify({
  date: '2026-10-01',
  timeStr: '09:45',
  isHoliday: true,
  isMakeupWorkday: true,
  userConfig: baseCfg,
  course: { id: 1 }
});
ok('节假日与调休同时标记 → 节假日优先静默', r3.notify === false, r3.reason);

/* ============ 12. 日历索引判定 ============ */
group('【12】结合日历索引判定');
const calendar = buildCalendarIndex([
  { date: '2026-10-01', type: 'holiday' },
  { date: '2026-09-27', type: 'makeup' }
]);
ok('10-01 识别为节假日 → 静默',
  shouldNotifyWithCalendar({ ...baseCtx, date: '2026-10-01' }, calendar).notify === false);
ok('09-27 识别为调休 → 提醒',
  shouldNotifyWithCalendar({ ...baseCtx, date: '2026-09-27' }, calendar).notify === true);
ok('10-12 普通日 → 提醒',
  shouldNotifyWithCalendar({ ...baseCtx, date: '2026-10-12' }, calendar).notify === true);

/* ============ 13. 时间区间判定 ============ */
group('【13】免打扰时段区间 inSilentRange');
ok('12:30 落在 12:00-14:00', inSilentRange('12:30', [{ from: '12:00', to: '14:00' }]) === true);
ok('15:00 不在区间', inSilentRange('15:00', [{ from: '12:00', to: '14:00' }]) === false);
ok('边界 12:00 命中', inSilentRange('12:00', [{ from: '12:00', to: '14:00' }]) === true);
ok('空区间不命中', inSilentRange('12:00', []) === false);

/* ============ 14. 日期换算 ============ */
group('【14】周次 → 日期换算');
const d1 = weekToDate('2026-09-07', 1, 1);
eq('第 1 周周一 = 学期起始日', formatDate(d1), '2026-09-07');
const d2 = weekToDate('2026-09-07', 1, 7);
eq('第 1 周周日 = 09-13', formatDate(d2), '2026-09-13');
const d3 = weekToDate('2026-09-07', 3, 3);
eq('第 3 周周三 = 09-23', formatDate(d3), '2026-09-23');

/* ============ 15. 颜色哈希稳定性 ============ */
group('【15】课程名哈希取色');
ok('同名课程颜色一致', colorOf('高等数学') === colorOf('高等数学'));
ok('返回合法色值', /^#[0-9A-Fa-f]{6}$/.test(colorOf('英语')));
ok('空名称有兜底', /^#[0-9A-Fa-f]{6}$/.test(colorOf('')));

/* ============ 16. 作息时间工具（动态时间轴） ============ */
group('【16】作息时间 schedule — 大节模型动态生成');
eq('总节数 = 6（默认 2+2+2）', schedule.getTotalSlots(), 6);
eq('第 1 节完整区间（大节 95 分钟）', schedule.formatSlotTime(1, 1), '08:00-09:35');
eq('第 6 节完整区间', schedule.formatSlotTime(6, 1), '20:55-22:30');
eq('连堂区间（1-2 节）', schedule.formatSlotTime(1, 2), '08:00-11:30');
eq('连堂区间（3-4 节）', schedule.formatSlotTime(3, 2), '14:00-17:30');
eq('不存在的节次返回空', schedule.formatSlotTime(99, 1), '');

group('【17】时段分组与休息');
const tl = schedule.buildTimeline();
eq('分为上午/下午/晚间三段', tl.segments.length, 3);
eq('上午时段范围', `${tl.segments[0].start}-${tl.segments[0].end}`, '08:00-11:30');
eq('下午时段范围', `${tl.segments[1].start}-${tl.segments[1].end}`, '14:00-17:30');
eq('晚间时段范围', `${tl.segments[2].start}-${tl.segments[2].end}`, '19:00-22:30');
eq('午休', `${tl.breaks[0].label} ${tl.breaks[0].start}-${tl.breaks[0].end}`, '午休 11:30-14:00');
eq('晚休', `${tl.breaks[1].label} ${tl.breaks[1].start}-${tl.breaks[1].end}`, '晚休 17:30-19:00');

group('【18】自定义节数的边界情况');
// 上午 6 节、下午 2 节、晚间 0 节
const custom = schedule.buildTimeline({
  segments: [
    { key: 'morning', label: '上午', slots: 6, startFirst: '08:00', duration: 45 },
    { key: 'afternoon', label: '下午', slots: 2, startFirst: '14:00', duration: 45 },
    { key: 'evening', label: '晚间', slots: 0, startFirst: '19:00', duration: 45 }
  ],
  breakWithinSegment: 10,
  segmentBreaks: [{ afterKey: 'morning', label: '午休' }]
});
eq('总节数 = 8（6+2+0）', custom.totalSlots, 8);
eq('节数为 0 的时段不产生行', custom.segments.length, 2);
// 上午 6 节：08:00 起，每节 45 分 + 课间 10 分 = 55 分步进
//   第 1 节 08:00-08:45，第 6 节 = 08:00 + 5×55 = 12:35
eq('上午第 6 节时间', `${custom.slots[5].start}-${custom.slots[5].end}`, '12:35-13:20');
ok('第 6 节后有午休', custom.breaks.some((b) => b.afterSlot === 6 && b.label === '午休'));
ok('不存在第 9 节', !custom.slots.some((s) => s.slot === 9));

// 全部为 0 的极端情况
const zero = schedule.buildTimeline({
  segments: [{ key: 'morning', label: '上午', slots: 0, startFirst: '08:00', duration: 45 }],
  breakWithinSegment: 10,
  segmentBreaks: []
});
eq('全部为 0 时总节数为 0', zero.totalSlots, 0);

group('【19】节次轴与休息插入');
const axis = schedule.buildSlotAxis();
const slotRows = axis.filter((r) => r.type === 'slot');
const breakRows = axis.filter((r) => r.type === 'break');
eq('节次行数 = 6', slotRows.length, 6);
eq('休息行数 = 2', breakRows.length, 2);
ok('午休插在第 2 节之后',
  axis.findIndex((r) => r.type === 'break' && r.label === '午休') ===
  axis.findIndex((r) => r.type === 'slot' && r.slot === 2) + 1);
ok('晚休插在第 4 节之后',
  axis.findIndex((r) => r.type === 'break' && r.label === '晚休') ===
  axis.findIndex((r) => r.type === 'slot' && r.slot === 4) + 1);
eq('每节都有起止时间', slotRows.every((r) => r.start && r.end), true);
eq('休息带含时间区间', breakRows[0].time, '11:30-14:00');

group('【20】时间换算辅助');
eq('toMinutes 08:00', schedule.toMinutes('08:00'), 480);
eq('toTimeStr 480', schedule.toTimeStr(480), '08:00');
eq('跨小时换算', schedule.toTimeStr(schedule.toMinutes('13:05')), '13:05');
eq('第 2 节后有休息（午休）', schedule.getBreakAfter(2) !== null, true);
eq('第 4 节后有休息（晚休）', schedule.getBreakAfter(4) !== null, true);
eq('第 1 节后无休息', schedule.getBreakAfter(1) === null, true);
eq('第 3 节后无休息', schedule.getBreakAfter(3) === null, true);

/* ============ 21. 自动定位到今天（当前周 / 当前星期） ============ */
group('【21】按「今天」自动定位 —— 当前周与星期');
const TERM_START = '2026-09-07'; // 周一

// 基准：学期起始日当天
eq('开学当天 → 第 1 周', currentWeekOf(TERM_START, new Date('2026-09-07T09:00:00')), 1);
eq('开学当天是周一', weekdayOf(new Date('2026-09-07T09:00:00')), 1);

// 第 1 周内任意一天都是第 1 周
eq('第 1 周周日仍在第 1 周', currentWeekOf(TERM_START, new Date('2026-09-13T23:00:00')), 1);
// 第 2 周周一是 09-14
eq('09-14 → 第 2 周', currentWeekOf(TERM_START, new Date('2026-09-14T00:00:00')), 2);
// 第 3 周周三 = 09-23
eq('09-23 → 第 3 周', currentWeekOf(TERM_START, new Date('2026-09-23T14:30:00')), 3);
// 第 5 周 = 10-05 ~ 10-11
eq('10-09 → 第 5 周', currentWeekOf(TERM_START, new Date('2026-10-09T13:00:00')), 5);
eq('10-09 是周五', weekdayOf(new Date('2026-10-09T13:00:00')), 5);

// 边界：开学前一天 → 回退到第 1 周
eq('开学前一天 → 兜底第 1 周', currentWeekOf(TERM_START, new Date('2026-09-06T10:00:00')), 1);
// 边界：超出学期总周数 → 停在最后一周
eq('超出总周数 → 停在最后一周', currentWeekOf(TERM_START, new Date('2027-06-01T10:00:00'), 20), 20);

/* ============ 22. todayPosition 综合定位 ============ */
group('【22】todayPosition —— 学期内外的判定');
const posIn = todayPosition(TERM_START, new Date('2026-10-09T13:48:00'), 20);
eq('学期内 → week=5', posIn.week, 5);
eq('学期内 → dayOfWeek=5', posIn.dayOfWeek, 5);
eq('学期内 → inTerm=true', posIn.inTerm, true);
eq('学期内 → date=2026-10-09', posIn.date, '2026-10-09');

const posBefore = todayPosition(TERM_START, new Date('2026-08-01T10:00:00'), 20);
eq('开学前 → inTerm=false', posBefore.inTerm, false);
eq('开学前 → week 兜底为 1', posBefore.week, 1);

const posAfter = todayPosition(TERM_START, new Date('2027-03-01T10:00:00'), 20);
eq('学期后 → inTerm=false', posAfter.inTerm, false);
eq('学期后 → week 停在 20', posAfter.week, 20);

/* ============ 23. isToday 列定位 ============ */
group('【23】isToday —— 表头/列高亮定位');
const refDay = new Date('2026-10-09T13:48:00'); // 第 5 周周五
ok('第 5 周周五 = 今天', isToday(TERM_START, 5, 5, refDay) === true);
ok('第 5 周周四 ≠ 今天', isToday(TERM_START, 5, 4, refDay) === false);
ok('第 4 周周五 ≠ 今天', isToday(TERM_START, 4, 5, refDay) === false);

/* ============ 24. 日期差与时刻 ============ */
group('【24】日期差与当前时刻');
eq('同一天差值为 0', daysBetween(new Date('2026-10-09T08:00:00'), new Date('2026-10-09T23:00:00')), 0);
eq('跨一天差值为 1', daysBetween(new Date('2026-10-09T08:00:00'), new Date('2026-10-10T01:00:00')), 1);
eq('跨一周差值为 7', daysBetween(new Date('2026-10-09T08:00:00'), new Date('2026-10-16T08:00:00')), 7);
eq('startOfDay 抹掉时分秒', formatDate(startOfDay(new Date('2026-10-09T23:59:59'))), '2026-10-09');
eq('currentTimeStr 补零', currentTimeStr(new Date('2026-10-09T08:05:00')), '08:05');
eq('currentTimeStr 晚间', currentTimeStr(new Date('2026-10-09T19:30:00')), '19:30');

/* ============ 25. 多课表：数据层 ============ */
// 多课表测试需要一个「可用的」wx.storage —— 前面的桩把 getStorageSync 固定返回 null，
// 这里换成内存实现，才能真正跑通 store → timetable 的读写链路。
const memStore = new Map();
global.wx.getStorageSync = (k) => (memStore.has(k) ? memStore.get(k) : '');
global.wx.setStorageSync = (k, v) => { memStore.set(k, v); };
global.wx.removeStorageSync = (k) => { memStore.delete(k); };

const timetableApi = require(path.join(M, 'api/timetable'));
const storeApi = require(path.join(M, 'api/store'));

(async () => {
  group('【25】多课表 —— 校验与边界');
  eq('总周次下限夹紧', timetableApi.clampTotalWeeks(0), 1);
  eq('总周次上限夹紧', timetableApi.clampTotalWeeks(999), 30);
  eq('总周次非法值回退默认', timetableApi.clampTotalWeeks('abc'), 20);
  eq('总周次字符串数字可用', timetableApi.clampTotalWeeks('18'), 18);
  eq('总周次小数取整', timetableApi.clampTotalWeeks(16.9), 16);

  group('【26】ensureDefaultTimetable —— 首次创建与幂等');
  const first = await timetableApi.ensureDefaultTimetable();
  ok('首次调用创建出课表', !!first && !!first.id);
  const afterFirst = await timetableApi.listTimetables();
  eq('首次创建后共 1 张课表', afterFirst.length, 1);
  eq('默认课表总周次 = 20', first.total_weeks, 20);
  eq('默认课表开课日期取 config', first.term_start_monday, '2026-09-07');
  eq('默认课表被标记为当前', !!first.is_current, true);

  const second = await timetableApi.ensureDefaultTimetable();
  eq('重复调用不新建（幂等）', (await timetableApi.listTimetables()).length, 1);
  eq('重复调用返回同一张', String(second.id), String(first.id));

  group('【27】历史课程迁移 —— 无 timetable_id 归入默认课表');
  // 模拟升级前遗留的课程：有数据但没有 timetable_id
  await storeApi.insert('courses', { name: '高等数学', start_slot: 1, slot_count: 2 });
  await storeApi.insert('courses', { name: '大学英语', start_slot: 3, slot_count: 1 });
  // 清掉迁移标记，让 migrateOrphanCourses 重新执行一次
  memStore.delete('kxb:migrated_multi_timetable');

  const migrated = await timetableApi.ensureDefaultTimetable();
  const ownedCourses = await timetableApi.listCoursesOf(migrated.id);
  eq('两门历史课程被迁移过来', ownedCourses.length, 2);
  ok('迁移后课程带 timetable_id',
    ownedCourses.every((c) => String(c.timetable_id) === String(migrated.id)));

  group('【28】新建课表与当前课表指针');
  const t2 = await timetableApi.addTimetable({
    name: '下学期课表',
    term_start_monday: '2027-02-22',
    total_weeks: 18
  });
  eq('新建后共 2 张课表', (await timetableApi.listTimetables()).length, 2);
  eq('非首张不会被自动设为当前', !!t2.is_current, false);
  eq('当前课表仍是第一张', String((await timetableApi.getCurrentTimetable()).id), String(first.id));

  await timetableApi.setCurrent(t2.id);
  const nowCurrent = await timetableApi.getCurrentTimetable();
  eq('切换后当前课表 = 第二张', String(nowCurrent.id), String(t2.id));
  const allAfterSwitch = await timetableApi.listTimetables();
  eq('is_current 全局唯一（只有 1 张为 true）',
    allAfterSwitch.filter((t) => t.is_current).length, 1);

  group('【29】按课表隔离课程');
  await storeApi.insert('courses', {
    name: '线性代数', start_slot: 1, slot_count: 1, timetable_id: String(t2.id)
  });
  const t1Courses = await timetableApi.listCoursesOf(first.id);
  const t2Courses = await timetableApi.listCoursesOf(t2.id);
  eq('第一张课表仍有 2 门', t1Courses.length, 2);
  eq('第二张课表有 1 门', t2Courses.length, 1);
  eq('第二张课表课程数统计', await timetableApi.countCoursesOf(t2.id), 1);
  ok('两张课表课程不互相污染',
    !t2Courses.some((c) => c.name === '高等数学') &&
    !t1Courses.some((c) => c.name === '线性代数'));

  group('【30】修改课表配置');
  await timetableApi.updateTimetable(t2.id, { total_weeks: 22, name: '春季学期' });
  const t2Updated = await timetableApi.getTimetable(t2.id);
  eq('总周次可改', t2Updated.total_weeks, 22);
  eq('名称可改', t2Updated.name, '春季学期');
  eq('开课日期未被误改', t2Updated.term_start_monday, '2027-02-22');

  await timetableApi.updateTimetable(t2.id, { total_weeks: 999 });
  eq('修改时同样夹紧上限', (await timetableApi.getTimetable(t2.id)).total_weeks, 30);

  group('【31】结束日期换算');
  const t1Now = await timetableApi.getTimetable(first.id);
  eq('第 20 周周日 = 开课后 139 天',
    formatDate(timetableApi.endDateOf(t1Now)), '2027-01-24');
  eq('第 1 周周日 = 开课后 6 天',
    formatDate(timetableApi.endDateOf({ term_start_monday: '2026-09-07', total_weeks: 1 })),
    '2026-09-13');

  group('【32】删除课表 —— 级联删课程与指针转移');
  const beforeDel = (await timetableApi.listCoursesOf(t2.id)).length;
  eq('删除前第二张课表有 1 门课程', beforeDel, 1);
  const delResult = await timetableApi.removeTimetable(t2.id);
  eq('返回一并删除的课程数', delResult.removedCourses, 1);
  eq('课程确实被删干净', (await timetableApi.listCoursesOf(t2.id)).length, 0);
  eq('剩余课表数 = 1', (await timetableApi.listTimetables()).length, 1);

  const afterDelCurrent = await timetableApi.getCurrentTimetable();
  eq('当前指针自动挪到剩余课表', String(afterDelCurrent.id), String(first.id));
  eq('第一张课表课程未受影响',
    (await timetableApi.listCoursesOf(first.id)).length, 2);

  /* ============ 归一化档案身份（openid 隐患回归） ============ */
  group('【33】档案身份归一化 normalizeProfile');
  eq('本地模式：保留已有 owner_id',
    normalizeProfile({ id: 1, owner_id: 'local-ab12', nickname: '我' }).owner_id, 'local-ab12');
  eq('云模式：用平台 _openid 补上 owner_id',
    normalizeProfile({ _id: 'doc1', _openid: 'oABC123', invite_code: 'AAA111' }).owner_id, 'oABC123');
  eq('云模式：已回填的 owner_id 优先于 _openid',
    normalizeProfile({ _id: 'doc1', _openid: 'oABC123', owner_id: 'oABC123' }).owner_id, 'oABC123');
  eq('云端新建档案（无 owner_id / _openid）→ 兜底用 _id',
    normalizeProfile({ _id: 'doc2', invite_code: 'BBB222' }).owner_id, 'doc2');
  ok('本地记录（无 _openid）→ 兜底用 id',
    normalizeProfile({ id: 7 }).owner_id === 7);
  eq('null 安全', normalizeProfile(null), null);
  ok('归一化后一定不再是 undefined 身份',
    !!normalizeProfile({ _openid: 'oX' }).owner_id);

  /* ============ 34. 云文档主键归一化（_id → id） ============ */
  // 云模式专属坑：云端主键叫 _id、本地叫 id，读云文档时必须补 id，
  // 否则 doc(t.id) 会抛 "docId must not be empty"。本地模式跑不出来，必须显式覆盖。
  group('【34】云文档 _id → id 归一化');
  const { withId, withIds } = require(path.join(M, 'api/doc'));

  eq('云文档补上 id = _id', withId({ _id: 'abc', name: 'x' }).id, 'abc');
  const normedDoc = withId({ _id: 'abc', name: 'x' });
  ok('原字段完整保留', normedDoc.name === 'x' && normedDoc._id === 'abc');
  eq('本地记录已有 id，不被 _id 覆盖', withId({ id: 7, _id: 'abc' }).id, 7);
  eq('既无 id 也无 _id 时 id 为 undefined', withId({ name: 'y' }).id, undefined);
  eq('空值原样返回(null)', withId(null), null);
  ok('空值原样返回(undefined)', withId(undefined) === undefined);
  eq('批量归一化', withIds([{ _id: 'a' }, { _id: 'b' }]).map((d) => d.id).join(','), 'a,b');
  eq('空数组安全', withIds(undefined).length, 0);
  ok('不修改原对象（纯函数）', (() => {
    const src = { _id: 'z' };
    withId(src);
    return src.id === undefined;
  })());

  /* ============ 35. 找搭子走云函数（云模式） ============ */
  // courses / profiles 都是「仅创建者可读写」(PRIVATE)。云模式下按邀请码找同学、
  // 读对方课程若走客户端直查只会得到空 → 必须走云函数 findBuddy（服务端管理权限）。
  // 该类问题本地模式跑不出来，必须显式覆盖云分支。
  group('【35】找搭子走云函数（云模式）');

  const cloudCalls = [];
  global.wx.cloud = {
    init() {},
    database() {
      throw new Error('云模式下找搭子不应再走客户端直查');
    },
    callFunction({ name, data }) {
      cloudCalls.push({ name, data });
      if (data.action === 'findProfile') {
        if (data.inviteCode === 'NOPE00') {
          return Promise.resolve({ result: { ok: true, profile: null } });
        }
        return Promise.resolve({
          result: { ok: true, profile: { owner_id: 'oFRIEND', nickname: '小明' } }
        });
      }
      if (data.action === 'getCourses') {
        if (data.friendOwnerId === 'oSTRANGER') {
          return Promise.resolve({
            result: { ok: false, error: 'NO_RELATION', message: '尚未与该同学建立关系' }
          });
        }
        // 没建课表：无课表、无课程
        if (data.friendOwnerId === 'oNOTIMETABLE') {
          return Promise.resolve({
            result: { ok: true, courses: [], hasTimetable: false }
          });
        }
        // 建了课表但还没录课程：有课表、课程为空
        if (data.friendOwnerId === 'oEMPTYTABLE') {
          return Promise.resolve({
            result: { ok: true, courses: [], hasTimetable: true }
          });
        }
        return Promise.resolve({
          result: {
            ok: true,
            hasTimetable: true,
            courses: [
              { _id: 'c1', name: '高等数学', day_of_week: 1, start_slot: 1, slot_count: 2, weeks: '1-16' }
            ]
          }
        });
      }
      return Promise.resolve({ result: { ok: false, error: 'UNKNOWN_ACTION' } });
    }
  };

  const clientApi = require(path.join(M, 'api/client'));
  const courseApi = require(path.join(M, 'api/course'));
  const profileApi = require(path.join(M, 'api/profile'));
  clientApi.initClient({ useCloud: true, envId: 'test-env' });
  eq('客户端已切到云模式', clientApi.getMode(), 'cloud');

  const found = await profileApi.findByInviteCode('abc123');
  let lastCall = cloudCalls[cloudCalls.length - 1];
  eq('按邀请码找同学走云函数', lastCall.name, 'findBuddy');
  eq('动作为 findProfile', lastCall.data.action, 'findProfile');
  eq('邀请码已归一化为大写', lastCall.data.inviteCode, 'ABC123');
  eq('返回同学档案带 owner_id', found && found.owner_id, 'oFRIEND');

  const notFound = await profileApi.findByInviteCode('nope00');
  eq('邀请码查不到 → 返回 null', notFound, null);

  const friendCourses = await courseApi.listCoursesByOwner('oFRIEND');
  lastCall = cloudCalls[cloudCalls.length - 1];
  eq('读对方课程走云函数', lastCall.name, 'findBuddy');
  eq('动作为 getCourses', lastCall.data.action, 'getCourses');
  eq('云函数收到对方身份', lastCall.data.friendOwnerId, 'oFRIEND');
  eq('课程记录补上 id（_id 归一化）', friendCourses[0].id, 'c1');
  eq('课程内容正确', friendCourses[0].name, '高等数学');

  // fetchFriendCourses 额外回传 hasTimetable，供页面区分两类「没录课程」
  const friendEntry = await courseApi.fetchFriendCourses('oFRIEND');
  eq('fetchFriendCourses 回传课程数组', friendEntry.courses.length, 1);
  eq('fetchFriendCourses 回传 hasTimetable=true', friendEntry.hasTimetable, true);

  const noTable = await courseApi.fetchFriendCourses('oNOTIMETABLE');
  eq('对方没建课表 → 课程为空', noTable.courses.length, 0);
  eq('对方没建课表 → hasTimetable=false', noTable.hasTimetable, false);

  const emptyTable = await courseApi.fetchFriendCourses('oEMPTYTABLE');
  eq('对方建了课表但没录课程 → 课程为空', emptyTable.courses.length, 0);
  eq('对方建了课表但没录课程 → hasTimetable=true', emptyTable.hasTimetable, true);

  eq('listCoursesByOwner 仍只返回数组（旧调用方兼容）',
    Array.isArray(await courseApi.listCoursesByOwner('oFRIEND')), true);

  let relationErr = '';
  try {
    await courseApi.listCoursesByOwner('oSTRANGER');
  } catch (e) {
    relationErr = String((e && e.message) || e);
  }
  ok('未建立关系时抛出可读错误（不再静默返回空）',
    relationErr.indexOf('NO_RELATION') >= 0 || relationErr.indexOf('尚未') >= 0);

  /* ============ 36. 课程编辑（点击课程卡片修改参数） ============ */
  // 云模式下 updateCourse 走 doc(id).update —— 云端 id 是字符串文档 id，
  // 本地模式走 store.update（按 id 匹配）。两条路径都要覆盖。
  group('【36】课程编辑 updateCourse');

  // --- 云路径：先验证云模式下的调用形态 ---
  const updateCalls = [];
  global.wx.cloud.database = () => ({
    collection(name) {
      return {
        doc(id) {
          return {
            update({ data }) {
              updateCalls.push({ collection: name, id, data });
              return Promise.resolve({ stats: { updated: 1 } });
            }
          };
        }
      };
    }
  });

  const cloudPatch = await courseApi.updateCourse('docABC', {
    name: '高等数学（下）',
    day_of_week: 2,
    start_slot: 3,
    slot_count: 2,
    weeks: '1-16 单'
  });
  eq('云模式走 courses 集合', updateCalls[0].collection, 'courses');
  eq('云模式以 id 定位文档', updateCalls[0].id, 'docABC');
  eq('云模式提交编辑后的课程名', updateCalls[0].data.name, '高等数学（下）');
  eq('云模式提交星期（周一=1）', updateCalls[0].data.day_of_week, 2);
  eq('云模式提交开始节次', updateCalls[0].data.start_slot, 3);
  eq('云模式提交连续节数', updateCalls[0].data.slot_count, 2);
  eq('云模式提交周次规则', updateCalls[0].data.weeks, '1-16 单');
  eq('云模式返回体带 id', cloudPatch.id, 'docABC');

  // --- 本地路径：切回本地模式，验证字段真的落库 ---
  clientApi.initClient({ useCloud: false });
  eq('客户端已切回本地模式', clientApi.getMode(), 'local');

  const tmp = await courseApi.addCourse({
    name: '大学物理',
    teacher: '王老师',
    location: 'A101',
    day_of_week: 1,
    start_slot: 1,
    slot_count: 2,
    weeks: '1-16'
  });

  const edited = await courseApi.updateCourse(tmp.id, {
    name: '大学物理（实验）',
    teacher: '李老师',
    location: 'B203',
    day_of_week: 4,
    start_slot: 3,
    slot_count: 1,
    weeks: '3,5,7'
  });
  eq('本地模式返回编辑后的课程名', edited.name, '大学物理（实验）');
  eq('本地模式返回新星期', edited.day_of_week, 4);

  const reread = (await courseApi.listCourses()).find((c) => String(c.id) === String(tmp.id));
  ok('编辑后能重新读回该课程', !!reread);
  eq('落库：课程名已更新', reread.name, '大学物理（实验）');
  eq('落库：教师已更新', reread.teacher, '李老师');
  eq('落库：地点已更新', reread.location, 'B203');
  eq('落库：星期已更新', reread.day_of_week, 4);
  eq('落库：开始节次已更新', reread.start_slot, 3);
  eq('落库：连续节数已更新', reread.slot_count, 1);
  eq('落库：周次规则已更新', reread.weeks, '3,5,7');
  eq('编辑不改变课程总数', (await courseApi.listCourses()).filter(
    (c) => String(c.id) === String(tmp.id)).length, 1);

  // --- 边界：id 不存在时本地 store.update 返回 null（静默），不抛错 ---
  const missing = await courseApi.updateCourse(999999, { name: '不存在的课' });
  eq('本地模式：id 不存在返回 null', missing, null);

  /* ============ 37. AI 统一解析管线（api/ai.js） ============ */
  // 对话建表与图片识别共用同一条管线：预处理 → 大模型(流式) → Schema 校验 → 结构化课程。
  // 这里注入假模型（modelProvider）验证管线本身，不消耗真实 Token；
  // 真实模型只在真机/现网验证，不进单测。
  group('【37】AI 统一解析管线');

  const aiApi = require(path.join(M, 'api/ai'));

  // --- 预处理：全角标点会误导模型把一句拆成两门课，必须先归一化 ---
  eq('预处理：全角逗号转半角', aiApi.preprocess('周一高数，A301'), '周一高数,A301');
  eq('预处理：全角分号转半角', aiApi.preprocess('高数；英语'), '高数;英语');
  eq('预处理：压掉多余空白', aiApi.preprocess('  高数   英语  '), '高数 英语');
  ok('预处理：清掉零宽字符', aiApi.preprocess('高\u200B数') === '高数');
  eq('预处理：null 安全', aiApi.preprocess(null), '');

  // --- JSON 抽取：模型常裹 markdown 代码块或加前言，必须能兜底剥出来 ---
  eq('抽取：纯 JSON 数组', JSON.stringify(aiApi.extractJSON('[{"name":"高数"}]')), '[{"name":"高数"}]');
  eq('抽取：剥掉 ```json 代码块',
    aiApi.extractJSON('```json\n[{"name":"高数"}]\n```')[0].name, '高数');
  eq('抽取：带前言的响应',
    aiApi.extractJSON('好的，解析结果如下：\n[{"name":"高数"}]')[0].name, '高数');
  eq('抽取：完全不是 JSON 返回 null', aiApi.extractJSON('抱歉我不知道'), null);
  eq('抽取：空串返回 null', aiApi.extractJSON(''), null);

  // --- Schema 校验：合法输入原样通过 ---
  const okItem = aiApi.normalizeItem({
    name: '高等数学', day_of_week: 1, start_slot: 1, slot_count: 2,
    teacher: '王老师', location: 'A301', weeks: '1-16'
  }, 6);
  eq('校验：课程名保留', okItem.name, '高等数学');
  eq('校验：星期保留', okItem.day_of_week, 1);
  eq('校验：连续节数保留', okItem.slot_count, 2);
  eq('校验：合法项无缺失标记', okItem.missing_fields.length, 0);

  // --- 核心原则：不认识就留空 + 标记，绝不猜 ---
  const missingItem = aiApi.normalizeItem({ name: '大学物理' }, 6);
  eq('校验：缺失星期记为 0', missingItem.day_of_week, 0);
  eq('校验：缺失开始节次记为 0', missingItem.start_slot, 0);
  ok('校验：缺失项进 missing_fields',
    missingItem.missing_fields.indexOf('day_of_week') >= 0 &&
    missingItem.missing_fields.indexOf('start_slot') >= 0 &&
    missingItem.missing_fields.indexOf('weeks') >= 0);
  eq('校验：缺失时连续节数兜底为 1', missingItem.slot_count, 1);

  // --- 非法值必须被挡下，不能被当成合法值放过 ---
  const badDay = aiApi.normalizeItem({ name: 'X', day_of_week: 9, start_slot: 1, weeks: '1-16' }, 6);
  eq('校验：星期越界(9)判为缺失', badDay.day_of_week, 0);
  const badSlot = aiApi.normalizeItem({ name: 'X', day_of_week: 1, start_slot: 99, weeks: '1-16' }, 6);
  eq('校验：节次越界判为缺失', badSlot.start_slot, 0);
  const badWeeks = aiApi.normalizeItem({ name: 'X', day_of_week: 1, start_slot: 1, weeks: '瞎写的' }, 6);
  ok('校验：非法周次进 missing_fields', badWeeks.missing_fields.indexOf('weeks') >= 0);

  // --- 连续节数越界要裁剪，而不是把整条记录丢掉 ---
  const overflow = aiApi.normalizeItem(
    { name: 'X', day_of_week: 1, start_slot: 5, slot_count: 10, weeks: '1-16' }, 6);
  eq('校验：连续节数越界自动裁剪到边界', overflow.slot_count, 2);

  // --- 中文数字 / 带单位的数字要能容错取整 ---
  const strNum = aiApi.normalizeItem(
    { name: 'X', day_of_week: '3', start_slot: '2节', slot_count: '2', weeks: '1-16' }, 6);
  eq('校验：字符串数字可解析', strNum.day_of_week, 3);
  eq('校验：带单位的值可解析', strNum.start_slot, 2);

  // --- 完全无用的记录直接丢弃 ---
  eq('校验：非对象返回 null', aiApi.normalizeItem('字符串', 6), null);
  eq('校验：空对象返回 null', aiApi.normalizeItem({}, 6), null);
  const mixed = aiApi.normalizeList(
    [{ name: '高数', day_of_week: 1, start_slot: 1, weeks: '1-16' }, {}, '垃圾'], 6);
  eq('批量校验：只保留合法项', mixed.list.length, 1);
  eq('批量校验：统计被丢弃数', mixed.rejected, 2);
  eq('批量校验：非数组输入安全', aiApi.normalizeList(null, 6).list.length, 0);

  // --- 主入口：注入假模型，验证流式拼装与进度回调 ---
  const fakeProvider = {
    createModel() {
      return {
        async streamText({ data }) {
          // 断言提示词确实约束了 JSON 输出（防止以后被改坏）
          const sys = data.messages[0].content;
          if (sys.indexOf('JSON') === -1) throw new Error('系统提示词丢失 JSON 约束');
          const chunks = ['[{"name":"高等数学","day_of_week":1,', '"start_slot":1,"slot_count":2,',
            '"teacher":"王老师","location":"A301","weeks":"1-16"}]'];
          return {
            textStream: (async function* () {
              for (const c of chunks) yield c;
            })()
          };
        }
      };
    }
  };

  const progress = [];
  const parseRes = await aiApi.parseCourses('周一一二节高数 王老师 A301 1-16周', {
    modelProvider: fakeProvider,
    onProgress: (chunk, full) => progress.push(full.length)
  });
  ok('主入口：解析成功', parseRes.ok);
  eq('主入口：返回 1 门课', parseRes.list.length, 1);
  eq('主入口：课程名正确', parseRes.list[0].name, '高等数学');
  eq('主入口：星期正确', parseRes.list[0].day_of_week, 1);
  ok('主入口：流式进度回调被多次触发', progress.length >= 2);
  ok('主入口：进度文本累积递增', progress[progress.length - 1] > progress[0]);

  // --- 三层容错：解析为空 ---
  const emptyRes = await aiApi.parseCourses('   ', { modelProvider: fakeProvider });
  eq('容错：空输入被拦下', emptyRes.ok, false);
  eq('容错：空输入错误码', emptyRes.code, aiApi.PARSE_ERROR.EMPTY_INPUT);
  ok('容错：空输入有可展示文案', emptyRes.message.length > 0);

  // --- 三层容错：模型返回不可解析内容 ---
  const garbageProvider = {
    createModel: () => ({
      async streamText() {
        return { textStream: (async function* () { yield '抱歉，我不太明白你的意思'; })() };
      }
    })
  };
  const badRes = await aiApi.parseCourses('随便说点什么', { modelProvider: garbageProvider });
  eq('容错：模型输出非 JSON 时拒收', badRes.ok, false);
  eq('容错：错误码为 BAD_OUTPUT', badRes.code, aiApi.PARSE_ERROR.BAD_OUTPUT);

  // --- 三层容错：模型调用抛异常 ---
  const throwProvider = {
    createModel: () => ({
      async streamText() { throw new Error('网络中断'); }
    })
  };
  const errRes = await aiApi.parseCourses('周一高数', { modelProvider: throwProvider });
  eq('容错：模型异常不抛出，转为错误码', errRes.code, aiApi.PARSE_ERROR.MODEL_ERROR);

  // --- 三层容错：模型返回空数组 ---
  const noneProvider = {
    createModel: () => ({
      async streamText() {
        return { textStream: (async function* () { yield '[]'; })() };
      }
    })
  };
  const noneRes = await aiApi.parseCourses('今天天气不错', { modelProvider: noneProvider });
  eq('容错：无可识别课程时给 NO_COURSE', noneRes.code, aiApi.PARSE_ERROR.NO_COURSE);

  // --- 降级路径：环境不具备 AI 能力时给出 AI_UNAVAILABLE（交由页面回退本地解析）---
  const savedCloud = global.wx.cloud;
  delete global.wx.cloud;
  const noAIRes = await aiApi.parseCourses('周一高数');
  eq('降级：无 AI 能力时返回 AI_UNAVAILABLE', noAIRes.code, aiApi.PARSE_ERROR.AI_UNAVAILABLE);
  eq('降级：isAIAvailable 为 false', aiApi.isAIAvailable(), false);
  global.wx.cloud = savedCloud;

  ok('降级：每个错误码都有中文文案',
    Object.keys(aiApi.PARSE_ERROR).every((k) => aiApi.messageOf(aiApi.PARSE_ERROR[k]).length > 0));
  eq('降级：默认模型为免费体验模型 hy3', aiApi.DEFAULT_MODEL, 'hy3');

  /* ============ 38. 图片识别管线（P2） ============ */
  // 图片识别与对话建表共用同一条管线的「抽取 + Schema 校验」段：
  //   图片 → 压缩 → 上传云存储 → 云函数调视觉模型 → extractJSON → normalizeList
  // 这里注入假的上传器与云函数调用器，验证管线串联与错误映射，不调真实模型。
  group('【38】图片识别管线');

  eq('图片长边上限为 1600px', aiApi.IMAGE_MAX_EDGE, 1600);

  // --- 主链路：云函数返回合法 JSON → 走同一套校验 ---
  const ocrCalls = [];
  const ocrRes = await aiApi.parseCoursesFromImage('/tmp/fake-timetable.jpg', {
    uploader: async () => 'cloud://fake.jpg',
    callFunction: async (fileID) => {
      ocrCalls.push(fileID);
      return {
        ok: true,
        raw: '[{"name":"高等数学","day_of_week":1,"start_slot":1,"slot_count":2,' +
             '"teacher":"王老师","location":"A301","weeks":"1-16"},' +
             '{"name":"英语","day_of_week":3,"start_slot":3,"slot_count":2,"weeks":"1-16"}]'
      };
    },
    keepImage: true
  });
  ok('图片识别：解析成功', ocrRes.ok);
  eq('图片识别：识别出 2 门课', ocrRes.list.length, 2);
  eq('图片识别：课程名正确', ocrRes.list[0].name, '高等数学');
  eq('图片识别：跨节课程合并为一条（slot_count=2）', ocrRes.list[0].slot_count, 2);
  eq('图片识别：教师字段正确', ocrRes.list[0].teacher, '王老师');
  eq('图片识别：调用了云函数一次', ocrCalls.length, 1);

  // --- 模型裹 markdown 代码块时同样能剥出来（截图识别的常见输出形态）---
  const fencedRes = await aiApi.parseCoursesFromImage('/tmp/x.jpg', {
    uploader: async () => 'cloud://x.jpg',
    callFunction: async () => ({
      ok: true,
      raw: '```json\n[{"name":"物理","day_of_week":2,"start_slot":1,"slot_count":2,"weeks":"1-16"}]\n```'
    }),
    keepImage: true
  });
  ok('图片识别：能剥离 ```json 代码块', fencedRes.ok);
  eq('图片识别：代码块内课程解析正确', fencedRes.list[0].name, '物理');

  // --- 缺字段时同样标记而非猜测（与对话解析一致的口径）---
  const partialRes = await aiApi.parseCoursesFromImage('/tmp/y.jpg', {
    uploader: async () => 'cloud://y.jpg',
    callFunction: async () => ({
      ok: true,
      raw: '[{"name":"化学","day_of_week":4}]'
    }),
    keepImage: true
  });
  ok('图片识别：缺字段仍算成功（进预览页让用户补）', partialRes.ok);
  ok('图片识别：缺失字段被标记',
    partialRes.list[0].missing_fields.indexOf('start_slot') >= 0);

  // --- 错误映射：没有图片 ---
  const noFileRes = await aiApi.parseCoursesFromImage('', { uploader: async () => 'cloud://n.jpg', callFunction: async () => ({ ok: true }) });
  eq('图片识别：无图片时给 NO_FILE', noFileRes.code, aiApi.PARSE_ERROR.NO_FILE);

  // --- 错误映射：云函数返回失败 ---
  const svcFailRes = await aiApi.parseCoursesFromImage('/tmp/z.jpg', {
    uploader: async () => 'cloud://z.jpg',
    callFunction: async () => ({ ok: false, error: 'MODEL_ERROR', message: '模型挂了' }),
    keepImage: true
  });
  eq('图片识别：服务端失败映射为 MODEL_ERROR', svcFailRes.code, aiApi.PARSE_ERROR.MODEL_ERROR);

  // --- 错误映射：图片过大（服务端专门回这个码，客户端要区分出来）---
  const tooLargeRes = await aiApi.parseCoursesFromImage('/tmp/big.jpg', {
    uploader: async () => 'cloud://big.jpg',
    callFunction: async () => ({ ok: false, error: 'TOO_LARGE', message: '图片过大' }),
    keepImage: true
  });
  eq('图片识别：TOO_LARGE 单独映射', tooLargeRes.code, aiApi.PARSE_ERROR.IMAGE_TOO_LARGE);
  ok('图片识别：大图提示引导用户换图',
    tooLargeRes.message.indexOf('压缩') >= 0 || tooLargeRes.message.indexOf('换一张') >= 0);

  // --- 错误映射：云函数抛异常 ---
  const svcThrowRes = await aiApi.parseCoursesFromImage('/tmp/t.jpg', {
    uploader: async () => 'cloud://t.jpg',
    callFunction: async () => { throw new Error('网络中断'); },
    keepImage: true
  });
  eq('图片识别：云函数异常不抛出，转错误码', svcThrowRes.code, aiApi.PARSE_ERROR.MODEL_ERROR);

  // --- 错误映射：模型输出不是 JSON ---
  const badOcrRes = await aiApi.parseCoursesFromImage('/tmp/n.jpg', {
    uploader: async () => 'cloud://n.jpg',
    callFunction: async () => ({ ok: true, raw: '这张图片好像不是课表' }),
    keepImage: true
  });
  eq('图片识别：非 JSON 输出拒收', badOcrRes.code, aiApi.PARSE_ERROR.BAD_OUTPUT);

  // --- 错误映射：识别不出课程 ---
  const emptyOcrRes = await aiApi.parseCoursesFromImage('/tmp/e.jpg', {
    uploader: async () => 'cloud://e.jpg',
    callFunction: async () => ({ ok: true, raw: '[]' }),
    keepImage: true
  });
  eq('图片识别：无课程时给 NO_COURSE', emptyOcrRes.code, aiApi.PARSE_ERROR.NO_COURSE);

  // --- 环境无云能力时降级 ---
  const savedCloud2 = global.wx.cloud;
  delete global.wx.cloud;
  const noCloudRes = await aiApi.parseCoursesFromImage('/tmp/g.jpg');
  eq('图片识别：无云能力时给 AI_UNAVAILABLE', noCloudRes.code, aiApi.PARSE_ERROR.AI_UNAVAILABLE);
  global.wx.cloud = savedCloud2;

  ok('图片识别：错误码均有中文文案',
    [aiApi.PARSE_ERROR.NO_FILE, aiApi.PARSE_ERROR.UPLOAD_FAILED,
     aiApi.PARSE_ERROR.IMAGE_TOO_LARGE].every((c) => aiApi.messageOf(c).length > 0));

  /* ============ 【39】真实模型输出的兼容性 ============ */
  group('【39】真实模型输出兼容（实测踩坑回归）');

  // —— 场景 A：hunyuan-t1-vision 会把结果包在 <answer> 标签里 ——
  const wrapped = '<answer>\n[{"name":"高等数学","day_of_week":1,"start_slot":1,"slot_count":2}]\n</answer>';
  const wrappedParsed = aiApi.extractJSON(wrapped);
  ok('兼容：能剥离 <answer> 标签', Array.isArray(wrappedParsed) && wrappedParsed.length === 1);
  eq('兼容：标签内课程名正确', wrappedParsed[0].name, '高等数学');

  // 标签 + 外部思考过程同时存在时，不能让思考过程里的 [ ] 干扰切片
  const noisy = '让我分析一下这张图 [图中有表格]\n<answer>[{"name":"英语"}]</answer>';
  const noisyParsed = aiApi.extractJSON(noisy);
  ok('兼容：思考过程干扰下仍取到 answer 内容',
    Array.isArray(noisyParsed) && noisyParsed[0].name === '英语');

  // —— 场景 B：模型自创字段名（实测 day/period/courseName/classroom）——
  const aliased = aiApi.normalizeItem({
    courseName: '数据结构',
    day: 2,
    period: 2,
    teacher: '王强',
    classroom: '机房301',
    weeks: '1-16'
  }, 6);
  ok('兼容：courseName 别名识别为课程名', aliased && aliased.name === '数据结构');
  eq('兼容：day 别名识别为星期', aliased.day_of_week, 2);
  eq('兼容：period 别名识别为开始节次', aliased.start_slot, 2);
  eq('兼容：classroom 别名识别为地点', aliased.location, '机房301');
  eq('兼容：无缺失字段', aliased.missing_fields.length, 0);

  // —— 场景 C：星期写成中文 ——
  eq('兼容：中文「周一」转 1', aiApi.normalizeItem({ name: 'x', day_of_week: '周一' }, 6).day_of_week, 1);
  eq('兼容：中文「星期三」转 3', aiApi.normalizeItem({ name: 'x', day_of_week: '星期三' }, 6).day_of_week, 3);
  eq('兼容：中文「周日」转 7', aiApi.normalizeItem({ name: 'x', day: '周日' }, 6).day_of_week, 7);

  // —— 场景 D：标准字段名必须优先于别名（别名只兜底，不能反向覆盖）——
  const both = aiApi.normalizeItem({
    name: '标准名', courseName: '别名',
    day_of_week: 3, day: 5,
    start_slot: 1, period: 4
  }, 6);
  eq('兼容：标准字段优先（name）', both.name, '标准名');
  eq('兼容：标准字段优先（day_of_week）', both.day_of_week, 3);
  eq('兼容：标准字段优先（start_slot）', both.start_slot, 1);

  // —— 场景 E：整批数据经 alias 兼容后不丢课程 ——
  const aliasList = aiApi.normalizeList([
    { courseName: '高等数学', day: '周一', period: 1, classroom: 'A101', weeks: '1-16' },
    { title: '大学英语', weekday: 3, section: 3, room: 'B203', week: '1-16' }
  ], 6);
  eq('兼容：批量识别不丢课程', aliasList.list.length, 2);
  eq('兼容：批量识别字段完整', aliasList.list[0].missing_fields.length, 0);
  eq('兼容：title/room 别名生效', aliasList.list[1].location, 'B203');

  // —— 场景 F：真实图片识别耗时 45s+，失败时要能定位到原因 ——
  // 用户实测反馈「拍照导入显示 AI 服务暂时不可用」，但客户端此前只打
  // code + message，把云函数回传的 detail/code 丢了，导致无从排查。
  // 这里锁住「服务端失败必须把诊断信息透出，且不能污染错误码本身」。
  const modelErr = await aiApi.parseCoursesFromImage('local.jpg', {
    uploader: async () => 'cloud://t.jpg',
    callFunction: async () => ({
      ok: false, error: 'MODEL_ERROR', message: '图片识别服务暂时不可用',
      detail: 'request timeout', code: 'ESOCKETTIMEDOUT', ms: 15077
    })
  });
  eq('诊断：服务端失败仍映射为 MODEL_ERROR', modelErr.code, 'MODEL_ERROR');
  eq('诊断：透出服务端 detail', modelErr.serverDetail, 'request timeout');
  eq('诊断：透出服务端 code', modelErr.serverCode, 'ESOCKETTIMEDOUT');
  ok('诊断：错误码不被附加字段覆盖', modelErr.code === 'MODEL_ERROR');

  // 调用器直接抛错（客户端先断开）时，超时给专门的错误码与文案
  const timeoutErr = await aiApi.parseCoursesFromImage('local.jpg', {
    uploader: async () => 'cloud://t.jpg',
    callFunction: async () => { throw { errMsg: 'cloud.callFunction:fail timeout' }; }
  });
  eq('诊断：超时映射为 MODEL_TIMEOUT', timeoutErr.code, 'MODEL_TIMEOUT');
  ok('诊断：超时有独立文案', aiApi.messageOf(aiApi.PARSE_ERROR.MODEL_TIMEOUT).indexOf('超时') >= 0);

  // —— 场景 G：周次写成「第1-16周」（截图里的常见写法）——
  eq('周次兼容：「第1-16周」可解析', parseWeeks('第1-16周').length, 16);
  eq('周次兼容：「第3-5周」可解析', parseWeeks('第3-5周').join(','), '3,4,5');
  eq('周次兼容：「第1-16周单周」仍识别单周',
    parseWeeks('第1-16周单周').join(','), '1,3,5,7,9,11,13,15');

  /* ============ 【41】课表版式规则（两阶段识别） ============ */
  // 用户反馈「识别不到周数」：真实课表的周次常常不在格子里（标题 / 图例 /
  // 按周次分块 / 用颜色区分）。两阶段识别先让模型读懂版式规则，再把规则注入
  // 提取提示词。这里锁住客户端对规则的解析、兜底与透传行为。
  group('【41】课表版式规则（两阶段识别）');

  // —— 分块版式（左右两表各管一段周次）——
  const layoutBlock = aiApi.parseLayout(JSON.stringify({
    title: '电子信息 1 班课表',
    axis_x: ['周一', '周二'],
    axis_y: ['第1节', '第2节'],
    weeks_source: 'block',
    weeks_evidence: ['第1-8周', '第9-16周'],
    weeks_mapping: [
      { scope: '左侧表格', weeks: '第1-8周' },
      { scope: '右侧表格', weeks: '第9-16周' }
    ]
  }));
  ok('版式：分块来源解析', layoutBlock && layoutBlock.weeksSource === 'block');
  eq('版式：来源中文文案', layoutBlock.weeksSourceText, '表格按周次分块');
  eq('版式：映射条数', layoutBlock.mapping.length, 2);
  eq('版式：映射内容', layoutBlock.mapping[0].weeks, '第1-8周');
  // 分块周次绝不能整体套用（左表 1-8、右表 9-16 是两个不同范围）
  eq('版式：分块不给整表兜底', aiApi.globalWeeksOf(layoutBlock), '');

  // —— 标题版式（整表统一周次）——
  const layoutHeader = aiApi.parseLayout(JSON.stringify({
    weeks_source: 'header',
    weeks_evidence: '适用周次：第 1-16 周',
    weeks_mapping: [{ scope: '整个表格', weeks: '1-16周' }]
  }));
  ok('版式：标题来源解析', layoutHeader && layoutHeader.weeksSource === 'header');
  eq('版式：整表统一周次可兜底', aiApi.globalWeeksOf(layoutHeader), '1-16周');

  // —— 颜色 + 图例版式（最难：周次只靠底色）——
  const layoutColor = aiApi.parseLayout(JSON.stringify({
    weeks_source: 'color',
    weeks_evidence: '图例：浅蓝=1-16周，浅绿=1-8周',
    weeks_mapping: [
      { scope: '浅蓝色单元格', weeks: '1-16周' },
      { scope: '浅绿色单元格', weeks: '1-8周' }
    ]
  }));
  ok('版式：颜色来源解析', layoutColor && layoutColor.weeksSource === 'color');
  eq('版式：颜色来源中文文案', layoutColor.weeksSourceText, '用颜色区分周次');
  // 多条映射同样不能整体兜底
  eq('版式：多条映射不给整表兜底', aiApi.globalWeeksOf(layoutColor), '');

  // —— 容错：模型裹代码块 / 加前言 ——
  const noisyLayout = aiApi.parseLayout('好的，我来分析：\n```json\n{"weeks_source":"cell","weeks_mapping":[]}\n```');
  ok('版式：容错解析带代码块输出', noisyLayout && noisyLayout.weeksSource === 'cell');
  eq('版式：无法解析时返回 null', aiApi.parseLayout('这张图看不清'), null);
  eq('版式：空输入返回 null', aiApi.parseLayout(''), null);
  eq('版式：null 输入返回 null', aiApi.parseLayout(null), null);

  // —— 兜底只在「该条没写周次」时生效，且不得覆盖已有值 ——
  const fbList = aiApi.normalizeList([
    { name: '甲课', day_of_week: 1, start_slot: 1, weeks: null },
    { name: '乙课', day_of_week: 2, start_slot: 1, weeks: '9-16' }
  ], 6, { fallbackWeeks: '1-16周' });
  eq('兜底：没写周次的课程被补上', fbList.list[0].weeks, '1-16周');
  eq('兜底：补上后不再算缺失', fbList.list[0].missing_fields.length, 0);
  eq('兜底：已有周次不被覆盖', fbList.list[1].weeks, '9-16');

  // 没有兜底时，周次仍然记为缺失（保持「不猜」原则）
  const noFb = aiApi.normalizeList([{ name: '丙课', day_of_week: 1, start_slot: 1 }], 6);
  ok('兜底：无兜底时周次记缺失', noFb.list[0].missing_fields.indexOf('weeks') >= 0);
  // 兜底值本身无法解析时不能塞进去（如「每周」这种）
  const badFb = aiApi.normalizeList([{ name: '丁课', day_of_week: 1, start_slot: 1 }], 6,
    { fallbackWeeks: '每周' });
  ok('兜底：不可解析的兜底值被忽略', badFb.list[0].missing_fields.indexOf('weeks') >= 0);

  // —— 只写「单周」「双周」没有区间时，按全学期展开 ——
  eq('周次：单独写「单周」可解析', parseWeeks('单周').length > 0, true);
  eq('周次：「单周」只含奇数周', parseWeeks('单周').every((w) => w % 2 === 1), true);
  eq('周次：「双周」只含偶数周', parseWeeks('双周').every((w) => w % 2 === 0), true);
  // 全角连接符（截图里常见）
  eq('周次：全角破折号「1—16」', parseWeeks('1—16').length, 16);
  eq('周次：全角波浪「1～16」', parseWeeks('1～16').length, 16);

  // —— 云函数返回 layout 时，页面能拿到（透传不丢）——
  const withLayout = await aiApi.parseCoursesFromImage('local.jpg', {
    uploader: async () => 'cloud://t.jpg',
    callFunction: async () => ({
      ok: true,
      raw: '[{"name":"电路分析","day_of_week":1,"start_slot":1,"slot_count":2,"weeks":null}]',
      layout: '{"weeks_source":"header","weeks_evidence":"第1-16周","weeks_mapping":[{"scope":"整个表格","weeks":"1-16周"}]}'
    })
  });
  ok('透传：识别结果带出版式规则', withLayout.ok && !!withLayout.layout);
  eq('透传：版式来源正确', withLayout.layout && withLayout.layout.weeksSource, 'header');
  eq('透传：缺周次的课程被整表周次兜底', withLayout.list[0].weeks, '1-16周');
  eq('透传：兜底后无缺失字段', withLayout.list[0].missing_fields.length, 0);

  /* ============ 【42】课程配色与识别快速模式 ============ */
  group('【42】课程配色（同课同色 + 异课异色）与快速模式');

  // —— 配色：同一门课恒定同色 ——
  eq('配色：同名同色（两次调用一致）', colorOf('高等数学'), colorOf('高等数学'));
  ok('配色：调色板已扩到 12 色', PALETTE.length === 12);

  const colorNames = ['高等数学', '大学英语', '数据结构', '线性代数', '计算机网络',
    '操作系统', '体育', '软件工程', '概率论', '电路分析'];
  const cmap = buildColorMap(colorNames);
  const cvals = colorNames.map((n) => cmap[n]);
  eq('配色：10 门课 10 种颜色（无撞色）', new Set(cvals).size, 10);
  // 旧实现（纯哈希 8 色）实测这 10 门课只有 5 种颜色、3 组撞色
  ok('配色：颜色均取自调色板', cvals.every((c) => PALETTE.indexOf(c) >= 0));

  // —— 稳定性与顺序无关性 ——
  ok('配色：重复计算结果一致',
    JSON.stringify(buildColorMap(colorNames)) === JSON.stringify(cmap));
  ok('配色：与传入顺序无关',
    JSON.stringify(buildColorMap(colorNames.slice().reverse())) === JSON.stringify(cmap));

  // —— 边界 ——
  eq('配色：空列表返回空表', Object.keys(buildColorMap([])).length, 0);
  eq('配色：null 输入不抛错', Object.keys(buildColorMap(null)).length, 0);
  const withBlank = buildColorMap([' 高等数学 ', '', null, '高等数学']);
  eq('配色：去重 + 去空白后只剩一项', Object.keys(withBlank).length, 1);
  eq('配色：去空白后键名正确', Object.keys(withBlank)[0], '高等数学');

  // 课程数超过调色板容量时允许复用，但不能抛错
  const many = [];
  for (let i = 0; i < 20; i++) many.push('课程' + i);
  const manyMap = buildColorMap(many);
  eq('配色：20 门课都能取到色', Object.keys(manyMap).length, 20);
  ok('配色：超出容量时复用仍落在调色板内',
    Object.keys(manyMap).every((k) => PALETTE.indexOf(manyMap[k]) >= 0));

  // 浅色底：同色系 14% 透明度
  eq('配色：softOf 生成浅色底', softOf('#5B8FF9'), 'rgba(91, 143, 249, 0.14)');

  // —— 快速模式：应把 layout:false 透传给云函数 ——
  let fastArg = null;
  const fastRes = await aiApi.parseCoursesFromImage('local.jpg', {
    fast: true,
    uploader: async () => 'cloud://t.jpg',
    callFunction: async (fileID, extra) => {
      fastArg = extra;
      return {
        ok: true,
        raw: '[{"name":"高等数学","day_of_week":1,"start_slot":1,"slot_count":2,"weeks":"1-16"}]'
      };
    }
  });
  ok('快速模式：识别成功', fastRes.ok && fastRes.list.length === 1);
  ok('快速模式：向云函数传了 layout:false', fastArg && fastArg.layout === false);

  // 完整模式（默认）不得传 layout:false，否则会白白丢掉版式分析
  let normalArg = 'unset';
  await aiApi.parseCoursesFromImage('local.jpg', {
    uploader: async () => 'cloud://t.jpg',
    callFunction: async (fileID, extra) => {
      normalArg = extra;
      return { ok: true, raw: '[{"name":"英语","day_of_week":2,"start_slot":1,"weeks":"1-16"}]' };
    }
  });
  ok('完整模式：未传 layout:false', !normalArg || normalArg.layout !== false);

  /* ============ 【43】找搭子可视化网格 alignGrid ============ */
  group('【43】找搭子可视化网格 alignGrid');

  // —— 双方同课 → 撞课；其它格 → 空闲 ——
  const g1 = alignGrid(
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-2' }],
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-2' }]
  );
  eq('网格：双方同课 → 撞课', g1.grid[1][0][0], 'clash');
  eq('网格：周二第 1 节都空 → 空闲', g1.grid[1][1][0], 'free');

  // —— 四态区分 ——
  const g2 = alignGrid(
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-1' }],
    [{ day_of_week: 2, start_slot: 1, slot_count: 1, weeks: '1-1' }]
  );
  eq('网格：只有我忙 → mine', g2.grid[1][0][0], 'mine');
  eq('网格：只有对方忙 → theirs', g2.grid[1][1][0], 'theirs');
  eq('网格：双方都空 → free', g2.grid[1][2][0], 'free');

  // —— 起床/就寝裁剪：范围外是 out，不参与高亮/标灰 ——
  const g3 = alignGrid(
    [{ day_of_week: 1, start_slot: 2, slot_count: 1, weeks: '1-1' }],
    [],
    { slotCount: 4, wakeSlot: 2, sleepSlot: 3 }
  );
  eq('网格：起床前 → out', g3.grid[1][0][0], 'out');
  eq('网格：就寝后 → out', g3.grid[1][0][3], 'out');
  eq('网格：范围内都空 → free', g3.grid[1][0][2], 'free');
  eq('网格：slotCount 回传', g3.slotCount, 4);

  // —— 单双周：单周课不能误占偶数周 ——
  const g4 = alignGrid(
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-3 单' }],
    [{ day_of_week: 2, start_slot: 1, slot_count: 1, weeks: '1-3' }]
  );
  eq('网格：单周课在奇数周占用（周1周一=我忙）', g4.grid[1][0][0], 'mine');
  eq('网格：单周课在偶数周不占用（周2周一=空闲）', g4.grid[2][0][0], 'free');
  eq('网格：周次并集且升序', g4.weeks.join(','), '1,2,3');

  /* ============ 【44】多人课表共享（N 人对齐） ============ */
  group('【44】多人课表共享（N 人对齐）');

  // —— alignFreeMulti：全员都空才算空闲 ——
  // 3 人分别占周一第 1/2/3 节，则周一前 3 节都不算共同空闲
  const m1 = alignFreeMulti([
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-1' }],
    [{ day_of_week: 1, start_slot: 2, slot_count: 1, weeks: '1-1' }],
    [{ day_of_week: 1, start_slot: 3, slot_count: 1, weeks: '1-1' }]
  ]);
  const mw1 = m1.result.find((r) => r.week === 1);
  ok('多人：周一第 1 节有人忙，不算共同空闲',
    !!mw1 && !mw1.slots.some((s) => s.day === 1 && s.from === 1), JSON.stringify(mw1));
  ok('多人：周一第 4 节起全员空闲',
    !!mw1 && mw1.slots.some((s) => s.day === 1 && s.from === 4), JSON.stringify(mw1));
  ok('多人：其余天全员空闲',
    !!mw1 && mw1.slots.some((s) => s.day === 2 && s.from === 1), JSON.stringify(mw1));

  // —— alignGridMulti：free / partial / clash 三态 + 空闲计数 ——
  // 注意入参是「每人一个课程列表」的数组：[[A 的课程], [B 的课程], [C 的课程]]
  const gm = alignGridMulti([
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-1' }],
    [{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-1' }],
    [
      { day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-1' },
      { day_of_week: 2, start_slot: 1, slot_count: 1, weeks: '1-1' }
    ]
  ], { slotCount: 4 });
  eq('多人网格：全员忙 → clash', gm.grid[1][0][0].state, 'clash');
  eq('多人网格：全员忙时空闲数为 0', gm.grid[1][0][0].freeCount, 0);
  eq('多人网格：只有 C 忙 → partial', gm.grid[1][1][0].state, 'partial');
  eq('多人网格：partial 空闲 2/3', gm.grid[1][1][0].freeCount, 2);
  eq('多人网格：全员空 → free', gm.grid[1][0][1].state, 'free');
  eq('多人网格：total 回传参与人数', gm.total, 3);

  // —— 起床/就寝裁剪：范围 2~3 节，课程在第 2 节 ——
  const gmo = alignGridMulti(
    [[{ day_of_week: 1, start_slot: 2, slot_count: 1, weeks: '1-1' }]],
    { slotCount: 3, wakeSlot: 2, sleepSlot: 3 }
  );
  eq('多人网格：起床前（第 1 节）→ out', gmo.grid[1][0][0].state, 'out');
  eq('多人网格：就寝节次本身在范围内（第 3 节）→ free', gmo.grid[1][0][2].state, 'free');
  eq('多人网格：范围内单人自己忙 → clash（1/1 忙）', gmo.grid[1][0][1].state, 'clash');

  // —— 空课表同学视为始终空闲（页面会先跳过没建课表的同学，这里是算法层语义） ——
  const gme = alignGridMulti(
    [[{ day_of_week: 1, start_slot: 1, slot_count: 1, weeks: '1-1' }], []],
    { slotCount: 2 }
  );
  eq('多人网格：空课表同学不占用 → partial', gme.grid[1][0][0].state, 'partial');
  eq('多人网格：空课表同学计入空闲数', gme.grid[1][0][0].freeCount, 1);

  /* ============ 38. 找搭子好友课表存在性（本地模式） ============ */
  // 本地模式没有云端课表统计接口，改为在本地 store 里按 owner_id 查 timetables。
  // 覆盖「有课表无课程」这一关键区分 —— 页面据此说「建了课表但还没录课程」
  // 而不是笼统的「没建课表」。
  group('【38】找搭子好友课表存在性 fetchFriendCourses（本地模式）');

  clientApi.initClient({ useCloud: false });
  eq('客户端已切回本地模式', clientApi.getMode(), 'local');

  // 造一位「已建课表、但还没录课程」的同学
  await storeApi.insert('timetables', { owner_id: 'oLOCAL_T', name: '某同学课表' });
  const localEmpty = await courseApi.fetchFriendCourses('oLOCAL_T');
  eq('本地：对方有课表 → hasTimetable=true', localEmpty.hasTimetable, true);
  eq('本地：对方无课程 → 课程为空', localEmpty.courses.length, 0);

  const localNone = await courseApi.fetchFriendCourses('oLOCAL_NONE');
  eq('本地：查无此人数据 → hasTimetable=false', localNone.hasTimetable, false);
  eq('本地：查无此人数据 → 课程为空', localNone.courses.length, 0);

  eq('本地：owner_id 为空 → 不查库直接返回空',
    await courseApi.fetchFriendCourses(''), { courses: [], hasTimetable: false });

  /* ============ 汇总 ============ */
  console.log('\n' + '='.repeat(52));
  console.log(`测试完成：通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(52));
  process.exit(failed > 0 ? 1 : 0);
})();
