/**
 * api/store.js —— 本地存储适配器
 *
 * 在未接入云环境时提供与云数据库一致的操作语义，
 * 使业务代码不需要区分「云 / 本地」两种模式。
 *
 * 云模式下本模块不被使用。
 */

const PREFIX = 'kxb:';

function tableKey(table) {
  return `${PREFIX}${table}`;
}

function readTable(table) {
  try {
    const raw = wx.getStorageSync(tableKey(table));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[store] 读取失败', table, e);
    return [];
  }
}

function writeTable(table, rows) {
  try {
    wx.setStorageSync(tableKey(table), rows);
  } catch (e) {
    console.error('[store] 写入失败', table, e);
  }
}

/**
 * 查询
 * @param {string} table
 * @param {object} [where] 简单等值筛选
 */
async function select(table, where) {
  let rows = readTable(table);
  if (where && typeof where === 'object') {
    rows = rows.filter((r) =>
      Object.keys(where).every((k) => r[k] === where[k])
    );
  }
  return rows;
}

/**
 * 插入一条，自动分配自增 id
 */
async function insert(table, record) {
  const rows = readTable(table);
  const nextId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  const row = { ...record, id: record.id != null ? record.id : nextId };
  rows.push(row);
  writeTable(table, rows);
  return row;
}

/**
 * 批量插入
 */
async function insertMany(table, records) {
  const inserted = [];
  for (const r of records || []) {
    inserted.push(await insert(table, r));
  }
  return inserted;
}

/**
 * 更新（按 id 匹配）
 */
async function update(table, id, patch) {
  const rows = readTable(table);
  const idx = rows.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch };
  writeTable(table, rows);
  return rows[idx];
}

/**
 * 删除（按 id）
 */
async function remove(table, id) {
  const rows = readTable(table);
  const next = rows.filter((r) => String(r.id) !== String(id));
  writeTable(table, next);
  return next.length !== rows.length;
}

/**
 * 清空（调试用）
 */
async function clear(table) {
  writeTable(table, []);
}

module.exports = { select, insert, insertMany, update, remove, clear, readTable, writeTable };
