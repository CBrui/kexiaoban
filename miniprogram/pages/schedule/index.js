/**
 * pages/schedule/index.js —— 节次设置
 *
 * 用户可以自定义上午 / 下午 / 晚间各几节，
 * 系统据此重算整张课表的时间轴。
 *
 * 关键约束：调整节数后，若已有课程超出新的节次范围，
 *           这些课程会被自动裁剪，并在界面上明确提示用户。
 */
const {
  getSchedule,
  saveSchedule,
  resetSchedule,
  buildTimeline,
  getTotalSlots
} = require('../../utils/schedule');
const { updateCourse, listCourses } = require('../../api/course');
const config = require('../../config');

const app = getApp();

// 可选的大节时长（分钟）：45=单小节 / 90=两小节连上 / 95=两小节+5分休息 / 100=两小节+10分休息
const DURATIONS = [45, 90, 95, 100];

// 每个时段的大节数上限（与 config 保持一致）
const MAX_PER_SEG = config.SCHEDULE.maxSlotsPerSegment;

Page({
  data: {
    segments: [],          // [{ key, label, slots, startFirst, duration }]
    breakWithinSegment: 10,
    durationOptions: DURATIONS,
    totalSlots: 0,

    // 预览用的时间轴
    preview: [],
    segmentMeta: [],
    breaks: [],

    // 待确认的越界课程数量
    overflowCount: 0,
    overflowCourses: [],

    dirty: false           // 是否有未保存的修改
  },

  onLoad() {
    this.loadConfig();
  },

  loadConfig() {
    const sched = getSchedule();
    this.setData({
      segments: sched.segments.map((s) => ({
        ...s,
        durationIndex: Math.max(0, DURATIONS.indexOf(Number(s.duration)))
      })),
      breakWithinSegment: sched.breakWithinSegment,
      dirty: false
    });
    this.refreshPreview();
  },

  /**
   * 重算预览（不落库）
   */
  refreshPreview() {
    const cfg = this.buildConfig();
    const timeline = buildTimeline(cfg);

    const preview = timeline.slots.map((s) => ({
      slot: s.slot,
      text: `${s.start}-${s.end}`,
      segmentLabel: s.segmentLabel
    }));

    this.setData({
      preview,
      segmentMeta: timeline.segments,
      breaks: timeline.breaks,
      totalSlots: timeline.totalSlots
    });

    // 检查是否有课程超出新范围
    this.checkOverflow(timeline.totalSlots);
  },

  /**
   * 由当前编辑状态拼出配置对象
   */
  buildConfig() {
    return {
      segments: this.data.segments.map((s) => ({
        key: s.key,
        label: s.label,
        slots: Number(s.slots) || 0,
        startFirst: s.startFirst,
        duration: Number(s.duration) || 45
      })),
      breakWithinSegment: Number(this.data.breakWithinSegment) || 0,
      segmentBreaks: [
        { afterKey: 'morning', label: '午休' },
        { afterKey: 'afternoon', label: '晚休' }
      ]
    };
  },

  /**
   * 检查超界课程
   */
  async checkOverflow(totalSlots) {
    try {
      const courses = (await listCourses()) || [];
      const overflow = courses.filter((c) => {
        const end = Number(c.start_slot) + (Number(c.slot_count) || 1) - 1;
        return end > totalSlots;
      });
      this.setData({
        overflowCount: overflow.length,
        overflowCourses: overflow.map((c) => ({
          id: c.id,
          name: c.name,
          start_slot: c.start_slot,
          slot_count: c.slot_count
        }))
      });
    } catch (e) {
      console.error('[schedule] 检查超界课程失败', e);
    }
  },

  /* ================= 编辑操作 ================= */

  onSlotsMinus(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const seg = this.data.segments[idx];
    const next = Math.max(0, Number(seg.slots) - 1);
    this.setData({ [`segments[${idx}].slots`]: next, dirty: true });
    this.refreshPreview();
  },

  onSlotsPlus(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const seg = this.data.segments[idx];
    const next = Math.min(MAX_PER_SEG, Number(seg.slots) + 1);
    this.setData({ [`segments[${idx}].slots`]: next, dirty: true });
    this.refreshPreview();
  },

  onSlotsInput(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v)) v = 0;
    v = Math.max(0, Math.min(MAX_PER_SEG, v));
    this.setData({ [`segments[${idx}].slots`]: v, dirty: true });
    this.refreshPreview();
  },

  onStartChange(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ [`segments[${idx}].startFirst`]: e.detail.value, dirty: true });
    this.refreshPreview();
  },

  onDurationChange(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const di = Number(e.detail.value);
    const dur = DURATIONS[di];
    this.setData({
      [`segments[${idx}].duration`]: dur,
      [`segments[${idx}].durationIndex`]: di,
      dirty: true
    });
    this.refreshPreview();
  },

  onBreakInput(e) {
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v)) v = 0;
    v = Math.max(0, Math.min(30, v));
    this.setData({ breakWithinSegment: v, dirty: true });
    this.refreshPreview();
  },

  /* ================= 保存 / 重置 ================= */

  async onSave() {
    const total = this.data.totalSlots;
    if (total <= 0) {
      wx.showToast({ title: '至少需要保留一节课', icon: 'none' });
      return;
    }

    // 有超界课程时，先说明影响再让用户确认
    if (this.data.overflowCount > 0) {
      const names = this.data.overflowCourses.map((c) => c.name).join('、');
      wx.showModal({
        title: '有课程超出新的节次范围',
        content: `共 ${this.data.overflowCount} 门课程排在第 ${total} 节之后：${names}。保存后这些课程将被自动裁剪为第 ${total} 节结束。是否继续？`,
        confirmText: '继续保存',
        confirmColor: '#f53f3f',
        success: (res) => {
          if (res.confirm) this.doSave(total);
        }
      });
      return;
    }

    this.doSave(total);
  },

  async doSave(total) {
    wx.showLoading({ title: '保存中' });
    try {
      // 1. 保存作息配置
      saveSchedule(this.buildConfig());

      // 2. 裁剪超界课程
      let trimmed = 0;
      for (const c of this.data.overflowCourses) {
        const maxCount = total - Number(c.start_slot) + 1;
        if (maxCount <= 0) {
          // 起止节次完全越界：整门课挪到最后一节，保留信息不丢数据
          await updateCourse(c.id, { start_slot: total, slot_count: 1 });
        } else {
          await updateCourse(c.id, { slot_count: maxCount });
        }
        trimmed += 1;
      }

      wx.hideLoading();
      this.setData({ dirty: false, overflowCount: 0, overflowCourses: [] });

      const msg = trimmed > 0
        ? `已保存，${trimmed} 门课程已裁剪`
        : '已保存';
      wx.showToast({ title: msg, icon: 'success', duration: 2000 });

      setTimeout(() => wx.navigateBack(), 1200);
    } catch (e) {
      wx.hideLoading();
      console.error('[schedule] 保存失败', e);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  onReset() {
    const desc = config.SCHEDULE.segments
      .map((s) => `${s.label} ${s.slots} 节`)
      .join('、');
    wx.showModal({
      title: '恢复默认作息',
      content: `将恢复为${desc}，确定继续吗？`,
      success: (res) => {
        if (!res.confirm) return;
        resetSchedule();
        this.loadConfig();
        wx.showToast({ title: '已恢复默认', icon: 'success' });
      }
    });
  },

  onBack() {
    if (!this.data.dirty) {
      wx.navigateBack();
      return;
    }
    wx.showModal({
      title: '放弃修改',
      content: '当前有未保存的修改，确定离开吗？',
      success: (res) => {
        if (res.confirm) wx.navigateBack();
      }
    });
  }
});
