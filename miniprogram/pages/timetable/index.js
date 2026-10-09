/**
 * pages/timetable/index.js —— 课表周视图（首页）
 *
 * 布局：横轴周一至周日，纵轴节次（可自定义，含午休/晚休分隔行）。
 *
 * 交互设计：
 *   - 左上角角格显示「第X周 · 单/双」，点击弹出周次选择面板，当前周高亮
 *   - 节次列显示每节课的完整时间区间（如 08:00-08:45）
 *   - 网格左右滑动切换周次：跟手位移 + 松手回弹/切页动画
 *   - 点击课程块弹出详情卡片
 *
 * 滑动实现（关键）：网格渲染为一个「上一周 / 本周 / 下一周」的三面板轨道，
 * 而不是只渲染当前一周。这样在拖动过程中相邻周的内容是**真实可见**的，
 * 不会出现「滑出去一半、后面却是空白」的问题。
 * 位移用轨道自身宽度的百分比表示（一个面板 = 100%），与视口像素宽度无关，
 * 因此无需等待测量即可精确对齐。
 */
const { expandAll, findCourseAt } = require('../../logic/course-expand');
const {
  weekToDate,
  formatDate,
  currentWeekOf,
  todayPosition,
  currentTimeStr
} = require('../../utils/week');
const { colorOf, softOf } = require('../../utils/color');
const { buildSlotAxis, formatSlotTime, getTotalSlots, toMinutes } = require('../../utils/schedule');
const { listCourses, removeCourse } = require('../../api/course');
const timetableApi = require('../../api/timetable');
const config = require('../../config');

const app = getApp();

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 松手后判定翻页的位移阈值（px），调低让切换更易触发
const SWIPE_THRESHOLD = 40;
// 最大跟手位移（px），超出后阻尼衰减
const MAX_DRAG = 120;
// 快速滑动（fling）的速度阈值（px/ms），超过则即使位移不足也翻页
const FLING_VELOCITY = 0.5;
// 当前时间指示线刷新间隔（毫秒）：1 分钟
const NOW_TICK_INTERVAL = 60 * 1000;
// 切页动画时长（毫秒），必须与 WXSS 中 .track-animate 的 transition 保持一致，
// 否则「滑出 → 重定基准」的时机对不上，会出现跳动
const TRANSITION_MS = 240;
// 一个面板占轨道自身宽度的百分比
const PANEL_PCT = 100;

