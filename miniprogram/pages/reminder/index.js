/**
 * pages/reminder/index.js —— 提醒设置
 *
 * 核心：把「不提醒」做成可解释的功能。
 * 用户不仅知道「今天没提醒」，还能知道「为什么」。
 */
const store = require('../../api/store');
const { shouldNotifyWithCalendar, buildCalendarIndex } = require('../../logic/dnd-rule');
const { listCourses } = require('../../api/course');
const { withMuted, toggleMute } = require('../../logic/reminder-mute');
const calendarSync = require('../../logic/calendar-sync');
const timetableApi = require('../../api/timetable');
const { getRangeTime } = require('../../utils/schedule');

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
  { order: 1, cond: '已全局关闭提醒', result: '不提醒', note: '总开关，最高优先级' },
  { order: 2, cond: '法定节假日', result: '不提醒', note: '一律静默' },
  { order: 3, cond: '自定义不提醒日期', result: '不提醒', note: '如考试周、请假' },
  { order: 4, cond: '落入免打扰时段', result: '不提醒', note: '如午休 12:00-14:00' },
  { order: 5, cond: '该课程已单独静音', result: '不提醒', note: '优先于调休补课日：你自己关的课，补课时也不响' },
  { order: 6, cond: '调休补课日', result: '正常提醒', note: '覆盖「周末不提醒」默认规则' },
  { order: 7, cond: '其他情况', result: '正常提醒', note: '' }
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
    timer: null,
    syncing: false,      // 正在写入系统日历
    syncResult: ''       // 同步结果反馈（成功条数 / 失败原因）
  },

  onLoad() {
    this.loadConfig();
    app.whenReady(() => this.loadCourses());
  },

  onShow() {
    // 从建表/课表页返回时课程可能已变动（改名、删课），重新拉一次并重算静音态。
    // 只在脏时重读，避免每次返回都白读一次库。
    const g = (app && app.globalData) || {};
    if (g.coursesDirty) {
      g.coursesDirty = false;
      this.loadCourses();
    }
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
      // 静音状态必须在 JS 里算好：WXML 不支持 indexOf 之类的方法调用，
      // 把判断写在模板里会导致开关的选中态永远不变（点了像没反应）。
      this.setData({ courses: withMuted(courses || [], this.data.config.silentCourses) });
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
    const { list, muted } = toggleMute(this.data.config.silentCourses, id);
    // 连同每门课的 muted 字段一起刷新，否则开关只有数据变了、界面不动
    const courses = withMuted(this.data.courses, list);
    this.setData({ 'config.silentCourses': list, courses }, () => this.saveConfig());
    // 顺带给个反馈：静音是「看不见」的操作，不给提示用户不知道生效没有
    const hit = courses.find((c) => String(c.id) === String(id));
    wx.showToast({
      title: `${hit ? hit.name : '该课程'}${muted ? '已静音' : '恢复提醒'}`,
      icon: 'none',
      duration: 1200
    });
  },

  /* ---------- 同步到手机系统日历 ----------
   * 小程序没有本地通知能力，退后台后 JS 定时器就失效了。要让「课前提醒」
   * 真的响起来，只能把课写进用户手机的系统日历，让日历 App 到点弹通知。
   */

  /** 按当前课表生成同步计划（学期起始周以课表配置为准） */
  async buildSyncPlan() {
    const config = require('../../config');
    let t = null;
    try {
      t = await timetableApi.getCurrentTimetable();
    } catch (e) {
      console.warn('[reminder] 获取当前课表失败，回退全局学期配置', e);
    }
    return calendarSync.buildCalendarPlan(this.data.courses, {
      termStartMonday: (t && t.term_start_monday) || config.TERM_START_MONDAY,
      leadMinutes: this.data.config.leadMinutes,
      // 静音的课不该写进日历：用户明确关掉的课，换个通道又响回来就自相矛盾了
      silentCourses: this.data.config.silentCourses,
      rangeTime: (slot, count) => getRangeTime(slot, count),
      now: new Date()
    });
  },

  async onSyncCalendar() {
    if (this.data.syncing) return;
    const plan = await this.buildSyncPlan();

    if (!plan.events.length) {
      const why = plan.skipped.length
        ? `（${plan.skipped[0].reason}）`
        : '';
      wx.showToast({ title: `没有可同步的课${why}`, icon: 'none', duration: 2000 });
      return;
    }

    // 写入前必须确认：微信没有删除日历事件的 API，这部分是不可逆的
    const skipLine = plan.skipped.length
      ? `\n跳过 ${plan.skipped.length} 门（${plan.skipped[0].reason}等）`
      : '';
    const truncLine = plan.truncated ? '\n⚠️ 事件过多已截断，建议分批同步' : '';
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '同步到手机日历',
        content: `将写入 ${plan.events.length} 条日历事件，提前 ${this.data.config.leadMinutes} 分钟提醒。${skipLine}${truncLine}\n\n注意：微信不支持删除日历事件，改课后旧事件需要你在手机日历里手动删除。`,
        confirmText: '开始同步',
        cancelText: '再想想',
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    const granted = await this.ensureCalendarScope();
    if (!granted) {
      wx.showModal({
        title: '需要日历权限',
        content: '课前提醒需要写入手机日历才能到点响铃。请点「去开启」允许日历权限。',
        confirmText: '去开启',
        success: (r) => { if (r.confirm) wx.openSetting({}); }
      });
      return;
    }

    await this.writeEvents(plan.events);
  },

  /** 检查/申请日历写入权限 */
  ensureCalendarScope() {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => {
          const has = res.authSetting && res.authSetting['scope.addPhoneCalendar'];
          if (has) return resolve(true);
          wx.authorize({
            scope: 'scope.addPhoneCalendar',
            success: () => resolve(true),
            fail: () => resolve(false)
          });
        },
        fail: () => resolve(false)
      });
    });
  },

  /** 逐条写入：日历 API 一次只能加一条，串行写最稳，失败不中断 */
  async writeEvents(events) {
    const total = events.length;
    this.setData({ syncing: true, syncResult: '' });
    wx.showLoading({ title: `同步中 0/${total}`, mask: true });

    let ok = 0;
    let failed = 0;
    let lastErr = '';

    for (let i = 0; i < total; i++) {
      try {
        await this.writeOne(events[i]);
        ok++;
      } catch (e) {
        failed++;
        lastErr = (e && e.errMsg) || String(e);
        console.warn('[reminder] 写入日历失败', events[i].title, e);
      }
      wx.showLoading({ title: `同步中 ${ok + failed}/${total}`, mask: true });
    }

    wx.hideLoading();
    this.setData({ syncing: false });

    if (failed === 0) {
      this.setData({
        syncResult: `已写入 ${ok} 条日历事件，课前会由手机日历提醒。\n如需修改，请在手机日历里删除旧事件后重新同步（微信不支持删除日历）。`
      });
      wx.showToast({ title: `已同步 ${ok} 条`, icon: 'success' });
    } else {
      this.setData({
        syncResult: `成功 ${ok} 条，失败 ${failed} 条。${lastErr ? '最后失败原因：' + lastErr : ''}`
      });
      wx.showToast({ title: `成功 ${ok} 失败 ${failed}`, icon: 'none', duration: 2500 });
    }
  },

  /** 单条写入：按 kind 选 API，低版本没有重复事件 API 时降级为单条 */
  writeOne(ev) {
    return new Promise((resolve, reject) => {
      const payload = {
        title: ev.title,
        startTime: ev.startTime,
        endTime: ev.endTime,
        description: ev.description,
        location: ev.location,
        alarm: ev.alarm,
        alarmOffset: ev.alarmOffset,
        allDay: ev.allDay
      };
      const cb = {
        success: resolve,
        fail: (e) => reject(e || new Error('写入失败'))
      };
      if (ev.kind === 'repeat' && wx.addPhoneRepeatCalendar) {
        payload.repeatInterval = ev.repeatInterval;
        payload.repeatEndTime = ev.repeatEndTime;
        wx.addPhoneRepeatCalendar(Object.assign(payload, cb));
        return;
      }
      // 降级：重复事件 API 不可用时，把重复段的第一条写成普通事件
      wx.addPhoneCalendar(Object.assign(payload, cb));
    });
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
