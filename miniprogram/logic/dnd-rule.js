/**
 * logic/dnd-rule.js —— 免打扰判定算法
 *
 * 本项目「把不提醒做成可解释功能」的核心。
 * 判定必须按固定顺序执行，避免出现「调休日用户设置了免打扰，到底响不响」的歧义。
 *
 * 优先级（严格按下表顺序，命中即返回）：
 *   1. 该日为法定节假日        → 不提醒（最高优先级）
 *   2. 该日为用户自定义不提醒日期 → 不提醒
 *   3. 提醒时刻落入免打扰时间段  → 不提醒
 *   4. 该日为调休补课日        → 正常提醒（覆盖「周末不提醒」默认规则）
 *   5. 该门课已单独关闭提醒      → 不提醒
 *   6. 其他情况                → 正常提醒
 *
 * 核心风险：第 1 步与第 4 步的顺序。调休意味着「某个周六要上周一的课」
 * 与「某个工作日在放长假」会同时存在，必须依靠日期精确匹配，
 * 禁止用「周末 / 工作日」的粗粒度规则替代。
 */

/**
 * 判断某时刻是否落在免打扰时段集合中
 * @param {string} timeStr "HH:mm"
 * @param {Array<{from:string,to:string}>} ranges
 */
function inSilentRange(timeStr, ranges) {
  if (!timeStr || !Array.isArray(ranges)) return false;
  return ranges.some((r) => timeStr >= r.from && timeStr <= r.to);
}

/**
 * 免打扰判定
 * @param {object} ctx
 * @param {string} ctx.date              "YYYY-MM-DD"
 * @param {string} [ctx.timeStr]         "HH:mm"，用于判断免打扰时段
 * @param {boolean} [ctx.isHoliday]      该日是否法定节假日
 * @param {boolean} [ctx.isMakeupWorkday] 该日是否调休补课日
 * @param {object} [ctx.userConfig]
 * @param {string[]} [ctx.userConfig.silentDates]   自定义不提醒日期
 * @param {Array<{from,to}>} [ctx.userConfig.silentRanges] 免打扰时间段
 * @param {number[]} [ctx.userConfig.silentCourses] 单独静音的课程 id
 * @param {boolean} [ctx.userConfig.globalMute]     全局关闭
 * @param {object} [ctx.course]  当前课程 { id }
 * @returns {{notify: boolean, reason: string}} 同时返回原因，供界面解释
 */
function shouldNotify(ctx) {
  const cfg = (ctx && ctx.userConfig) || {};

  // 0. 全局开关（需求 F3.5）
  if (cfg.globalMute) return { notify: false, reason: '已全局关闭提醒' };

  // 1. 法定节假日 —— 最高优先级
  if (ctx.isHoliday) return { notify: false, reason: '法定节假日静默' };

  // 2. 自定义不提醒日期
  if (Array.isArray(cfg.silentDates) && cfg.silentDates.indexOf(ctx.date) !== -1) {
    return { notify: false, reason: '你设置了该日不提醒' };
  }

  // 3. 免打扰时间段
  if (inSilentRange(ctx.timeStr, cfg.silentRanges)) {
    return { notify: false, reason: '该时刻在你的免打扰时段内' };
  }

  // 4. 调休补课日 —— 覆盖「周末不提醒」的默认规则
  if (ctx.isMakeupWorkday) return { notify: true, reason: '调休补课日，正常提醒' };

  // 5. 单课程静默
  const courseId = ctx.course && ctx.course.id;
  if (Array.isArray(cfg.silentCourses) && courseId != null && cfg.silentCourses.indexOf(courseId) !== -1) {
    return { notify: false, reason: '该课程已单独关闭提醒' };
  }

  // 6. 正常提醒
  return { notify: true, reason: '正常提醒' };
}

/**
 * 把节假日/调休数据整理为按日期索引的查询表
 * @param {Array<{date:string, type:'holiday'|'makeup'}>} records
 */
function buildCalendarIndex(records) {
  const index = {};
  for (const r of records || []) {
    if (!r || !r.date) continue;
    index[r.date] = r.type;
  }
  return index;
}

/**
 * 结合日历索引的便捷判定
 */
function shouldNotifyWithCalendar(ctx, calendarIndex) {
  const type = (calendarIndex || {})[ctx.date];
  return shouldNotify({
    ...ctx,
    isHoliday: type === 'holiday',
    isMakeupWorkday: type === 'makeup'
  });
}

module.exports = {
  shouldNotify,
  shouldNotifyWithCalendar,
  inSilentRange,
  buildCalendarIndex
};
