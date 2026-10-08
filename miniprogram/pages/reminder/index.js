/**
 * pages/reminder/index.js —— 提醒设置
 *
 * 核心：把「不提醒」做成可解释的功能。
 * 用户不仅知道「今天没提醒」，还能知道「为什么」。
 */
const store = require('../../api/store');
const { shouldNotifyWithCalendar, buildCalendarIndex } = require('../../logic/dnd-rule');
const { listCourses } = require('../../api/course');

const app = getApp();
const CONFIG_KEY = 'reminder_config';

// 演示用的节假日/调休数据（真实项目从云端拉取，内置一份保证离线可用）
const DEMO_CALENDAR = [
  { date: '2026-10-01', type: 'holiday' },
  { date: '2026-10-02', type: 'holiday' },
  { date: '2026-10-03', type: 'holiday' },
  { date: '2026-09-27', type: 'makeup' }
];

const PRIORITY_ROWS = [
  { order: 1, cond: '法定节假日', result: '不提醒', note: '最高优先级，一律静默' },
  { order: 2, cond: '自定义不提醒日期', result: '不提醒', note: '如考试周、请假' },
  { order: 3, cond: '落入免打扰时段', result: '不提醒', note: '如午休 12:00-14:00' },
  { order: 4, cond: '调休补课日', result: '正常提醒', note: '覆盖「周末不提醒」默认规则' },
  { order: 5, cond: '该课程已单独静音', result: '不提醒', note: '' },
  { order: 6, cond: '其他情况', result: '正常提醒', note: '' }
];

Page({
  data: {
    config: {
      globalMute: false,
      leadMinutes: 15,
      silentDates: [],
      silentRanges: [],
      silentCourses: []
    },
    leadOptions: [5, 10, 15, 30],
    leadIndex: 2,
    courses: [],
    priorityRows: PRIORITY_ROWS,
    newDate: '',
    newRangeFrom: '12:00',
    newRangeTo: '14:00',
    demoResult: '',
    timer: null
  },

  onLoad() {
    this.loadConfig();
    app.whenReady(() => this.loadCourses());
  },

  onUnload() {
    if (this.data.timer) clearInterval(this.data.timer);
  },

  loadConfig() {
    try {
      const saved = wx.getStorageSync(CONFIG_KEY);
      if (saved) {
        const leadIndex = this.data.leadOptions.indexOf(saved.leadMinutes);
        this.setData({
          config: { ...this.data.config, ...saved },
          leadIndex: leadIndex >= 0 ? leadIndex : 2
        });
      }
    } catch (e) {
      console.error('[reminder] 读取配置失败', e);
    }
  },

  saveConfig() {
    try {
      wx.setStorageSync(CONFIG_KEY, this.data.config);
    } catch (e) {
      console.error('[reminder] 保存配置失败', e);
    }
  },

  async loadCourses() {
    try {
      const courses = await listCourses();
      this.setData({ courses: courses || [] });
    } catch (e) {
      console.error('[reminder] 加载课程失败', e);
    }
  },

  onToggleMute(e) {
    this.setData({ 'config.globalMute': e.detail.value }, () => this.saveConfig());
  },

  onPickLead(e) {
    const idx = Number(e.detail.value);
    this.setData({
      leadIndex: idx,
      'config.leadMinutes': this.data.leadOptions[idx]
    }, () => this.saveConfig());
  },

  /* ---------- 不提醒日期 ---------- */
  onNewDateChange(e) {
    this.setData({ newDate: e.detail.value });
  },

  onAddSilentDate() {
    const d = this.data.newDate;
    if (!d) {
      wx.showToast({ title: '请选择日期', icon: 'none' });
      return;
    }
    const list = this.data.config.silentDates.slice();
    if (list.indexOf(d) !== -1) {
      wx.showToast({ title: '该日期已存在', icon: 'none' });
      return;
    }
    list.push(d);
    this.setData({ 'config.silentDates': list, newDate: '' }, () => this.saveConfig());
  },

  onRemoveSilentDate(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const list = this.data.config.silentDates.slice();
    list.splice(idx, 1);
    this.setData({ 'config.silentDates': list }, () => this.saveConfig());
  },

  /* ---------- 免打扰时段 ---------- */
  onFromChange(e) {
    this.setData({ newRangeFrom: e.detail.value });
  },

  onToChange(e) {
    this.setData({ newRangeTo: e.detail.value });
  },

  onAddSilentRange() {
    const from = this.data.newRangeFrom;
    const to = this.data.newRangeTo;
    if (from >= to) {
      wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' });
      return;
    }
    const list = this.data.config.silentRanges.slice();
    list.push({ from, to });
    this.setData({ 'config.silentRanges': list }, () => this.saveConfig());
  },

  onRemoveSilentRange(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const list = this.data.config.silentRanges.slice();
    list.splice(idx, 1);
    this.setData({ 'config.silentRanges': list }, () => this.saveConfig());
  },

  /* ---------- 单课程静默 ---------- */
  onToggleCourseMute(e) {
    const id = e.currentTarget.dataset.id;
    const list = this.data.config.silentCourses.slice();
    const i = list.indexOf(id);
    if (i === -1) list.push(id);
    else list.splice(i, 1);
    this.setData({ 'config.silentCourses': list }, () => this.saveConfig());
  },

  /* ---------- 判定演示（让「为什么没提醒」可见） ---------- */
  onDemo() {
    const calendar = buildCalendarIndex(DEMO_CALENDAR);
    const base = {
      date: '2026-10-01',
      timeStr: '09:45',
      userConfig: this.data.config,
      course: this.data.courses[0] || { id: 1 }
    };
    const r = shouldNotifyWithCalendar(base, calendar);
    this.setData({
      demoResult: `${base.date} 09:45 → ${r.notify ? '提醒' : '不提醒'}（${r.reason}）`
    });
  },

  onDemoMakeup() {
    const calendar = buildCalendarIndex(DEMO_CALENDAR);
    const base = {
      date: '2026-09-27',
      timeStr: '09:45',
      userConfig: this.data.config,
      course: this.data.courses[0] || { id: 1 }
    };
    const r = shouldNotifyWithCalendar(base, calendar);
    this.setData({
      demoResult: `${base.date} 09:45（调休补课日）→ ${r.notify ? '提醒' : '不提醒'}（${r.reason}）`
    });
  }
});
