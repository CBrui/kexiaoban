/**
 * api/timetable.js —— 课表（元数据）CRUD
 *
 * 本项目支持「多张课表」：每张课表有自己的名称、开课时间（第 1 周周一）
 * 与总周次，互不干扰。典型用途：
 *   - 本学期课表 / 下学期课表并存
 *   - 主修课表 / 辅修课表并存
 *
 * 数据模型：
 *   timetables
 *     id                  自增主键，本地模式为 number，云模式为 _id
 *     name                课表名称，如「2026 秋 主修」
 *     term_start_monday   第 1 周周一日期 "YYYY-MM-DD"，周次→日期换算的基准
 *     total_weeks         学期总周数，如 20
 *     is_current          是否为当前正在查看的课表（全局同时只有一张为 true）
 *     created_at          创建时间戳
 *
 *   courses
 *     …（原有字段）
 *     timetable_id        所属课表 id（本次新增，用于隔离不同课表的课程）
 *
 * 关键约束（由本模块保证）：
 *   1. is_current 全局唯一 —— setCurrent 会先把其它课表置 false
 *   2. 删除课表时**级联删除**其下课程，避免产生无归属的孤儿数据
 *   3. 首次使用时自动创建「默认课表」，并把历史课程（无 timetable_id）迁移过来
 */
const { getClient, getMode } = require('./client');
const store = require('./store');
const config = require('../config');

const TABLE = 'timetables';
const COURSE_TABLE = 'courses';

// 当前课表 id 的本地缓存键（避免每次读课表都遍历列表）
const CURRENT_KEY = 'kxb:current_timetable_id';
// 迁移标记：确认历史课程已归入默认课表，避免重复迁移
const MIGRATED_KEY = 'kxb:migrated_multi_timetable';

const TOTAL_WEEKS_MIN = 1;
const TOTAL_WEEKS_MAX = 30;

/* ==================== 工具 ==================== */

function clampTotalWeeks(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return config.DEFAULT_TOTAL_WEEKS || 20;
  return Math.max(TOTAL_WEEKS_MIN, Math.min(TOTAL_WEEKS_MAX, n));
}

/**
 * 校验开课日期格式，非法时回退到 config 默认值
 */
function normalizeTermStart(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    const d = new Date(v.trim());
    if (!isNaN(d.getTime())) return v.trim();
  }
  return config.TERM_START_MONDAY;
}

/**
 * 计算某张课表的结束日期（第 total_weeks 周周日）
 */
function endDateOf(timetable) {
  const start = new Date(timetable.term_start_monday);
  if (isNaN(start.getTime())) return null;
  const days = (Number(timetable.total_weeks) - 1) * 7 + 6;
  start.setDate(start.getDate() + days);
  return start;
}

/* ==================== 查询 ==================== */

/**
 * 全部课表（按创建时间升序）
 */
async function listTimetables() {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).orderBy('created_at', 'asc').get();
    return res.data || [];
  }
  const rows = await store.select(TABLE);
  return rows.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

/**
 * 取当前课表。没有课表时返回 null（由调用方决定是否自动创建）。
 *
 * 优先读本地缓存的 id；缓存失效（课表被删）时回退到「标记为 is_current 的那张」，
 * 再回退到「第一张」，保证总能拿到一个可用结果。
 */
async function getCurrentTimetable() {
  const list = await listTimetables();
  if (!list.length) return null;

  let cachedId = null;
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      cachedId = wx.getStorageSync(CURRENT_KEY);
    }
  } catch (e) {
    cachedId = null;
  }

  if (cachedId != null) {
    const hit = list.find((t) => String(t.id) === String(cachedId));
    if (hit) return hit;
  }

  const flagged = list.find((t) => t.is_current);
  const fallback = flagged || list[0];
  writeCurrentCache(fallback.id);
  return fallback;
}

/**
 * 按 id 取课表
 */
async function getTimetable(id) {
  if (id == null) return null;
  const list = await listTimetables();
  return list.find((t) => String(t.id) === String(id)) || null;
}

function writeCurrentCache(id) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(CURRENT_KEY, id);
    }
  } catch (e) {
    /* ignore */
  }
}

/* ==================== 写入 ==================== */

/**
 * 新建课表
 * @param {{name:string, term_start_monday:string, total_weeks:number, is_current?:boolean}} input
 */
async function addTimetable(input) {
  const payload = {
    name: (input.name || '').trim() || '未命名课表',
    term_start_monday: normalizeTermStart(input.term_start_monday),
    total_weeks: clampTotalWeeks(input.total_weeks),
    is_current: false,
    created_at: Date.now()
  };

  let created;
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).add({ data: payload });
    created = { ...payload, id: res._id };
  } else {
    created = await store.insert(TABLE, payload);
  }

  // 第一张课表自动成为当前课表
  const all = await listTimetables();
  if (all.length === 1) {
    await setCurrent(created.id);
    created.is_current = true;
  }
  return created;
}

/**
 * 更新课表（名称 / 开课时间 / 总周次）
 */
async function updateTimetable(id, patch) {
  const next = {};
  if (patch.name !== undefined) next.name = (patch.name || '').trim() || '未命名课表';
  if (patch.term_start_monday !== undefined) {
    next.term_start_monday = normalizeTermStart(patch.term_start_monday);
  }
  if (patch.total_weeks !== undefined) {
    next.total_weeks = clampTotalWeeks(patch.total_weeks);
  }

  if (getMode() === 'cloud') {
    const db = getClient().database();
    await db.collection(TABLE).doc(id).update({ data: next });
    return { ...next, id };
  }
  return store.update(TABLE, id, next);
}

