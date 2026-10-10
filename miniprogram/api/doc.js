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
 *
 * 另外，本模块还负责「从云端把数据读全」——见 fetchAll。
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

/**
 * 分页拉全量。云模式下**所有可能超过 20 条的查询都必须走这里**，不能直接 .get()。
 *
 * 为什么必须：小程序云数据库「客户端」单次 get() 上限是 20 条（云函数端是 100 条），
 * 超出的部分被**静默丢弃**——不报错、不警告、不分页提示，查询正常返回。
 * 于是表现成一个极具迷惑性的现象：写入明明成功、数据库里也查得到，
 * 但界面上就是看不到，而且丢的永远是排序最靠后的那批（通常正是刚新增的）。
 *
 * 本项目的真实踩坑现场：一张课表已有 20 门课，调课新增的课程按 created_at
 * 升序排在最末尾，正好落在 20 条之外 —— 调课提示「已调整」，课表页却毫无变化。
 *
 * @param {object} query 已 where / orderBy（或裸 collection）的云数据库 Query 对象
 * @param {object} [options] { pageSize = 20, max = 2000 } 单页大小与总量安全阀
 * @returns {Promise<object[]>} 全部记录
 */
async function fetchAll(query, options) {
  const pageSize = (options && options.pageSize) || 20;
  const max = (options && options.max) || 2000;
  const all = [];
  let skip = 0;

  for (;;) {
    const res = await query.skip(skip).limit(pageSize).get();
    const batch = (res && res.data) || [];
    for (let i = 0; i < batch.length; i++) all.push(batch[i]);
    // 本页没满 → 已是最后一页
    if (batch.length < pageSize) break;
    skip += batch.length;
    if (skip >= max) {
      console.warn('[db] fetchAll 触达总量上限，可能仍有数据未取回', { skip, max });
      break;
    }
  }
  return all;
}

module.exports = { withId, withIds, fetchAll };
