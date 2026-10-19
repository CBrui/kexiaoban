/**
 * calendarFeed / holiday-data.js —— 云端内置种子数据（拷贝自 holidaySync）
 *
 * ⚠️ 与小程序端 miniprogram/logic/holiday.js 的 BUILTIN_RECORDS **同源同版本**。
 *    改动节假日数据时**两处必须同步**，否则会出现「云端把客户端的正确数据覆盖成旧数据」。
 *    改完记得把下面的 BUNDLE_VERSION 与小程序端 BUILTIN_VERSION 一起 +1。
 *
 * 为什么云函数里还要留一份：云函数首次调用时若 holidays 集合为空，会用它自动播种，
 * 这样部署完不用再去控制台手工建集合、导数据（本项目 CloudBase MCP 绑定的是已废弃环境，
 * 控制台侧操作不可靠，能自包含就自包含）。
 *
 * 数据来源：《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7号）
 */
const BUNDLE_VERSION = '2026.1';

const SEED_RECORDS = [
  { date: '2026-01-01', type: 'holiday', name: '元旦' },
  { date: '2026-01-02', type: 'holiday', name: '元旦' },
  { date: '2026-01-03', type: 'holiday', name: '元旦' },
  { date: '2026-01-04', type: 'makeup', name: '元旦调休上班' },

  { date: '2026-02-14', type: 'makeup', name: '春节调休上班' },
  { date: '2026-02-15', type: 'holiday', name: '春节' },
  { date: '2026-02-16', type: 'holiday', name: '春节' },
  { date: '2026-02-17', type: 'holiday', name: '春节' },
  { date: '2026-02-18', type: 'holiday', name: '春节' },
  { date: '2026-02-19', type: 'holiday', name: '春节' },
  { date: '2026-02-20', type: 'holiday', name: '春节' },
  { date: '2026-02-21', type: 'holiday', name: '春节' },
  { date: '2026-02-22', type: 'holiday', name: '春节' },
  { date: '2026-02-23', type: 'holiday', name: '春节' },
  { date: '2026-02-28', type: 'makeup', name: '春节调休上班' },

  { date: '2026-04-04', type: 'holiday', name: '清明节' },
  { date: '2026-04-05', type: 'holiday', name: '清明节' },
  { date: '2026-04-06', type: 'holiday', name: '清明节' },

  { date: '2026-05-01', type: 'holiday', name: '劳动节' },
  { date: '2026-05-02', type: 'holiday', name: '劳动节' },
  { date: '2026-05-03', type: 'holiday', name: '劳动节' },
  { date: '2026-05-04', type: 'holiday', name: '劳动节' },
  { date: '2026-05-05', type: 'holiday', name: '劳动节' },
  { date: '2026-05-09', type: 'makeup', name: '劳动节调休上班' },

  { date: '2026-06-19', type: 'holiday', name: '端午节' },
  { date: '2026-06-20', type: 'holiday', name: '端午节' },
  { date: '2026-06-21', type: 'holiday', name: '端午节' },

  { date: '2026-09-25', type: 'holiday', name: '中秋节' },
  { date: '2026-09-26', type: 'holiday', name: '中秋节' },
  { date: '2026-09-27', type: 'holiday', name: '中秋节' },

  { date: '2026-09-20', type: 'makeup', name: '国庆调休上班' },
  { date: '2026-10-01', type: 'holiday', name: '国庆节' },
  { date: '2026-10-02', type: 'holiday', name: '国庆节' },
  { date: '2026-10-03', type: 'holiday', name: '国庆节' },
  { date: '2026-10-04', type: 'holiday', name: '国庆节' },
  { date: '2026-10-05', type: 'holiday', name: '国庆节' },
  { date: '2026-10-06', type: 'holiday', name: '国庆节' },
  { date: '2026-10-07', type: 'holiday', name: '国庆节' },
  { date: '2026-10-10', type: 'makeup', name: '国庆调休上班' },

  // 2027 年只放元旦：1 月 1 日放假是法定节日（不依赖每年调休通知），可提前收录；
  // 其余 2027 年假期等国办通知发布后由云端下发补充
  { date: '2027-01-01', type: 'holiday', name: '元旦' }
];

module.exports = { BUNDLE_VERSION, SEED_RECORDS };
