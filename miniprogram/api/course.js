/**
 * api/course.js —— 课程表 CRUD
 *
 * 所有课程读写都必须经过本模块。云模式下由行级安全策略保证数据隔离，
 * owner_id 由系统按登录身份自动写入，客户端不得自行指定。
 */
const { getClient, getMode } = require('./client');
const store = require('./store');

const TABLE = 'courses';

/**
 * 获取当前用户的全部课程
 * @returns {Promise<object[]>}
 */
async function listCourses() {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).orderBy('created_at', 'asc').get();
    return res.data || [];
  }
  return store.select(TABLE);
}

/**
 * 新增一门课程
 * 注意：不传 owner_id，由系统写入
 */
async function addCourse(course) {
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
async function addCourses(courses) {
  const inserted = [];
  for (const c of courses || []) {
    inserted.push(await addCourse(c));
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
 * 云模式下通过 relations 表校验关系后读取
 */
async function listCoursesByOwner(ownerId) {
  if (getMode() === 'cloud') {
    const db = getClient().database();
    const res = await db.collection(TABLE).where({ owner_id: ownerId }).get();
    return res.data || [];
  }
  return store.select(TABLE, { owner_id: ownerId });
}

module.exports = {
  listCourses,
  addCourse,
  addCourses,
  updateCourse,
  removeCourse,
  listCoursesByOwner
};
