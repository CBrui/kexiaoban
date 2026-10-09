/**
 * api/doc.js —— 文档主键归一化
 *
 * 背景（本项目云 / 本地双模式的字段差异）：
 *   - 云开发（NoSQL）文档的主键字段是 `_id`；
 *   - 本地存储适配器（api/store.js）生成的记录主键字段是 `id`。
 *
 * 上层业务代码统一按 `id` 使用文档主键。因此凡是「从云端读回来的记录」，
 * 都必须先经过本模块补上 `id`，否则 `record.id` 会是 undefined。
 *
 * 典型故障（真实踩过）：
 *   云模式下 `listTimetables()` 直接返回原始云文档（只有 `_id`），
 *   随后 `setCurrent()` 执行 `db.collection('timetables').doc(t.id).update(...)`，
 *   因 `t.id === undefined` 抛：
 *     Error: collection.doc:fail -1 . docId must not be empty
 *   表现为「本地模式一切正常，一切云就写不进去」。
 *
 * 约定：本模块只做字段补齐，不修改原对象。
 */

/**
 * 给单个云文档补上 id（= _id）。已带 id（本地记录 / 已归一化）或空值原样返回。
 * @param {object|null|undefined} doc
 * @returns {object|null|undefined}
 */
function withId(doc) {
  if (!doc || doc.id !== undefined) return doc;
  return { ...doc, id: doc._id };
}

/**
 * 批量归一化
 * @param {object[]} list
 * @returns {object[]}
 */
function withIds(list) {
  return (list || []).map(withId);
}

module.exports = { withId, withIds };
