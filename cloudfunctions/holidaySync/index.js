/**
 * holidaySync —— 节假日 / 调休数据的云端下发
 *
 * 动作：
 *   getHolidays  拉取全部节假日记录（客户端启动时调用，结果会与内置表合并后缓存）
 *
 * 设计要点：
 *   1. 集合不存在或为空时**自动播种**内置种子数据，部署完无需手工建集合导数据
 *   2. 查询走分页：云函数端单次 get() 上限 100 条，超出会**静默丢弃**
 *      （不报错、不警告），直接 .get() 是本项目踩过的坑
 *   3. 集合权限保持默认（仅创建者可读写）即可 —— 云函数用 admin 权限读，
 *      不需要改成「所有用户可读」，也就不用去控制台改权限
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION = 'holidays';
const PAGE_SIZE = 100;

// 平铺在同目录（不要放 lib/ 子目录：部署通道只上传顶层文件）
const { BUNDLE_VERSION, SEED_RECORDS } = require('./holiday-data');

/**
 * 分页拉全量
 * ⚠️ 「刚好满一页」时无法判断是否还有更多，必须多探一次空页，这是正确性必需的代价
 */
async function fetchAll(where) {
  const out = [];
  let skip = 0;
  for (let guard = 0; guard < 50; guard++) {
    let q = db.collection(COLLECTION);
    if (where) q = q.where(where);
    const page = await q.skip(skip).limit(PAGE_SIZE).get();
    const list = (page && page.data) || [];
    out.push(...list);
    if (list.length < PAGE_SIZE) break;
    skip += list.length;
  }
  return out;
}

const ok = (data) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error: String(error) });

/**
 * 播种：仅在集合为空时执行，已有数据绝不覆盖（管理员在控制台改过的数据要保住）
 * 集合不存在时先建集合再播种 —— 云函数是 admin 权限，可以直接 createCollection，
 * 这样部署后真正零手工步骤
 */
async function seedIfEmpty() {
  let existing;
  try {
    existing = await fetchAll();
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
    await db.createCollection(COLLECTION);
    existing = [];
  }
  if (existing.length) return { seeded: false, count: existing.length };

  for (const r of SEED_RECORDS) {
    await db.collection(COLLECTION).add({
      data: {
        date: r.date,
        type: r.type,
        name: r.name,
        source: 'seed',
        bundle_version: BUNDLE_VERSION,
        created_at: Date.now()
      }
    });
  }
  return { seeded: true, count: SEED_RECORDS.length };
}

/** 集合不存在的错误特征（-502005 / collection not exists） */
function isCollectionMissing(e) {
  const msg = String((e && e.message) || e);
  return msg.indexOf('-502005') !== -1 || msg.indexOf('collection not exists') !== -1;
}

async function getHolidays() {
  let seedInfo = { seeded: false, count: 0 };
  try {
    seedInfo = await seedIfEmpty();
  } catch (e) {
    // 播种失败不致命：下面照常读，读不到就返回空，客户端用内置表
  }

  let records = [];
  try {
    records = await fetchAll();
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
    // 集合建不出来（极端情况）→ 空表，客户端静默降级内置表
  }
  const list = records
    .filter((r) => r && r.date)
    .map((r) => ({
      date: r.date,
      type: r.type === 'makeup' ? 'makeup' : 'holiday',
      name: r.name || ''
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return ok({
    records: list,
    version: BUNDLE_VERSION,
    seeded: seedInfo.seeded,
    count: list.length
  });
}

exports.main = async (event) => {
  const action = (event && event.action) || 'getHolidays';
  try {
    if (action === 'getHolidays') return await getHolidays();
    return fail(`未知 action: ${action}`);
  } catch (e) {
    // 平台只笼统报 functions execute fail，这里把真实错误带出去
    return fail((e && e.message) || e);
  }
};
