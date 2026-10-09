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

/**
 * 下一帧执行回调。
 * 小程序基础库里 canvas 场景才有 requestAnimationFrame，页面里统一用 setTimeout 兜底，
 * 保证「先写入起始态、再写入动画态」之间存在一次渲染间隔，过渡才会生效。
 */
function requestAnimationFrameCompat(fn) {
  setTimeout(fn, 0);
}

Page({
  data: {
    currentWeek: 1,
    totalWeeks: config.DEFAULT_TOTAL_WEEKS || 20,
    weeks: [],

    // 当前课表（多课表支持）：名称、开课日期、总周次都来自这张课表自身
    timetableId: null,
    timetableName: '',
    termStartMonday: config.TERM_START_MONDAY,
    termRangeText: '',   // 如 "9月7日 - 1月24日"
    noTimetable: false,  // 一张课表都没有时的空态（正常情况下 ensureDefaultTimetable 会兜底）

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
    // 多课表：先确定「当前课表」，取它自己的开课日期与总周次。
    // 首次进入时界面尚未呈现，直接定位到本周，无需动画。
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
      });
      this.buildWeekList();
      this.syncWeekBadge(this.data.currentWeek);
      this.loadCourses();
    });
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
        totalWeeks,
        termRangeText: this.formatTermRange(tt)
      });
      return tt;
    } catch (err) {
      console.error('[timetable] 读取当前课表失败', err);
      this.setData({ noTimetable: true });
      return null;
    }
  },

  /**
   * 「第 1 周周一 ~ 最后一周周日」的展示文本，用于底部状态栏
   */
  formatTermRange(tt) {
    const end = timetableApi.endDateOf(tt);
    if (!end) return '';
    const start = new Date(tt.term_start_monday);
    const fmt = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${fmt(start)} - ${fmt(end)}`;
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
    const changed = this.locateToday();
    if (changed && this.courses && this.courses.length) {
      this.renderGrid();
    }
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
        termRangeText: this.formatTermRange(tt),
        noTimetable: false,
        todayWeek: pos.week,
        todayDow: pos.dayOfWeek,
        inTerm: pos.inTerm,
        // 换了课表 → 回到本周；只改配置 → 周次越界时收敛到最后一周年
        currentWeek: idChanged
          ? pos.week
          : Math.min(this.data.currentWeek, totalWeeks)
      });

      this.buildWeekList();
      this.syncWeekBadge(this.data.currentWeek);
      this.renderGrid();
      this.updateNowLine();
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
   * @returns {boolean} 定位信息是否发生了变化（用于决定是否需要重绘网格）
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
      // 跨天检测：日期变了要刷新定位信息（是否跳周由用户决定）
      const today = formatDate(new Date());
      if (this._lastTodayDate && this._lastTodayDate !== today) {
        const changed = this.locateToday();
        if (changed && this.courses && this.courses.length) {
          this.renderGrid();
        }
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
   * 「回到今天」：带动画地跳回本周，并定位到今天所在列
   *
   * 动画按「目标周在左还是在右」决定滑动方向，符合直觉：
   *   - 目标周在当前周之后（往右找）→ 内容向左滑出，目标从右侧滑入
   *   - 目标周在当前周之前（往左找）→ 内容向右滑出，目标从左侧滑入
   *   - 已在目标周        → 不切换，只做一次轻微的「强调」回弹
   *
   * 跨多周时不逐周播放（那会花很久），而是一次性滑出 + 换数据 + 滑入。
   */
  onBackToToday() {
    const pos = this.todayPos();
    const target = pos.week;
    const current = this.data.currentWeek;
    const pageWidth = this._pageWidth || 375;

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
      this.playEmphasisAnimation();
      this.syncWeekBadge(current);
      this.renderGrid();
      this.updateNowLine();
      this._toastBackToToday(pos);
      return;
    }

    // 目标在右侧（周次更大）→ 内容向左滑出，即 direction = -1
    const direction = target > current ? -1 : 1;
    // 跨的周数越多，动画时长略增，但设上限避免拖沓
    const span = Math.abs(target - current);
    const slideDuration = Math.min(200 + (span - 1) * 30, 320);

    this.setData({ animate: false, offset: this.data.offset || 0 });

    // 第 1 步：当前内容沿目标方向滑出
    requestAnimationFrameCompat(() => {
      this.setData({ animate: true, offset: direction * pageWidth });

      // 第 2 步：换数据 + 无动画归位到反向另一侧
      setTimeout(() => {
        this.setData({
          currentWeek: target,
          animate: false,
          offset: -direction * pageWidth
        });
        this.syncWeekBadge(target);
        this.renderGrid();

        // 第 3 步：下一帧滑入居中
        setTimeout(() => {
          this.setData({ animate: true, offset: 0 });
          this.updateNowLine();
          this._toastBackToToday(pos);
        }, 20);
      }, slideDuration);
    });
  },

  /**
   * 「已在今天」时的强调动画：轻微右推再回弹，给用户「已经是这一周了」的反馈
   */
  playEmphasisAnimation() {
    const nudge = 24;
    this.setData({ animate: true, offset: nudge });
    setTimeout(() => {
      this.setData({ offset: 0 });
    }, 140);
  },

  _toastBackToToday(pos) {
    if (pos.inTerm) {
      wx.showToast({ title: `已回到第${pos.week}周`, icon: 'none' });
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
      const date = weekToDate(this.data.termStartMonday, week, d);
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

  /**
   * 点课表名称 → 进「课表管理」（新建 / 切换 / 改开课时间与周次）
   */
  onGoTimetableManage() {
    wx.navigateTo({ url: '/pages/timetable-manage/index' });
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
        });
        this.buildWeekList();
        this.syncWeekBadge(this.data.currentWeek);
        this.loadCourses();
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
