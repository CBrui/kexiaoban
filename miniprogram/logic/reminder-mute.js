/**
 * logic/reminder-mute.js —— 单课程提醒开关的静音状态计算
 *
 * 为什么要抽出来（踩过的坑）：
 *   WXML 数据绑定**不支持方法调用**，模板里写
 *     checked="{{config.silentCourses.indexOf(item.id) !== -1}}"
 *   不会按预期求值，switch 的选中态永远是初始值 —— 表现就是
 *   「用户点了开关，数据其实写进去了，但开关纹丝不动」，看起来像点不了。
 *   布尔状态必须在 JS 里算好，再以字段的形式交给模板渲染。
 *
 * 放共享层的第二个理由：课程 id 在云上是字符串（_id）、本地是数字，
 * 两边的类型差异会让 indexOf 静默匹配失败。统一成字符串比较只在这一处做，
 * 页面不再各写一遍。
 */
const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** id 归一化：云课程 _id 是字符串，本地自增 id 是数字，比较前统一成字符串 */
function muteKey(id) {
  return id == null ? '' : String(id);
}

/**
 * 给课程列表补上 muted 字段（渲染用）与 slotText（同名课程区分用）
 * @param {Array} courses          课程列表
 * @param {string[]} silentCourses 已静音的课程 id
 * @returns {Array} 新数组，不修改入参
 */
function withMuted(courses, silentCourses) {
  const muted = (Array.isArray(silentCourses) ? silentCourses : []).map(muteKey);
  return (Array.isArray(courses) ? courses : []).map((c) => {
    const key = muteKey(c && c.id);
    return Object.assign({}, c, {
      muted: key !== '' && muted.indexOf(key) !== -1,
      slotText: slotTextOf(c)
    });
  });
}

/**
 * 切换某门课的静音状态
 * @param {string[]} silentCourses 当前静音列表
 * @param {string|number} id       课程 id
 * @returns {{ list: string[], muted: boolean }} 新的静音列表与该课切换后的状态
 */
function toggleMute(silentCourses, id) {
  const list = (Array.isArray(silentCourses) ? silentCourses : []).map(muteKey);
  const key = muteKey(id);
  const i = list.indexOf(key);
  if (i === -1) {
    list.push(key);
    return { list, muted: true };
  }
  list.splice(i, 1);
  return { list, muted: false };
}

/**
 * 课程的上课时段文案，如「周一 第1-2节」
 * 同名课程（大学物理A 有多个时段）靠它区分，否则用户不知道自己在关哪一门
 */
function slotTextOf(course) {
  if (!course) return '';
  const day = DAY_LABELS[Number(course.day_of_week) - 1];
  const start = Number(course.start_slot);
  if (!day || !start) return '';
  const count = Number(course.slot_count) || 1;
  return count > 1 ? `${day} 第${start}-${start + count - 1}节` : `${day} 第${start}节`;
}

module.exports = {
  muteKey,
  withMuted,
  toggleMute,
  slotTextOf
};
