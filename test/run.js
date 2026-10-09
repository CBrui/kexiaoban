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
const { alignFree, alignFreeWithRange, isCounterpartEmpty } = require(path.join(M, 'logic/free-align'));
const { shouldNotify, shouldNotifyWithCalendar, buildCalendarIndex, inSilentRange } = require(path.join(M, 'logic/dnd-rule'));
const { colorOf } = require(path.join(M, 'utils/color'));
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
        return Promise.resolve({
          result: {
            ok: true,
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

  let relationErr = '';
  try {
    await courseApi.listCoursesByOwner('oSTRANGER');
  } catch (e) {
    relationErr = String((e && e.message) || e);
  }
  ok('未建立关系时抛出可读错误（不再静默返回空）',
    relationErr.indexOf('NO_RELATION') >= 0 || relationErr.indexOf('尚未') >= 0);

  /* ============ 汇总 ============ */
  console.log('\n' + '='.repeat(52));
  console.log(`测试完成：通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(52));
  process.exit(failed > 0 ? 1 : 0);
})();
