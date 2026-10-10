/**
 * logic/free-align.js —— 空闲时间对齐算法
 *
 * 「从记录工具到协作工具」这个定位跃迁的技术落点。
 *
 * 输入：用户 A 的占用集 PA，用户 B 的占用集 PB
 * 输出：共同空闲时段列表（按周次分组）
 *
 * 呈现要求：结果以「周次 + 星期 + 时段」的形式呈现，而非笼统的「有时间」。
 * 用户需要的是「第 3 周周三下午 5-6 节我们都有空」。
 */
const { expandAll, toWeekGrid } = require('./course-expand');

/**
 * 计算两人共同空闲
 * @param {object[]} coursesA 用户 A 的课程
 * @param {object[]} coursesB 用户 B 的课程
 * @returns {{weeks: number[], result: Array<{week:number, slots:Array<{day:number,from:number,to:number}>}>}}
 */
function alignFree(coursesA, coursesB) {
  const setA = expandAll(coursesA);
  const setB = expandAll(coursesB);

  // 1. 全体周次集合 = A 与 B 课程涉及的周次并集
  const weeksSet = new Set();
  [...setA, ...setB].forEach((k) => weeksSet.add(Number(k.split('-')[0])));
  const weekList = Array.from(weeksSet).sort((a, b) => a - b);

  const gridA = toWeekGrid(setA, weekList);
  const gridB = toWeekGrid(setB, weekList);

  const result = [];

  // 2. 对每个周次逐格判断，双方都未占用 = 共同空闲
  for (const w of weekList) {
    const slots = [];
    for (let d = 0; d < 7; d++) {
      let run = null;
      for (let s = 0; s < 12; s++) {
        const free = !gridA[w][d][s] && !gridB[w][d][s];
        if (free && !run) {
          run = { day: d + 1, from: s + 1, to: s + 1 };
        } else if (free && run) {
          run.to = s + 1;
        } else if (!free && run) {
          // 3. 连续空闲格合并为时段，避免逐格罗列
          slots.push(run);
          run = null;
        }
      }
      if (run) slots.push(run);
    }
    if (slots.length) result.push({ week: w, slots });
  }

  return { weeks: weekList, result };
}

/**
 * 带可选「起床/就寝节次」裁剪的空闲对齐
 * 用于剔除用户明确不参与的时段（如 12 节之后、1 节之前）
 * @param {object} options { wakeSlot, sleepSlot }
 */
function alignFreeWithRange(coursesA, coursesB, options = {}) {
  const { result } = alignFree(coursesA, coursesB);
  const wakeSlot = Number(options.wakeSlot) || 1;
  const sleepSlot = Number(options.sleepSlot) || 12;

  const clipped = [];
  for (const item of result) {
    const slots = [];
    for (const slot of item.slots) {
      const from = Math.max(slot.from, wakeSlot);
      const to = Math.min(slot.to, sleepSlot);
      if (from <= to) slots.push({ day: slot.day, from, to });
    }
    if (slots.length) clipped.push({ week: item.week, slots });
  }
  return clipped;
}

/**
 * 生成「撞课 / 空闲」四态对比网格，供找搭子图表渲染。
 *
 * 每个格子属于四种状态之一：
 *   free    双方都空（且落在起床~就寝范围内）—— 界面高亮
 *   clash   双方都有课（撞课）—— 界面标灰
 *   mine    只有我忙
 *   theirs  只有对方忙
 *   out     起床/就寝范围之外（不参与，也不标灰/高亮）
 *
 * @param {object[]} coursesA 我的课程
 * @param {object[]} coursesB 对方课程
 * @param {object} [options] { slotCount, wakeSlot, sleepSlot }
 * @returns {{weeks:number[], grid:Object, slotCount:number, wakeSlot:number, sleepSlot:number}}
 *   grid[week][day 0..6][slot 0..slotCount-1] = 'free'|'clash'|'mine'|'theirs'|'out'
 */
function alignGrid(coursesA, coursesB, options = {}) {
  const slotCount = Number(options.slotCount) || 12;
  const wakeSlot = Number(options.wakeSlot) || 1;
  const sleepSlot = Number(options.sleepSlot) || slotCount;

  const setA = expandAll(coursesA);
  const setB = expandAll(coursesB);

  const weeksSet = new Set();
  [...setA, ...setB].forEach((k) => weeksSet.add(Number(k.split('-')[0])));
  const weeks = Array.from(weeksSet).sort((a, b) => a - b);

  const gridA = toWeekGrid(setA, weeks);
  const gridB = toWeekGrid(setB, weeks);

  const grid = {};
  for (const w of weeks) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const row = [];
      for (let s = 0; s < slotCount; s++) {
        if (s + 1 < wakeSlot || s + 1 > sleepSlot) {
          row.push('out');
          continue;
        }
        const a = gridA[w][d][s];
        const b = gridB[w][d][s];
        row.push(a && b ? 'clash' : a ? 'mine' : b ? 'theirs' : 'free');
      }
      days.push(row);
    }
    grid[w] = days;
  }

  return { weeks, grid, slotCount, wakeSlot, sleepSlot };
}

