/**
 * api/course.js —— 课程表 CRUD
 *
 * 所有课程读写都必须经过本模块。云模式下由行级安全策略保证数据隔离，
 * owner_id 由系统按登录身份自动写入，客户端不得自行指定。
 *
 * 多课表支持：每门课程通过 timetable_id 归属于某张课表。
 * 所有查询默认限定在「当前课表」范围内，避免不同课表的课程互相串场。
 * 若调用方明确传入 timetableId，则以传入的为准。
 */
const { getClient, getMode } = require('./client');
const { withIds } = require('./doc');
const store = require('./store');
const timetableApi = require('./timetable');

const TABLE = 'courses';

/**
 * 解析本次操作应属的课表 id
 * @param {string} [explicitId] 显式指定；不传则取当前课表
 */
async function resolveTimetableId(explicitId) {
  if (explicitId != null && explicitId !== '') return String(explicitId);
  const current = await timetableApi.getCurrentTimetable();
  return current ? String(current.id) : null;
}

/**
 * 获取课程列表
 * @param {string} [timetableId] 不传则取当前课表的课程
 * @returns {Promise<object[]>}
 */
async function listCourses(timetableId) {
  const tid = await resolveTimetableId(timetableId);
  if (tid == null) return [];

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db
      .collection(TABLE)
      .where({ timetable_id: tid })
      .orderBy('created_at', 'asc')
      .get();
    return withIds(res.data);
  }

  const rows = await store.select(TABLE);
  return rows
    .filter((c) => String(c.timetable_id) === tid)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

/**
 * 新增一门课程
 * 注意：不传 owner_id，由系统写入；timetable_id 默认落到当前课表。
 */
async function addCourse(course) {
  const tid = await resolveTimetableId(course.timetable_id);

  const payload = {
    name: course.name || '',
    teacher: course.teacher || '',
    location: course.location || '',
    day_of_week: Number(course.day_of_week),
    start_slot: Number(course.start_slot),
    slot_count: Number(course.slot_count) || 1,
    weeks: course.weeks || '1-16',
    raw_text: course.raw_text || '',
    source_type: course.source_type || 'manual',
    timetable_id: tid == null ? '' : tid,
    created_at: Date.now()
  };

  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).add({ data: payload });
    return { ...payload, id: res._id };
  }
  return store.insert(TABLE, payload);
}

/**
 * 批量新增（AI 建表确认后调用）
 */
async function addCourses(courses, timetableId) {
  const inserted = [];
  for (const c of courses || []) {
    inserted.push(await addCourse({ ...c, timetable_id: c.timetable_id || timetableId }));
  }
  return inserted;
}

/**
 * 更新课程
 */
async function updateCourse(id, patch) {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    await db.collection(TABLE).doc(id).update({ data: patch });
    return { ...patch, id };
  }
  return store.update(TABLE, id, patch);
}

/**
 * 删除课程
 */
async function removeCourse(id) {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    await db.collection(TABLE).doc(id).remove();
    return true;
  }
  return store.remove(TABLE, id);
}

/**
 * 读取指定朋友的课程（用于找搭子）
 *
 * 注意 1：这里不按 timetable_id 过滤 —— 朋友的课表 id 与本地无关，
 *         找搭子关心的是「对方全部课程造成的占用」，跨课表合并才符合语义。
 *
 * 注意 2：云模式下**必须走云函数**（findBuddy 的 getCourses 动作）。
 *         courses 集合是「仅创建者可读写」(PRIVATE)，客户端直查
 *         `where({ _openid })` 读不到别人的课程、只会返回空 ——
 *         这正是云模式下「找搭子」失效的根因。云函数具备管理端权限，
 *         并会先校验调用者与对方已建立 relations 关系后才返回课程。
 *
 * 注意 3：传进来的 ownerId 是 normalizeProfile 规范化后的身份
 *         （云模式下即对方的 _openid），云函数据此定位对方课程。
 */
async function listCoursesByOwner(ownerId) {
  if (!ownerId) return [];
  if (getMode() === 'cloud') {
    const res = await getClient().callFunction({
      name: 'findBuddy',
      data: { action: 'getCourses', friendOwnerId: String(ownerId) }
    });
    const r = (res && res.result) || null;
    if (!r || !r.ok) {
      throw new Error('读取对方课程失败：' + ((r && r.message) || (r && r.error) || '未知错误'));
    }
    return withIds(r.courses || []);
  }
  return store.select(TABLE, { owner_id: ownerId });
}

/**
 * 统计课程数
 * @param {string} [timetableId] 传则只统计该课表；不传则统计全部
 */
async function countCourses(timetableId) {
  if (timetableId != null) {
    return (await listCourses(timetableId)).length;
  }
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).count();
    return res.total || 0;
  }
  const rows = await store.select(TABLE);
  return rows.length;
}

module.exports = {
  listCourses,
  addCourse,
  addCourses,
  updateCourse,
  removeCourse,
  listCoursesByOwner,
  countCourses
};