/**
 * 设为当前课表（保证全局唯一）
 */
async function setCurrent(id) {
  const list = await listTimetables();

  for (const t of list) {
    const shouldBeCurrent = String(t.id) === String(id);
    if (!!t.is_current === shouldBeCurrent) continue;

    if (getMode() === 'cloud') {
      const db = getClient().database();
      await db.collection(TABLE).doc(t.id).update({ data: { is_current: shouldBeCurrent } });
    } else {
      await store.update(TABLE, t.id, { is_current: shouldBeCurrent });
    }
  }

  writeCurrentCache(id);
  return true;
}

/**
 * 删除课表，并级联删除其下所有课程。
 *
 * 为什么级联：课程必须归属于某张课表，留下 timetable_id 指向不存在课表的记录
 * 会成为永远显示不出来的孤儿数据，且会污染「找搭子」的占用计算。
 *
 * @returns {{removedCourses:number}} 一并删除的课程数
 */
async function removeTimetable(id) {
  // 1. 先删课程
  const courses = await listCoursesOf(id);
  for (const c of courses) {
    if (getMode() === 'cloud') {
      const db = getClient().database();
      await db.collection(COURSE_TABLE).doc(c.id).remove();
    } else {
      await store.remove(COURSE_TABLE, c.id);
    }
  }

  // 2. 再删课表本身
  if (getMode() === 'cloud') {
    const db = getClient().database();
    await db.collection(TABLE).doc(id).remove();
  } else {
    await store.remove(TABLE, id);
  }

  // 3. 若删的是当前课表，把当前指针挪到剩下第一张
  const rest = await listTimetables();
  if (rest.length) {
    await setCurrent(rest[0].id);
  } else {
    writeCurrentCache('');
  }

  return { removedCourses: courses.length };
}

/* ==================== 课程归属 ==================== */

/**
 * 取某张课表下的课程
 */
async function listCoursesOf(timetableId) {
  if (timetableId == null) return [];
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db
      .collection(COURSE_TABLE)
      .where({ timetable_id: String(timetableId) })
      .orderBy('created_at', 'asc')
      .get();
    return res.data || [];
  }
  const rows = await store.select(COURSE_TABLE);
  return rows
    .filter((c) => String(c.timetable_id) === String(timetableId))
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

/**
 * 统计某张课表的课程数（管理页列表用）
 */
async function countCoursesOf(timetableId) {
  const list = await listCoursesOf(timetableId);
  return list.length;
}

/* ==================== 初始化与数据迁移 ==================== */

/**
 * 确保至少有一张课表，并把历史课程迁移到默认课表。
 *
 * 迁移的必要性：本次改动之前创建的课程没有 timetable_id 字段，
 * 若不迁移，用户升级后会看到「课表一片空白」——数据还在但显示不出来。
 *
 * 幂等：由 MIGRATED_KEY 标记保护，只执行一次。
 *
 * @returns {Promise<object>} 当前课表
 */
async function ensureDefaultTimetable() {
  let list = await listTimetables();

  // 1. 没有任何课表 → 创建默认课表
  if (!list.length) {
    const created = await addTimetable({
      name: '我的课表',
      term_start_monday: config.TERM_START_MONDAY,
      total_weeks: config.DEFAULT_TOTAL_WEEKS || 20
    });
    list = await listTimetables();
    const current = list.find((t) => String(t.id) === String(created.id)) || list[0];
    await migrateOrphanCourses(current.id);
    return current;
  }

  // 2. 已有课表 → 补齐当前指针，并处理未迁移的历史课程
  const current = (await getCurrentTimetable()) || list[0];
  if (!current.is_current) await setCurrent(current.id);
  await migrateOrphanCourses(current.id);
  return current;
}

/**
 * 把没有 timetable_id 的课程挂到指定课表下（只做一次）
 */
async function migrateOrphanCourses(timetableId) {
  let done = false;
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      done = !!wx.getStorageSync(MIGRATED_KEY);
    }
  } catch (e) {
    done = false;
  }
  if (done) return 0;

  const all = getMode() === 'cloud'
    ? ((await getClient().database().collection(COURSE_TABLE).get()).data || [])
    : await store.select(COURSE_TABLE);

  const orphans = all.filter((c) => c.timetable_id == null);
  for (const c of orphans) {
    if (getMode() === 'cloud') {
      const db = getClient().database();
      await db.collection(COURSE_TABLE).doc(c.id).update({
        data: { timetable_id: String(timetableId) }
      });
    } else {
      await store.update(COURSE_TABLE, c.id, { timetable_id: String(timetableId) });
    }
  }

  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(MIGRATED_KEY, true);
    }
  } catch (e) {
    /* ignore */
  }
  return orphans.length;
}

module.exports = {
  listTimetables,
  getCurrentTimetable,
  getTimetable,
  addTimetable,
  updateTimetable,
  setCurrent,
  removeTimetable,
  listCoursesOf,
  countCoursesOf,
  ensureDefaultTimetable,
  endDateOf,
  clampTotalWeeks,
  TOTAL_WEEKS_MIN,
  TOTAL_WEEKS_MAX
};