/**
 * N 人共同空闲（**全员都空**才算空闲）。
 *
 * 多人版的语义与 alignFree 一致，只是「空闲」的判定从
 * 「2 人都空」推广为「所有人都空」。
 *
 * @param {object[]} courseLists 课程列表的数组，如 [我的课程, 同学A, 同学B]
 * @param {object} [options] { wakeSlot, sleepSlot } 裁掉不参与的时段
 * @returns {{weeks:number[], result:Array<{week:number, slots:Array<{day,from,to}>}>}}
 */
function alignFreeMulti(courseLists, options = {}) {
  const sets = (courseLists || []).map((c) => expandAll(c));
  if (!sets.length) return { weeks: [], result: [] };

  const weeksSet = new Set();
  sets.forEach((set) => {
    [...set].forEach((k) => weeksSet.add(Number(k.split('-')[0])));
  });
  const weekList = Array.from(weeksSet).sort((a, b) => a - b);

  const grids = sets.map((set) => toWeekGrid(set, weekList));

  const wakeSlot = Number(options.wakeSlot) || 1;
  const sleepSlot = Number(options.sleepSlot) || 12;

  const result = [];
  for (const w of weekList) {
    const slots = [];
    for (let d = 0; d < 7; d++) {
      let run = null;
      for (let s = 0; s < 12; s++) {
        if (s + 1 < wakeSlot || s + 1 > sleepSlot) {
          if (run) { slots.push(run); run = null; }
          continue;
        }
        const free = grids.every((g) => !g[w][d][s]);
        if (free && !run) {
          run = { day: d + 1, from: s + 1, to: s + 1 };
        } else if (free && run) {
          run.to = s + 1;
        } else if (!free && run) {
          slots.push(run);
          run = null;
        }
      }
      if (run) slots.push(run);
    }
    if (slots.length) result.push({ week: w, slots });
  }

  return { weeks: weekList, result };
}

/**
 * N 人网格：每格记录 {state, freeCount, total}，供多人比对图渲染。
 *
 * state：
 *   free     全员都空 —— 高亮
 *   clash    全员都忙（撞课）—— 标灰
 *   partial  部分人忙 —— 界面显示「freeCount/total 空闲」
 *   out      起床/就寝范围之外
 *
 * @param {object[]} courseLists 课程列表的数组
 * @param {object} [options] { slotCount, wakeSlot, sleepSlot }
 * @returns {{weeks, grid, slotCount, wakeSlot, sleepSlot, total}}
 *   grid[week][day 0..6][slot 0..slotCount-1] = { state, freeCount, total }
 */
function alignGridMulti(courseLists, options = {}) {
  const slotCount = Number(options.slotCount) || 12;
  const wakeSlot = Number(options.wakeSlot) || 1;
  const sleepSlot = Number(options.sleepSlot) || slotCount;

  const sets = (courseLists || []).map((c) => expandAll(c));
  const total = sets.length;
  if (!total) {
    return { weeks: [], grid: {}, slotCount, wakeSlot, sleepSlot, total };
  }

  const weeksSet = new Set();
  sets.forEach((set) => {
    [...set].forEach((k) => weeksSet.add(Number(k.split('-')[0])));
  });
  const weeks = Array.from(weeksSet).sort((a, b) => a - b);

  const grids = sets.map((set) => toWeekGrid(set, weeks));

  const grid = {};
  for (const w of weeks) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const row = [];
      for (let s = 0; s < slotCount; s++) {
        if (s + 1 < wakeSlot || s + 1 > sleepSlot) {
          row.push({ state: 'out', freeCount: 0, total });
          continue;
        }
        const busy = grids.reduce((n, g) => n + (g[w][d][s] ? 1 : 0), 0);
        const freeCount = total - busy;
        const state = freeCount === total ? 'free' : freeCount === 0 ? 'clash' : 'partial';
        row.push({ state, freeCount, total });
      }
      days.push(row);
    }
    grid[w] = days;
  }

  return { weeks, grid, slotCount, wakeSlot, sleepSlot, total };
}

/**
 * 判定「对方是否一门课程都没有」
 *
 * 注意：这里判的是**课程数**，不是课表数——「课表」与「课程」是本项目的两个概念，
 * 一个人可能已经建好课表、但还没来得及录入课程。因此严格说本函数回答的是
 * 「对方是否无可用于比对的课程」，页面提示语要据此区分
 * 「还没建课表」与「建了课表但还没录课程」（见 pages/match 的 onAlign）。
 *
 * 产品分水岭：对方无课程时，应提示对方还没录入课程，而不是显示「全天有空」——
 * 后者技术上正确但会误导用户。
 * @returns {boolean}
 */
function isCounterpartEmpty(coursesB) {
  return !Array.isArray(coursesB) || coursesB.length === 0;
}

module.exports = {
  alignFree,
  alignFreeWithRange,
  alignGrid,
  alignFreeMulti,
  alignGridMulti,
  isCounterpartEmpty
};
