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
const { eventKey, summarizeSyncResult } = calendarSync;
const timetableApi = require('../../api/timetable');
const { getRangeTime } = require('../../utils/schedule');

const app = getApp();
const CONFIG_KEY = 'reminder_config';
const SYNCED_KEY = 'calendar_synced_keys';   // 已写入系统日历的事件 key（微信删不掉，靠它避免重复堆）

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
    syncResult: '',      // 同步结果反馈（成功条数 / 失败原因）
    syncedCount: 0       // 本地记录的「已写入日历」事件数
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

  /**
   * 同步到手机系统日历
   *
   * ⚠️ 顺序是有讲究的：所有 await（授权 / 读库 / 弹窗确认）都必须排在**写入之前**，
   * 用户点「开始同步」之后一步 await 都不能有，直接进入 writeEvents 同步发起全部调用。
   *
   * 真机踩过的坑：日历写入 API 要求调用发生在用户点击手势的调用栈里。
   * 老写法是「await 写完一条再写下一条」，第一条能成功，后续全部脱离手势上下文，
   * 报 `can only be invoked by user TAP gesture` —— 表现就是「成功 1 条，失败 5 条」。
   */
  async onSyncCalendar() {
    if (this.data.syncing) return;

    // 1) 权限（放最前：首次授权会弹系统框，之后才算真正拿到手势）
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

    // 2) 算计划（读库，异步，必须在弹窗之前做完）
    const plan = await this.buildSyncPlan();

    // 3) 剔除本次已经写进去的（微信删不掉，重复写会堆成两份）
    const done = this.readSyncedKeys();
    const pending = plan.events.filter((ev) => done.indexOf(eventKey(ev)) === -1);
    const alreadySynced = plan.events.length - pending.length;

    if (!pending.length) {
      const why = plan.events.length
        ? '这些课已经同步过了。'
        : (plan.skipped.length ? `（${plan.skipped[0].reason}）` : '');
      wx.showModal({
        title: '没有需要同步的课',
        content: `${why}\n\n如果课表改过、想在日历里重写一遍，可以先清空同步记录。`,
        confirmText: '清空记录',
        cancelText: '知道了',
        success: (r) => { if (r.confirm) this.onClearSyncRecord(); }
      });
      return;
    }

    // 4) 确认 —— 微信没有删除日历事件的 API，这一步不可逆，必须讲清楚
    const skipLine = plan.skipped.length
      ? `\n跳过 ${plan.skipped.length} 门（${plan.skipped[0].reason}等）`
      : '';
    const alreadyLine = alreadySynced
      ? `\n已同步过的 ${alreadySynced} 条会跳过，不重复写入`
      : '';
    const truncLine = plan.truncated ? '\n⚠️ 事件过多已截断，剩余的下次再同步' : '';
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '同步到手机日历',
        content: `将写入 ${pending.length} 条日历事件，提前 ${this.data.config.leadMinutes} 分钟提醒。${skipLine}${alreadyLine}${truncLine}\n\n注意：微信不支持删除日历事件，改课后旧事件需要你在手机日历里手动删除。`,
        confirmText: '开始同步',
        cancelText: '再想想',
        success: (r) => resolve(r.confirm === true),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    // 5) 立刻写，不能再 await 任何东西
    this.writeEvents(pending);
  },

  /** 已写入日历的事件 key 列表（storage） */
  readSyncedKeys() {
    try {
      const v = wx.getStorageSync(SYNCED_KEY);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  },

  saveSyncedKeys(keys) {
    if (!keys.length) return;
    const list = this.readSyncedKeys();
    keys.forEach((k) => { if (list.indexOf(k) === -1) list.push(k); });
    try {
      wx.setStorageSync(SYNCED_KEY, list);
    } catch (e) {
      console.warn('[reminder] 记录已同步事件失败', e);
    }
  },

  /** 清空同步记录：课表改过、想在日历里重写一遍时用 */
  onClearSyncRecord() {
    try {
      wx.removeStorageSync(SYNCED_KEY);
    } catch (e) {
      console.warn('[reminder] 清空同步记录失败', e);
    }
    this.setData({ syncedCount: 0, syncResult: '' });
    wx.showToast({ title: '已清空，可重新同步', icon: 'none', duration: 2000 });
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

  /**
   * 写入全部事件 —— **必须同步发起，不能 await**
   *
   * 日历 API 要求调用处在用户点击手势的调用栈内。只要在这里 await 上一条的结果，
   * 后面每条都会脱离手势上下文，全部报 `can only be invoked by user TAP gesture`。
   * 所以这里用 forEach 一次性把所有 wx 调用发出去（调用是同步发起的，回调异步回来），
   * 靠计数器收尾。
   */
  writeEvents(events) {
    const total = events.length;
    this.setData({ syncing: true, syncResult: '' });
    wx.showLoading({ title: `同步中 0/${total}`, mask: true });

    let ok = 0;
    let done = 0;
    const fails = [];
    const written = [];

    const finish = () => {
      wx.hideLoading();
      this.saveSyncedKeys(written);
      const r = summarizeSyncResult(ok, fails);
      this.setData({
        syncing: false,
        syncResult: r.text,
        syncedCount: this.readSyncedKeys().length
      });
      wx.showToast({
        title: r.level === 'all' ? `已同步 ${ok} 条` : `成功 ${ok} 失败 ${fails.length}`,
        icon: r.level === 'all' ? 'success' : 'none',
        duration: 2500
      });
    };

    events.forEach((ev) => {
      this.fireOne(ev, (err) => {
        if (err) {
          fails.push({ title: ev.title, err: err });
          console.warn('[reminder] 写入日历失败', ev.title, err);
        } else {
          ok++;
          written.push(eventKey(ev));
        }
        done++;
        if (done === total) finish();
        else if (done % 5 === 0) wx.showLoading({ title: `同步中 ${done}/${total}`, mask: true });
      });
    });
  },

  /** 单条写入：按 kind 选 API，低版本没有重复事件 API 时降级为单条 */
  fireOne(ev, cb) {
    const payload = {
      title: ev.title,
      startTime: ev.startTime,
      endTime: ev.endTime,
      description: ev.description,
      location: ev.location,
      alarm: ev.alarm,
      alarmOffset: ev.alarmOffset,
      allDay: ev.allDay,
      success: () => cb(null),
      fail: (e) => cb((e && e.errMsg) || '写入失败')
    };
    if (ev.kind === 'repeat' && wx.addPhoneRepeatCalendar) {
      payload.repeatInterval = ev.repeatInterval;
      payload.repeatEndTime = ev.repeatEndTime;
      wx.addPhoneRepeatCalendar(payload);
      return;
    }
    // 降级：重复事件 API 不可用时，把重复段的第一条写成普通事件
    wx.addPhoneCalendar(payload);
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
