/**
 * logic/course-expand.js —— 课程展开算法
 *
 * 全部计算功能的地基：空闲对齐、免打扰判定都建立在它之上。
 *
 * 关键陷阱：如果忽略周次维度，直接按「星期 + 节次」计算，
 * 会把单双周课程误判为每周都占用——「找搭子」会把可用空档算没。
 * 因此占用点的唯一键必须包含周次：`${week}-${dayOfWeek}-${slot}`。
 */
const { parseWeeks } = require('../utils/week');

/**
 * 把一门课展开为占用点集合
 * @param {object} course { day_of_week, start_slot, slot_count, weeks }
 * @returns {string[]} 形如 ["1-1-1", "1-1-2", "3-1-1", ...]
 */
function expandCourse(course) {
  if (!course) return [];

  const dayOfWeek = Number(course.day_of_week);
  const startSlot = Number(course.start_slot);
  const slotCount = Number(course.slot_count) || 1;
  const weeks = parseWeeks(course.weeks);

  if (!dayOfWeek || !startSlot || !weeks.length) return [];

  const points = [];
  for (const w of weeks) {
    for (let i = 0; i < slotCount; i++) {
      points.push(`${w}-${dayOfWeek}-${startSlot + i}`);
    }
  }
  return points;
}

/**
 * 把多门课合并为占用集
 * @param {object[]} courses
 * @returns {Set<string>}
 */
function expandAll(courses) {
  const set = new Set();
  if (!Array.isArray(courses)) return set;
  for (const c of courses) {
    for (const p of expandCourse(c)) set.add(p);
  }
  return set;
}

/**
 * 展开为「周次 → 7×12 布尔网格」，供渲染与对齐复用
 * @param {Set<string>|string[]} occupiedSet
 * @param {number[]} weeks 需要展开的周次列表
 * @returns {Object} { [week]: boolean[7][12] }
 */
function toWeekGrid(occupiedSet, weeks) {
  const map = {};
  const set = occupiedSet instanceof Set ? occupiedSet : new Set(occupiedSet || []);

  for (const w of weeks) {
    const grid = Array.from({ length: 7 }, () => new Array(12).fill(false));
    map[w] = grid;
  }

  for (const key of set) {
    const [week, day, slot] = key.split('-').map(Number);
    if (!map[week]) continue;
    if (day >= 1 && day <= 7 && slot >= 1 && slot <= 12) {
      map[week][day - 1][slot - 1] = true;
    }
  }
  return map;
}

/**
 * 在指定周次/星期/节次上查找课程（用于渲染某个格子属于哪门课）
 * @returns {object|null}
 */
function findCourseAt(courses, week, dayOfWeek, slot) {
  const key = `${week}-${dayOfWeek}-${slot}`;
  for (const c of courses || []) {
    if (expandCourse(c).indexOf(key) !== -1) return c;
  }
  return null;
}

module.exports = {
  expandCourse,
  expandAll,
  toWeekGrid,
  findCourseAt
};
