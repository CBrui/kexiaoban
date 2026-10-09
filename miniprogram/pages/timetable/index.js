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

Page({
  data: {
    currentWeek: 1,
    totalWeeks: 20,
    weeks: [],

    // 当前周描述
    weekBadge: { week: 1, parity: '单', label: '第1周 · 单' },

    dayLabels: DAY_LABELS,
    dayDates: [],       // 每天对应日期（如 9月7日），随周次变化
    dayIsToday: [],     // 每天是否为「今天」，用于表头高亮
    slotAxis: [],
    grid: [],
    totalSlots: 6,

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

    /**
     * 滑动动画状态
     *   offset  : 当前横向位移（px），0 表示居中
     *   animate : 是否启用过渡动画（拖动中关闭，松手后开启）
     */
    offset: 0,
    animate: true,

    // 触摸跟踪（不放 data，避免频繁 setData）
    swiping: false
  },

  onLoad() {
    // ① 先按「今天」定位到当前周（找不到则退回第 1 周）
    this.locateToday(true);
    this.buildWeekList();
    this.refreshSchedule();
    this.syncWeekBadge(this.data.currentWeek);
    app.whenReady(() => this.loadCourses());
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
      this.loadCourses();
    }
    // 跨天 / 跨周：回来时重新定位一次（例如应用被切到后台过夜）
    const changed = this.locateToday(false);
    if (changed && this.courses && this.courses.length) {
      this.renderGrid();
    }
    this.startNowTicker();
  },

  onHide() {
    this.stopNowTicker();
  },

  onUnload() {
    this.stopNowTicker();
  },

  onPullDownRefresh() {
    // 下拉时把「今天」重新定位一次，回到本周
    this.locateToday(true);
    this.syncWeekBadge(this.data.currentWeek);
    this.renderGrid();
    this.loadCourses().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 按「今天」定位到当前周
   *
   * @param {boolean} force 为 true 时强制跳回本周（首次进入 / 下拉刷新 / 点「回到今天」）；
   *                        为 false 时只更新定位信息，仅当日期真的跨周了才跟随跳转，
   *                        避免打断正在翻看其它周的用户
   */
  locateToday(force) {
    const pos = todayPosition(config.TERM_START_MONDAY, null, this.data.totalWeeks);
    const prevTodayWeek = this.data.todayWeek;
    const prevTodayDow = this.data.todayDow;
    const changed = force || pos.week !== prevTodayWeek || pos.dayOfWeek !== prevTodayDow;

    this.setData({
      todayWeek: pos.week,
      todayDow: pos.dayOfWeek,
      inTerm: pos.inTerm
    });

    // 是否应该改变用户当前所在周次：
    //   force                     → 强制回本周
    //   跨周了 且 用户正看着旧的本周 → 跟随跳转（用户没在看别的周）
    const wasViewingOldTodayWeek = this.data.currentWeek === prevTodayWeek;
    if (force || (pos.week !== prevTodayWeek && wasViewingOldTodayWeek)) {
      this.setData({ currentWeek: pos.week });
    }

    this.syncWeekBadge(this.data.currentWeek);
    this.updateNowLine();
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
   * 只在「当前周次的今天列」显示，翻到别的周时自动隐藏。
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
      // 跨天检测：日期变了要重新定位
      const today = formatDate(new Date());
      if (this._lastTodayDate && this._lastTodayDate !== today) {
        this.locateToday(false);
        this.renderGrid();
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
   * 「回到本周并定位今天」快捷操作
   */
  onBackToToday() {
    this.locateToday(true);
    this.syncWeekBadge(this.data.currentWeek);
    this.renderGrid();
    this.updateNowLine();
    if (this.data.inTerm) {
      wx.showToast({ title: '已回到本周', icon: 'none' });
    } else {
      wx.showToast({ title: '今天不在学期内', icon: 'none' });
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
    });
    if (this._ready) {
      // 行数变了，重算行高（网格主体高度已缓存）
      setTimeout(() => this.computeLayout(), 0);
    }
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
    this.setData({
      weekBadge: {
        week,
        parity: week % 2 === 1 ? '单' : '双',
        label: `第${week}周 · ${week % 2 === 1 ? '单' : '双'}`
      },
      isViewingToday,
      dayDates: this.computeDayDates(week),
      dayIsToday: this.computeDayIsToday(week)
    });
  },

  /**
   * 计算当前周每天对应的日期文本（如 9月7日）
   */
  computeDayDates(week) {
    const list = [];
    for (let d = 1; d <= 7; d++) {
      const date = weekToDate(config.TERM_START_MONDAY, week, d);
      list.push(`${date.getMonth() + 1}月${date.getDate()}日`);
    }
    return list;
  },

  /**
   * 标记当前周里哪一列是「今天」，用于表头与列高亮
   */
  computeDayIsToday(week) {
    const list = [];
    const isThisWeek = this.data.inTerm && Number(week) === this.data.todayWeek;
    for (let d = 1; d <= 7; d++) {
      list.push(isThisWeek && d === this.data.todayDow);
    }
    return list;
  },

  /**
   * 计算自适应行高：测量网格主体可用高度，按「节次行 + 休息行(40%)」分配，
   * 使课表铺满屏幕，而不是固定 104rpx 行高留大片空白。
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
    query.select('.grid-body').boundingClientRect((rect) => {
      if (rect && rect.height) {
        this._gridBodyH = rect.height;
        if (rect.width) this._pageWidth = rect.width;
        apply(rect.height);
      }
    }).exec();
  },

  async loadCourses() {
    this.setData({ loading: true, error: '' });
    try {
      const courses = await listCourses();
      this.courses = courses || [];
      this.setData({ courseCount: this.courses.length, hasAnyCourse: this.courses.length > 0 });
      this.renderGrid();
    } catch (err) {
      console.error('[timetable] 加载课程失败', err);
      this.setData({ error: '课表加载失败，请检查网络后重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 渲染当前周的网格
   * 节次轴元素与网格列一一对应：slot 行放课程，break 行放休息分隔。
   */
  renderGrid() {
    const week = this.data.currentWeek;
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

    this.setData({ grid });

    // 网格首次渲染后测量高度（grid-body 可能在课程加载完成后才出现）
    if (this._ready && !this._gridBodyH) {
      setTimeout(() => this.computeLayout(), 0);
    }
  },

  /* ================= 周次切换 ================= */

  onSwitchWeek(e) {
    const week = Number(e.currentTarget.dataset.week);
    if (!week || week === this.data.currentWeek) {
      this.setData({ showWeekPicker: false });
      return;
    }
    this.setData({ currentWeek: week, showWeekPicker: false });
    this.syncWeekBadge(week);
    this.renderGrid();
    this.updateNowLine();
  },

  onPrevWeek() {
    const w = this.data.currentWeek - 1;
    if (w >= 1) {
      this.setData({ currentWeek: w });
      this.syncWeekBadge(w);
      this.renderGrid();
      this.updateNowLine();
    }
  },

  onNextWeek() {
    const w = this.data.currentWeek + 1;
    if (w <= this.data.totalWeeks) {
      this.setData({ currentWeek: w });
      this.syncWeekBadge(w);
      this.renderGrid();
      this.updateNowLine();
    }
  },

  onOpenWeekPicker() {
    this.setData({ showWeekPicker: true });
  },

  onCloseWeekPicker() {
    this.setData({ showWeekPicker: false });
  },

  onGoScheduleSetting() {
    wx.navigateTo({ url: '/pages/schedule/index' });
  },

  /* ================= 左右滑动切换周（跟手动画） ================= */

  onTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;

    // 记录起点（存实例上，避免频繁 setData）
    this._startX = t.clientX;
    this._startY = t.clientY;
    this._startOffset = this.data.offset || 0;
    this._startTime = Date.now();
    this._axis = null;      // 'x' 横向 / 'y' 纵向 / null 未定
    this._dragging = false;

    // 触摸开始时立即关闭过渡动画，保证跟手无延迟
    this.setData({ animate: false });
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
        this.setData({ animate: true, offset: 0 });
        return;
      }
    }

    if (this._axis !== 'x') return;

    let next = this._startOffset + dx;

    // 边界阻尼：第一周右滑、最后一周左滑时位移减半
    const atFirst = this.data.currentWeek <= 1 && next > 0;
    const atLast = this.data.currentWeek >= this.data.totalWeeks && next < 0;
    if (atFirst || atLast) {
      next = next * 0.35;
    } else if (Math.abs(next) > MAX_DRAG) {
      // 超出最大位移后衰减，产生"拉不动"的手感
      const sign = next > 0 ? 1 : -1;
      next = sign * (MAX_DRAG + (Math.abs(next) - MAX_DRAG) * 0.3);
    }

    this.setData({ offset: next });
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
      this.playSwitchAnimation(-1); // 向左 → 下一周
    } else if (canPrev && (dx >= SWIPE_THRESHOLD || (velocity >= FLING_VELOCITY && dx > 0))) {
      this.playSwitchAnimation(1);  // 向右 → 上一周
    } else {
      // 未达阈值：回弹归位
      this.setData({ animate: true, offset: 0 });
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
    if (this.data.offset !== 0) {
      this.setData({ animate: true, offset: 0 });
    }
  },

  /**
   * 翻页动画：先把当前内容沿滑动方向滑出，再切换数据并从另一侧滑入。
   * 使用 CSS transform，不触发重排，性能开销低。
   * @param {number} direction 1 = 向右滑出并切到上一周，-1 = 向左滑出并切到下一周
   */
  playSwitchAnimation(direction) {
    const pageWidth = this._pageWidth || 375;

    // 第 1 步：当前内容沿滑动方向滑出屏幕
    this.setData({
      animate: true,
      offset: direction * pageWidth
    });

    // 第 2 步：切换数据 + 无动画归位到另一侧
    setTimeout(() => {
      const nextWeek = this.data.currentWeek - direction; // direction=1 → 上一周
      this.setData({
        currentWeek: nextWeek,
        animate: false,
        offset: -direction * pageWidth
      });
      this.syncWeekBadge(nextWeek);
      this.renderGrid();
      this.updateNowLine();

      // 第 3 步：下一帧滑入居中
      setTimeout(() => {
        this.setData({ animate: true, offset: 0 });
      }, 20);
    }, 200);
  },

  /**
   * 测量网格宽度（用于翻页动画的位移距离）
   */
  onGridReady() {
    if (this._pageWidth) return;
    const query = wx.createSelectorQuery().in(this);
    query.select('.grid-body').boundingClientRect((rect) => {
      if (rect && rect.width) {
        this._pageWidth = rect.width;
      }
    }).exec();
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
