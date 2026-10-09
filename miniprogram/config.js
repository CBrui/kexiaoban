/**
 * config.js —— 环境配置与默认作息参数
 *
 * 云环境 ID 请替换为你自己的环境 ID。
 * 建议：真实项目把该文件加入 .gitignore，或改用 ext.json 注入，
 *       避免把环境凭证提交到公开仓库。
 */
module.exports = {
  // 云开发环境 ID（在微信开发者工具「云开发 - 设置 - 环境ID」查看）
  CLOUD_ENV_ID: 'your-cloud-env-id',

  // 是否启用真实云服务。false 时数据访问层降级为本地存储，便于无云环境时开发调试。
  USE_CLOUD: false,

  // 学期第 1 周周一日期（用于周次 → 日期换算），格式 YYYY-MM-DD
  //
  // 注意：这是**新建课表时的默认值**。项目支持多张课表，每张课表各自
  // 保存自己的 term_start_monday 与 total_weeks，实际生效的是当前课表的配置。
  // 用户可在「我的 → 课表管理」里为每张课表单独设置。
  TERM_START_MONDAY: '2026-09-07',

  // 新建课表时的默认总周数
  DEFAULT_TOTAL_WEEKS: 20,

  // 课表截图上传后的保留周期（天）
  IMAGE_RETENTION_DAYS: 7,

  /**
   * 默认作息参数
   *
   * 说明：高校课程普遍按「大节」上课——一节大课约 95 分钟（两小节 45+45，
   * 中间 5 分钟休息也算在内）。因此这里把「一节」定义为一个大节，节次列
   * 只显示该大节的完整时间段（如 08:00-09:35），不再拆成 45 分钟的小节。
   * 用户仍可在「节次设置」页自由调整节数、时长与课间。
   *
   * 每个 segment：
   *   key        标识
   *   label      显示名
   *   slots      该时段的大节数
   *   startFirst 第 1 节开始时间
   *   duration   每节（大节）时长（分钟），已含中间休息
   */
  SCHEDULE: {
    segments: [
      { key: 'morning', label: '上午', slots: 2, startFirst: '08:00', duration: 95 },
      { key: 'afternoon', label: '下午', slots: 2, startFirst: '14:00', duration: 95 },
      { key: 'evening', label: '晚间', slots: 2, startFirst: '19:00', duration: 95 }
    ],

    // 两大节之间的课间休息（分钟）
    breakWithinSegment: 20,

    // 时段之间的休息时段展示信息
    segmentBreaks: [
      { afterKey: 'morning', label: '午休' },
      { afterKey: 'afternoon', label: '晚休' }
    ],

    // 节数约束
    minSlotsPerSegment: 0,
    maxSlotsPerSegment: 6,
    maxTotalSlots: 16
  },

  // 默认总节次（由 SCHEDULE 计算得出，此处仅供未初始化时的兜底）
  MAX_SLOT: 6
};