Page({
  data: {
    currentWeek: 1,
    totalWeeks: config.DEFAULT_TOTAL_WEEKS || 20,
    weeks: [],

    // 当前课表（多课表支持）：开课日期、总周次都来自这张课表自身
    // timetableName 仍保留：用于「课表被改名」时的变化检测（页面上不再展示课表名）
    timetableId: null,
    timetableName: '',
    termStartMonday: config.TERM_START_MONDAY,
    noTimetable: false,  // 一张课表都没有时的空态（正常情况下 ensureDefaultTimetable 会兜底）

    // 当前周描述
    weekBadge: { week: 1, parity: '单', label: '第1周 · 单' },

    dayLabels: DAY_LABELS,
    slotAxis: [],
    totalSlots: 6,

    /**
     * 滑动轨道：并排的「上一周 / 本周 / 下一周」面板。
     *   panels     每个面板含 { week, parity, dayDates, dayIsToday, isTodayWeek, grid }
     *   trackIndex 当前周在 panels 中的下标
     *   trackPct   轨道横向位移（百分比，100% = 一个面板宽度）
     *   animate    是否启用过渡动画（拖动中关闭，松手后开启）
     */
    panels: [],
    trackIndex: 1,
    trackPct: -PANEL_PCT,
    animate: true,

    // 「今天」定位信息
    todayWeek: 1,       // 今天所在的周次
    todayDow: 1,        // 今天是一周中的第几天（1=周一）
    inTerm: true,       // 今天是否落在学期范围内
    isViewingToday: true, // 当前是否正看着本周

    // 当前时间指示线（只在查看本周时显示）
    nowLabel: '',       // 如 "14:32"
    nowTop: -999,       // 指示线距网格顶部像素（-999 表示不显示）
    nowLeft: '0%',      // 指示线所在列（今天所在列的左偏移百分比）
    showNowLine: false,

    // 动态行高（px）：onReady 后按屏幕自适应，使课表铺满屏幕
    slotH: 52,          // 节次行高，初始 ≈ 104rpx
    breakH: 24,         // 休息行高，初始 ≈ 48rpx
    courseCount: 0,
    loading: true,
    error: '',
    detail: null,
    hasAnyCourse: false,

    showWeekPicker: false,

    // 触摸跟踪（不放 data，避免频繁 setData）
    swiping: false
  },

  onLoad() {
    // 先把滑动视口宽度的兜底值算出来 —— 拖动时要把像素换算成面板比例
    this.initPageWidth();
    this.buildWeekList();
    this.refreshSchedule();

    app.whenReady(async () => {
      await this.loadCurrentTimetable();
      const pos = this.todayPos();
      this.setData({
        currentWeek: pos.week,
        todayWeek: pos.week,
        todayDow: pos.dayOfWeek,
        inTerm: pos.inTerm
      }, () => {
        this.buildWeekList();
        this.syncWeekBadge(this.data.currentWeek);
        this.renderTrack();
        this.loadCourses();
      });
    });
  },

  /**
   * 兜底估算滑动视口宽度（px）。
   *
   * 拖动位移需要把手指移动的像素换算成「面板比例」，因此必须知道视口宽度。
   * onReady 前的首次渲染先用估算值，onReady 后会被真实的测量值覆盖。
   */
  initPageWidth() {
    try {
      const info = typeof wx.getWindowInfo === 'function'
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync();
      const winW = info.windowWidth || 375;
      const slotColW = (108 / 750) * winW;   // .slot-col 宽度 108rpx
      const wrapPad = (24 / 750) * winW;     // .grid-wrap 左右各 12rpx
      this._pageWidth = Math.max(1, winW - slotColW - wrapPad);
    } catch (e) {
      this._pageWidth = 375;
    }
  },

  /**
   * 读取当前课表，把它的开课日期 / 总周次写进 data。
   *
   * 没有任何课表时会自动创建一张「我的课表」（ensureDefaultTimetable 幂等），
   * 同时把历史遗留的、没有 timetable_id 的课程迁移进来，避免升级后课表看起来空掉。
   */
  async loadCurrentTimetable() {
    try {
      const tt = await timetableApi.ensureDefaultTimetable();
      if (!tt) {
        this.setData({ noTimetable: true });
        return null;
      }
      const totalWeeks = timetableApi.clampTotalWeeks(tt.total_weeks);
      this.setData({
        timetableId: tt.id,
        timetableName: tt.name,
        termStartMonday: tt.term_start_monday,
        totalWeeks
      });
      return tt;
    } catch (err) {
      console.error('[timetable] 读取当前课表失败', err);
      this.setData({ noTimetable: true });
      return null;
    }
  },

  /**
   * 用「当前课表」的配置计算今天的位置。
   * 所有需要定位的地方统一走这里，避免各处重复传参。
   */
  todayPos() {
    return todayPosition(this.data.termStartMonday, null, this.data.totalWeeks);
  },

  onReady() {
    this._ready = true;
    // 等首帧布局稳定后测量网格高度，计算自适应行高
    setTimeout(() => {
      this.computeLayout();
      this.updateNowLine();
    }, 50);
    this.startNowTicker();
  },

  onShow() {
    // 从设置页返回时，节次可能已改变，需要重算时间轴
    this.refreshSchedule();
    if (!this.data.loading && app.globalData.ready) {
      // 可能刚在「课表管理」里切换了当前课表：先比对 id，变了就整页重载
      this.syncTimetableIfChanged();
    }
    // 跨天 / 跨周：只刷新定位信息，不改变用户当前浏览的周次
    this.locateToday();
    this.startNowTicker();
  },

  /**
   * 检测「当前课表」是否被换过（用户在课表管理页切换 / 改名 / 改了开课时间或周次）。
   * 变了就重载课表配置，并把视图拉回今天所在周 —— 换了一张课表后，
   * 旧的周次数字对新课表没有意义。
   */
  async syncTimetableIfChanged() {
    try {
      const tt = await timetableApi.getCurrentTimetable();
      if (!tt) {
        this.setData({ noTimetable: true });
        return;
      }
      const idChanged = String(tt.id) !== String(this.data.timetableId);
      const cfgChanged =
        tt.term_start_monday !== this.data.termStartMonday ||
        timetableApi.clampTotalWeeks(tt.total_weeks) !== this.data.totalWeeks ||
        tt.name !== this.data.timetableName;

      if (!idChanged && !cfgChanged) return;

      const totalWeeks = timetableApi.clampTotalWeeks(tt.total_weeks);
      const pos = todayPosition(tt.term_start_monday, null, totalWeeks);

      this.setData({
        timetableId: tt.id,
        timetableName: tt.name,
        termStartMonday: tt.term_start_monday,
        totalWeeks,
        noTimetable: false,
        todayWeek: pos.week,
        todayDow: pos.dayOfWeek,
        inTerm: pos.inTerm,
        // 换了课表 → 回到本周；只改配置 → 周次越界时收敛到最后一周年
        currentWeek: idChanged
          ? pos.week
          : Math.min(this.data.currentWeek, totalWeeks)
      }, () => {
        this.buildWeekList();
        this.syncWeekBadge(this.data.currentWeek);
        this.renderTrack();
        this.updateNowLine();
      });
    } catch (err) {
      console.error('[timetable] 同步课表配置失败', err);
    }
  },

  onHide() {
    this.stopNowTicker();
  },

  onUnload() {
    this.stopNowTicker();
  },

  onPullDownRefresh() {
    // 下拉只做数据刷新，不改变当前浏览的周次（回到今天请用底部按钮）
    this.loadCourses().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 刷新「今天」的定位信息（第几周、星期几、是否在学期内）
   *
   * 注意：这个方法**不改变用户当前浏览的周次**。跳回本周由底部「回到今天」按钮
   * 的 onBackToToday() 负责（那里带翻页动画）。这里只负责把 todayWeek /
   * todayDow / inTerm 更新到最新，用于表头高亮、今天列底色与指示线判定。
   *
   * @returns {boolean} 定位信息是否发生了变化（用于决定是否需要重绘）
   */
  locateToday() {
    const pos = this.todayPos();
    const changed = pos.week !== this.data.todayWeek ||
      pos.dayOfWeek !== this.data.todayDow ||
      pos.inTerm !== this.data.inTerm;

    if (changed) {
      this.setData({
        todayWeek: pos.week,
        todayDow: pos.dayOfWeek,
        inTerm: pos.inTerm
      });
      this.syncWeekBadge(this.data.currentWeek);
      // 今天可能从「相邻面板」变成「当前面板」（或反之），需重建轨道刷新高亮
      this.renderTrack();
      this.updateNowLine();
    }
    return changed;
  },

  /* ================= 当前时间指示线 ================= */

  /**
   * 计算「现在」在网格中的纵向位置，用于绘制当前时间指示线。
   *
   * 做法：把当前时刻与每一节的起止时间比对，换算成像素偏移：
   *   - 落在某节课内 → 按课时进度线性插值
   *   - 落在休息时段内 → 落在对应的休息行
   *   - 在当天第一节课前 / 最后一节课后 → 显示在最顶部 / 最底部
   *
   * 指示线渲染在每个「今天所在周」面板内部，因此翻页时它会随该面板一起滑动。
   */
  updateNowLine() {
    const axis = this.data.slotAxis || [];
    const slotH = this.data.slotH;
    const breakH = this.data.breakH;
    const isViewingToday = this.data.inTerm && this.data.currentWeek === this.data.todayWeek;

    if (!axis.length || !isViewingToday || !this._gridBodyH) {
      if (this.data.showNowLine) this.setData({ showNowLine: false });
      return;
    }

    const nowMin = toMinutes(currentTimeStr());
    const nowLabel = currentTimeStr();

    let top = 0;
    let placed = false;

    for (let i = 0; i < axis.length; i++) {
      const row = axis[i];

      if (row.type === 'slot') {
        const startMin = toMinutes(row.start);
        const endMin = toMinutes(row.end);

        if (nowMin < startMin) {
          // 还没到这一节 —— 停在当前累计位置（相当于课间上沿）
          placed = true;
          break;
        }
        if (nowMin >= startMin && nowMin <= endMin) {
          // 正在这一节内：按进度插值
          const ratio = (nowMin - startMin) / Math.max(1, endMin - startMin);
          top += ratio * slotH;
          placed = true;
          break;
        }
        top += slotH;
      } else {
        const startMin = toMinutes(row.start);
        const endMin = row.end ? toMinutes(row.end) : startMin;
        if (nowMin >= startMin && nowMin <= endMin) {
          // 处于休息时间段
          const ratio = endMin > startMin ? (nowMin - startMin) / (endMin - startMin) : 0;
          top += ratio * breakH;
          placed = true;
          break;
        }
        top += breakH;
      }
    }

    // 晚于最后一节：停在最底部
    if (!placed) top = this._gridBodyH;

    // 今天所在列的左偏移百分比（7 等分，列宽 = 100/7 %）
    const leftPct = ((this.data.todayDow - 1) * 100) / 7;

    this.setData({
      showNowLine: true,
      nowTop: Math.max(0, Math.min(top, this._gridBodyH)),
      nowLabel,
      nowLeft: `${leftPct}%`
    });
  },

  startNowTicker() {
    this.stopNowTicker();
    this._nowTimer = setInterval(() => {
      // 跨天检测：日期变了要刷新定位信息（是否跳周由用户决定）
      const today = formatDate(new Date());
      if (this._lastTodayDate && this._lastTodayDate !== today) {
        this.locateToday();
      }
      this._lastTodayDate = today;
      this.updateNowLine();
    }, NOW_TICK_INTERVAL);
    this._lastTodayDate = formatDate(new Date());
  },

  stopNowTicker() {
    if (this._nowTimer) {
      clearInterval(this._nowTimer);
      this._nowTimer = null;
    }
  },

  /**
   * 「回到今天」：带动画地跳回本周
   *
   * 目标在当前位置右侧（周次更大）→ 内容向左滑出、目标从右侧滑入，反之亦然。
   * 只在目标与当前**相邻**时走「滑一格」；跨多周时直接换到目标周的轨道、
   * 再从行进方向的一侧一次性滑入（单段滑动，中间不停顿）。
   */
  onBackToToday() {
    const pos = this.todayPos();
    const target = pos.week;
    const current = this.data.currentWeek;

    // 从周次面板点进来时，先收起面板，让动画在干净的界面上播放
    if (this.data.showWeekPicker) {
      this.setData({ showWeekPicker: false });
    }

    // 先把定位信息刷新到最新（可能在后台待了很久）
    this.setData({
      todayWeek: pos.week,
      todayDow: pos.dayOfWeek,
      inTerm: pos.inTerm
    });

    // 周次已经正确：只播放一次强调动画，不改数据
    if (target === current) {
      this.playEmphasis();
      this.syncWeekBadge(current);
      this.renderTrack();
      this.updateNowLine();
      this._toastBackToToday(pos);
      return;
    }

    // 目标在右侧（周次更大）→ 面板下标增大，内容向左滑
    const s = target > current ? 1 : -1;

    if (Math.abs(target - current) === 1) {
      this.slideToAdjacent(s);
      this._toastBackToToday(pos);
      return;
    }

    // 跨多周：直接换到目标周的轨道，再从行进方向的一侧一次性滑入。
    //
    // 这里刻意**不做**「先滑到相邻周、再换轨滑入」的两段滑动 —— 两段各自都会
    // 减速到静止，中间那次「停住再起步」看上去就是「在相邻周卡一下」。
    // 方向感改由「滑入方向」给出：从目标的前一站滑进来，用户自然明白往哪边走。
    const next = this.buildPanels(target);
    this.setData({
      currentWeek: target,
      panels: next.panels,
      trackIndex: next.trackIndex,
      animate: false,
      trackPct: -PANEL_PCT * next.trackIndex + PANEL_PCT * s
    });
    this.syncWeekBadge(target);
    this.updateNowLine();

    // 下一帧滑入居中
    this._scheduleAnim(20, () => {
      this.setData({ animate: true, trackPct: -PANEL_PCT * next.trackIndex });
      this._toastBackToToday(pos);
    });
  },

  /**
   * 「已在今天」时的强调动画：轻微右推再回弹，给用户「已经是这一周了」的反馈
   */
  playEmphasis() {
    const base = -PANEL_PCT * this.data.trackIndex;
    this.setData({ animate: true, trackPct: base + 8 });
    this._scheduleAnim(140, () => {
      this.setData({ trackPct: base });
    });
  },

  _toastBackToToday(pos) {
    if (pos.inTerm) {
      wx.showToast({ title: `已回到第${pos.week}周`, icon: 'none' });
    } else {
      wx.showToast({ title: '今天不在学期内', icon: 'none' });
    }
  },

  /* ================= 切页动画的收尾调度 ================= */

  /**
   * 登记一次「过渡播完后要做的事」。
   *
   * 背景：切页是两段式 —— 先让 CSS 过渡把画面滑到位，过渡结束后再重定基准
   * （rebase：换当前周、重建面板、位移归位）。第二段得等过渡结束，所以用定时器。
   *
   * 问题：用户**快速连续滑动**时，上一次的收尾还没执行，新手势就开始了。
   * 若放任那个定时器在本次拖动中途触发，它会用旧的面板与位移覆盖当前状态，
   * 画面被猛地拽回 —— 表现就是「一抽一抽」。所以收尾动作统一在这里登记，
   * 并在新手势开始时结算掉（见 _flushAnim）。
   */
  _scheduleAnim(delay, finalize) {
    this._cancelAnim();
    const timerId = setTimeout(() => {
      this._pendingAnim = null;
      finalize();
    }, delay);
    this._pendingAnim = { timerId, finalize };
  },

  _cancelAnim() {
    if (this._pendingAnim) {
      clearTimeout(this._pendingAnim.timerId);
      this._pendingAnim = null;
    }
  },

  /**
   * 立即结算未完成的收尾动作（不等过渡播完）。
   *
   * 结算一段后有可能又登记了下一段（收尾里再排收尾），所以循环到没有待办为止，
   * 否则残余的那段仍会在拖动过程中触发。
   *
   * 取舍：宁可让画面「一步到位」落到已确定的目标位（一次性），
   * 也不能让旧定时器在拖动中改写位移（持续抽动）。
   */
  _flushAnim() {
    let guard = 0;
    while (this._pendingAnim && guard < 10) {
      const pending = this._pendingAnim;
      clearTimeout(pending.timerId);
      this._pendingAnim = null;
      pending.finalize();
      guard += 1;
    }
  },

  /**
   * 重算节次轴（用户可能修改了作息配置）
   */
  refreshSchedule() {
    const axis = buildSlotAxis();
    this.setData({
      slotAxis: axis,
      totalSlots: getTotalSlots()
    }, () => {
      // 行数 / 行结构变了，重建轨道；行高变化由 computeLayout 处理
      if (this.data.panels && this.data.panels.length) this.renderTrack();
      if (this._ready) setTimeout(() => this.computeLayout(), 0);
    });
  },

  buildWeekList() {
    const weeks = [];
    for (let i = 1; i <= this.data.totalWeeks; i++) {
      weeks.push({ week: i, parity: i % 2 === 1 ? '单' : '双' });
    }
    this.setData({ weeks });
  },

  syncWeekBadge(week) {
    const isViewingToday = this.data.inTerm && week === this.data.todayWeek;
    const parity = week % 2 === 1 ? '单' : '双';
    this.setData({
      weekBadge: { week, parity, label: `第${week}周 · ${parity}` },
      isViewingToday
    });
  },

  /**
   * 计算某周每天对应的日期文本（如 9月7日）
   */
  computeDayDates(week) {
    const list = [];
    for (let d = 1; d <= 7; d++) {
      const date = weekToDate(this.data.termStartMonday, week, d);
      list.push(`${date.getMonth() + 1}月${date.getDate()}日`);
    }
    return list;
  },

  /**
   * 标记某周里哪一列是「今天」，用于表头与列高亮
   */
  computeDayIsToday(week) {
    const list = [];
    const isThisWeek = this.data.inTerm && Number(week) === this.data.todayWeek;
    for (let d = 1; d <= 7; d++) {
      list.push(isThisWeek && d === this.data.todayDow);
    }
    return list;
  },

  /* ================= 周次轨道（上一周 / 本周 / 下一周） ================= */

  /**
   * 构建某一周的 7 列网格（列内按节次轴逐行放置课程 / 休息 / 空）。
   *
   * 与原先的 renderGrid 逻辑等价，只是把「周次」提为参数 ——
   * 这样上一周 / 本周 / 下一周可以各生成一份，并排放进滑动轨道。
   */
  buildGridForWeek(week) {
    const occupied = expandAll(this.courses);
    const axis = this.data.slotAxis || [];
    const grid = [];

    for (let d = 1; d <= 7; d++) {
      const col = [];
      for (const row of axis) {
        if (row.type === 'break') {
          col.push({ isBreak: true, label: row.label });
          continue;
        }

        const s = row.slot;
        const key = `${week}-${d}-${s}`;

        if (occupied.has(key)) {
          const course = findCourseAt(this.courses, week, d, s);
          if (course) {
            const isStart = Number(course.start_slot) === s;
            col.push(
              isStart
                ? {
                    id: course.id,
                    name: course.name,
                    teacher: course.teacher,
                    location: course.location,
                    color: colorOf(course.name),
                    bg: softOf(colorOf(course.name)),
                    span: Number(course.slot_count) || 1,
                    startSlot: Number(course.start_slot),
                    slotCount: Number(course.slot_count) || 1,
                    timeText: formatSlotTime(course.start_slot, course.slot_count),
                    weeks: course.weeks,
                    source_type: course.source_type
                  }
                : { placeholder: true }
            );
            continue;
          }
        }
        col.push(null);
      }
      grid.push(col);
    }

    return grid;
  },

  /**
   * 组装一个周面板（网格 + 日期表头 + 今天标记）
   */
  buildPanel(week) {
    return {
      week,
      parity: week % 2 === 1 ? '单' : '双',
      dayDates: this.computeDayDates(week),
      dayIsToday: this.computeDayIsToday(week),
      isTodayWeek: this.data.inTerm && week === this.data.todayWeek,
      grid: this.buildGridForWeek(week)
    };
  },

  /**
   * 依据当前周次生成轨道面板数组，并给出当前周在其中的下标。
   *
   * 只包含真实存在的周次：第 1 周没有上一周、最后一周没有下一周。
   * 边界处的「到头了」手感由拖动阻尼提供，而不是渲染一张不存在的空白周。
   *
   * @returns {{panels: object[], trackIndex: number}}
   */
  buildPanels(week) {
    const totalWeeks = this.data.totalWeeks;
    const panels = [];
    let trackIndex = 0;

    [week - 1, week, week + 1].forEach((w) => {
      if (w < 1 || w > totalWeeks) return;
      if (w === week) trackIndex = panels.length;
      panels.push(this.buildPanel(w));
    });

    return { panels, trackIndex };
  },

  /**
   * 重建轨道并立即归位（无动画）。
   * 用于数据刷新、配置变更、定位更新等「不需要过渡」的场景。
   */
  renderTrack() {
    const { panels, trackIndex } = this.buildPanels(this.data.currentWeek);
    this.setData({
      panels,
      trackIndex,
      trackPct: -PANEL_PCT * trackIndex,
      animate: false
    });
  },

  /**
   * 把轨道滑到相邻一格，动画结束后重定基准（rebase）。
   *
   * 为什么需要 rebase：轨道只有三格，滑到下一格后当前周其实在轨道中间，
   * 需要重建一份以新当前周为中心的轨道，并把位移瞬间归位。
   * 因为归位前后「屏幕上的画面完全一致」，所以不会有跳动。
   *
   * @param {number} delta +1 = 下一周 / -1 = 上一周
   */
  slideToAdjacent(delta) {
    const target = this.data.currentWeek + delta;
    if (target < 1 || target > this.data.totalWeeks) {
      this.snapBack();
      return;
    }

    // 第 1 步：滑到目标面板
    this.setData({
      animate: true,
      trackPct: -PANEL_PCT * (this.data.trackIndex + delta)
    });

    // 第 2 步：过渡结束后换当前周并重定基准
    this._scheduleAnim(TRANSITION_MS, () => {
      const { panels, trackIndex } = this.buildPanels(target);
      this.setData({
        currentWeek: target,
        panels,
        trackIndex,
        trackPct: -PANEL_PCT * trackIndex,
        animate: false
      });
      this.syncWeekBadge(target);
      this.updateNowLine();
    });
  },

  /**
   * 跳到指定周次（周次面板选择 / 上一周 / 下一周按钮共用）。
   *   - 相邻一周 → 直接滑一格
   *   - 相距多周 → 直接换到目标周的轨道，再从行进方向一侧一次性滑入（单段滑动）
   */
  goToWeek(target) {
    const current = this.data.currentWeek;
    if (target < 1 || target > this.data.totalWeeks || target === current) return;

    const s = target > current ? 1 : -1;
    if (Math.abs(target - current) === 1) {
      this.slideToAdjacent(s);
      return;
    }

    // 跨多周：直接换到目标周的轨道，再从行进方向的一侧一次性滑入
    // （理由同 onBackToToday：两段滑动中间会各停一次，看起来像「卡一下」）
    const next = this.buildPanels(target);
    this.setData({
      currentWeek: target,
      panels: next.panels,
      trackIndex: next.trackIndex,
      animate: false,
      trackPct: -PANEL_PCT * next.trackIndex + PANEL_PCT * s
    });
    this.syncWeekBadge(target);
    this.updateNowLine();

    // 下一帧滑入居中
    this._scheduleAnim(20, () => {
      this.setData({ animate: true, trackPct: -PANEL_PCT * next.trackIndex });
    });
  },

  /**
   * 未达翻页阈值时回弹归位。
   * 已经在基准位时直接返回 —— 避免每一次轻点都产生一次无谓的跨线程通信。
   */
  snapBack() {
    const base = -PANEL_PCT * this.data.trackIndex;
    if (Math.abs(this.data.trackPct - base) < 0.01) return;
    this.setData({ animate: true, trackPct: base });
  },

  /**
   * 计算自适应行高：测量网格主体可用高度，按「节次行 + 休息行(40%)」分配，
   * 使课表铺满屏幕，而不是固定 104rpx 行高留大片空白。
   * 同时测量滑动视口宽度（拖动位移换算要用）。
   */
  computeLayout() {
    const axis = this.data.slotAxis || [];
    const slotCount = axis.filter((r) => r.type === 'slot').length;
    const breakCount = axis.filter((r) => r.type === 'break').length;
    if (slotCount <= 0) return;

    const apply = (gridBodyH) => {
      const breakRatio = 0.4; // 休息行高度 = 节次行的 40%
      const slotH = gridBodyH / (slotCount + breakCount * breakRatio);
      this.setData({
        slotH: Math.max(30, slotH),
        breakH: Math.max(16, slotH * breakRatio)
      });
      // 行高变化会改变当前时间指示线的位置，需要同步重算
      this.updateNowLine();
    };

    if (this._gridBodyH) {
      apply(this._gridBodyH);
      return;
    }

    const query = wx.createSelectorQuery().in(this);
    query.select('.grid-body').boundingClientRect();
    query.select('.swipe-viewport').boundingClientRect();
    query.exec((res) => {
      const bodyRect = res && res[0];
      const viewportRect = res && res[1];

      // 视口宽度 = 一个面板的宽度，拖动位移由它换算
      if (viewportRect && viewportRect.width) this._pageWidth = viewportRect.width;

      if (bodyRect && bodyRect.height) {
        this._gridBodyH = bodyRect.height;
        apply(bodyRect.height);
      }
    });
  },

  async loadCourses() {
    this.setData({ loading: true, error: '' });
    try {
      const courses = await listCourses();
      this.courses = courses || [];
      this.setData({ courseCount: this.courses.length, hasAnyCourse: this.courses.length > 0 });
      this.renderTrack();
    } catch (err) {
      console.error('[timetable] 加载课程失败', err);
      this.setData({ error: '课表加载失败，请检查网络后重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ================= 周次切换 ================= */

  onSwitchWeek(e) {
    const week = Number(e.currentTarget.dataset.week);
    if (!week) {
      this.setData({ showWeekPicker: false });
      return;
    }
    this.setData({ showWeekPicker: false });
    this.goToWeek(week);
  },

  onPrevWeek() {
    this.goToWeek(this.data.currentWeek - 1);
  },

  onNextWeek() {
    this.goToWeek(this.data.currentWeek + 1);
  },

  onOpenWeekPicker() {
    this.setData({ showWeekPicker: true });
  },

  onCloseWeekPicker() {
    this.setData({ showWeekPicker: false });
  },

  /* ================= 左右滑动切换周（跟手动画） ================= */

  onTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;

    // 关键：先把上一次切页动画的收尾「结算」掉。
    // 快速连续滑动时，上一次的收尾定时器还没触发；放任它会在本次拖动中途
    // 改写位移与面板，画面被拽回去 —— 这就是「滑快了会一抽一抽」的根因。
    this._flushAnim();

    // 记录起点（存实例上，避免频繁 setData）
    this._startX = t.clientX;
    this._startY = t.clientY;
    this._startPct = this.data.trackPct;
    this._startTime = Date.now();
    this._axis = null;      // 'x' 横向 / 'y' 纵向 / null 未定
    this._dragging = false;

    // 触摸开始时关闭过渡动画，保证跟手无延迟。
    // 结算后 animate 通常已是 false，此时跳过，少一次跨线程通信。
    if (this.data.animate) this.setData({ animate: false });
  },

  onTouchMove(e) {
    const t = e.touches && e.touches[0];
    if (!t || this._startX === undefined) return;

    const dx = t.clientX - this._startX;
    const dy = t.clientY - this._startY;

    // 首次移动时判定手势方向：横向分量更大即接管，否则交给纵向滚动
    if (!this._axis) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

      if (Math.abs(dx) > Math.abs(dy)) {
        this._axis = 'x';
        this._dragging = true;
      } else {
        this._axis = 'y';
        this.setData({ animate: true, trackPct: -PANEL_PCT * this.data.trackIndex });
        return;
      }
    }

    if (this._axis !== 'x') return;

    const pageWidth = this._pageWidth || 375;
    const base = -PANEL_PCT * this.data.trackIndex;
    let pct = this._startPct + (dx / pageWidth) * PANEL_PCT;

    // 已经是第一周还向右拉 / 最后一周还向左拉 → 阻尼，给出「到头了」的手感
    const atFirst = this.data.currentWeek <= 1 && pct > base;
    const atLast = this.data.currentWeek >= this.data.totalWeeks && pct < base;

    if (atFirst || atLast) {
      pct = base + (pct - base) * 0.35;
    } else {
      // 超出最大位移后衰减，产生"拉不动"的手感
      const maxDragPct = (MAX_DRAG / pageWidth) * PANEL_PCT;
      const rel = pct - base;
      if (Math.abs(rel) > maxDragPct) {
        const sign = rel > 0 ? 1 : -1;
        pct = base + sign * (maxDragPct + (Math.abs(rel) - maxDragPct) * 0.3);
      }
    }

    this.setData({ trackPct: pct });
  },

  onTouchEnd(e) {
    if (!this._dragging || this._axis !== 'x') {
      this._resetSwipe();
      return;
    }

    const t = (e.changedTouches && e.changedTouches[0]) || null;
    const dx = t ? t.clientX - this._startX : 0;
    const dt = Date.now() - (this._startTime || 0);
    const velocity = dt > 0 ? Math.abs(dx) / dt : 0; // px/ms
    const canPrev = this.data.currentWeek > 1;
    const canNext = this.data.currentWeek < this.data.totalWeeks;

    // 触发翻页：位移超过阈值，或快速滑动（fling）即使位移不足也翻页
    if (canNext && (dx <= -SWIPE_THRESHOLD || (velocity >= FLING_VELOCITY && dx < 0))) {
      this.slideToAdjacent(1);  // 向左滑 → 下一周
    } else if (canPrev && (dx >= SWIPE_THRESHOLD || (velocity >= FLING_VELOCITY && dx > 0))) {
      this.slideToAdjacent(-1); // 向右滑 → 上一周
    } else {
      this.snapBack();
    }

    this._dragging = false;
    this._axis = null;
  },

  onTouchCancel() {
    this._resetSwipe();
  },

  _resetSwipe() {
    this._dragging = false;
    this._axis = null;
    this.snapBack();
  },

  /* ================= 课程详情 ================= */

  onTapCourse(e) {
    const course = e.currentTarget.dataset.course;
    if (!course || course.placeholder) return;

    const slotEnd = course.startSlot + course.slotCount - 1;

    this.setData({
      detail: {
        ...course,
        slotText: `第 ${course.startSlot}-${slotEnd} 节`,
        timeText: course.timeText || formatSlotTime(course.startSlot, course.slotCount),
        weekText: `第 ${this.data.currentWeek} 周 · ${this.data.currentWeek % 2 === 1 ? '单' : '双'}周`,
        weeksText: course.weeks || ''
      }
    });
  },

  onCloseDetail() {
    this.setData({ detail: null });
  },

  onDeleteCourse() {
    const detail = this.data.detail;
    if (!detail) return;

    wx.showModal({
      title: '删除课程',
      content: `确定删除「${detail.name}」吗？`,
      confirmColor: '#f53f3f',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await removeCourse(detail.id);
          this.setData({ detail: null });
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadCourses();
        } catch (err) {
          console.error('[timetable] 删除失败', err);
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      }
    });
  },

  onGoBuild() {
    wx.switchTab({ url: '/pages/build/index' });
  },

  /**
   * 空态：一张课表都没有时直接建一张
   */
  async onCreateTimetable() {
    try {
      const tt = await timetableApi.ensureDefaultTimetable();
      if (tt) {
        await this.loadCurrentTimetable();
        const pos = this.todayPos();
        this.setData({
          currentWeek: pos.week,
          todayWeek: pos.week,
          todayDow: pos.dayOfWeek,
          inTerm: pos.inTerm,
          noTimetable: false
        }, () => {
          this.buildWeekList();
          this.syncWeekBadge(this.data.currentWeek);
          this.renderTrack();
          this.loadCourses();
        });
      }
    } catch (err) {
      console.error('[timetable] 创建课表失败', err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  onRetry() {
    if (this.data.error) {
      this.loadCourses();
    } else {
      app.retryLogin().then(() => this.loadCourses());
    }
  },

  onGetToday() {
    return formatDate(new Date());
  },

  /**
   * 供 WXML 直接调用的当前时刻（HH:MM）
   */
  onGetNow() {
    return currentTimeStr();
  },

  noop() {}
});
