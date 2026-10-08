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
const { parseWeeks, formatWeeks, weekToDate, formatDate } = require(path.join(M, 'utils/week'));
const { expandCourse, expandAll, toWeekGrid } = require(path.join(M, 'logic/course-expand'));
const { alignFree, alignFreeWithRange, isCounterpartEmpty } = require(path.join(M, 'logic/free-align'));
const { shouldNotify, shouldNotifyWithCalendar, buildCalendarIndex, inSilentRange } = require(path.join(M, 'logic/dnd-rule'));
const { colorOf } = require(path.join(M, 'utils/color'));
const schedule = require(path.join(M, 'utils/schedule'));

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

/* ============ 汇总 ============ */
console.log('\n' + '='.repeat(52));
console.log(`测试完成：通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(52));
process.exit(failed > 0 ? 1 : 0);
