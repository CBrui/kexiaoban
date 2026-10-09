/**
 * pages/timetable-manage/index.js —— 课表管理
 *
 * 多课表的核心入口。用户可以：
 *   - 新建课表（名称 / 开课日期 / 总周次）
 *   - 切换「当前课表」（课表页展示的就是它）
 *   - 修改课表的开课日期与总周次
 *   - 删除课表（连同其下所有课程，删除前明确告知数量）
 *
 * 设计要点：
 *   1. 课表 id 用字符串比较 —— 本地模式是 number，云模式是 _id 字符串
 *   2. 删除是不可逆的破坏性操作，必须弹二次确认；若课表下还有课程，
 *      在确认文案里写清楚「将一并删除 N 门课程」
 *   3. 列表项点击「编辑」进入内联编辑态（不跳新页面），保持交互轻量
 */
const timetableApi = require('../../api/timetable');
const { formatDate } = require('../../utils/week');

// 总周次可选项：1..30（与 api/timetable.js 的 clamp 范围保持一致）
const WEEK_OPTIONS = (() => {
  const list = [];
  for (let i = timetableApi.TOTAL_WEEKS_MIN; i <= timetableApi.TOTAL_WEEKS_MAX; i++) list.push(`${i} 周`);
  return list;
})();

Page({
  data: {
    list: [],            // [{ id, name, termStartMonday, totalWeeks, courseCount, isCurrent, rangeText }]
    currentId: null,
    loading: true,

    // 新建表单
    showCreate: false,
    createForm: {
      name: '',
      date: '',          // YYYY-MM-DD，picker 的 value 必须是这个格式
      weeksIndex: 19     // 默认 20 周 → 索引 19
    },

    // 编辑态（同一时刻只允许编辑一张）
    editingId: null,
    editForm: {
      name: '',
      date: '',
      weeksIndex: 19
    },

    weekOptions: WEEK_OPTIONS,
    today: '',
    maxDate: ''          // 允许选择的最晚开课日期（今天 + 1 年）
  },

  onLoad() {
    const now = new Date();
    const max = new Date(now);
    max.setFullYear(max.getFullYear() + 1);
    this.setData({
      today: formatDate(now),
      maxDate: formatDate(max),
      'createForm.date': formatDate(now),
      'createForm.weeksIndex': (timetableApi.clampTotalWeeks(20) - 1)
    });
  },

  onShow() {
    this.loadList();
  },

  /* ================= 数据加载 ================= */

  async loadList() {
    this.setData({ loading: true });
    try {
      // 保证至少有一张课表（老用户升级后自动迁移，与课表页共用同一逻辑）
      const current = await timetableApi.ensureDefaultTimetable();
      const rows = await timetableApi.listTimetables();

      const list = [];
      for (const t of rows) {
        const totalWeeks = timetableApi.clampTotalWeeks(t.total_weeks);
        const end = timetableApi.endDateOf(t);
        list.push({
          id: t.id,
          name: t.name,
          term_start_monday: t.term_start_monday,
          termStartMonday: t.term_start_monday,
          total_weeks: totalWeeks,
          totalWeeks,
          weeksIndex: totalWeeks - 1,
          courseCount: await timetableApi.countCoursesOf(t.id),
          isCurrent: current ? String(t.id) === String(current.id) : false,
          rangeText: end
            ? `${t.term_start_monday} ~ ${formatDate(end)}`
            : t.term_start_monday
        });
      }

      this.setData({
        list,
        currentId: current ? current.id : null
      });
    } catch (err) {
      console.error('[timetable-manage] 加载失败', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ================= 新建 ================= */

  onOpenCreate() {
    this.setData({
      showCreate: true,
      editingId: null,
      createForm: {
        name: '',
        date: this.data.today,
        weeksIndex: timetableApi.clampTotalWeeks(20) - 1
      }
    });
  },

  onCloseCreate() {
    this.setData({ showCreate: false });
  },

  onInputName(e) {
    this.setData({ 'createForm.name': e.detail.value });
  },

  onPickDate(e) {
    this.setData({ 'createForm.date': e.detail.value });
  },

  onPickWeeks(e) {
    this.setData({ 'createForm.weeksIndex': Number(e.detail.value) });
  },

  async onCreate() {
    const { name, date, weeksIndex } = this.data.createForm;
    const totalWeeks = weeksIndex + 1;

    wx.showLoading({ title: '创建中' });
    try {
      const created = await timetableApi.addTimetable({
        name: (name || '').trim() || '未命名课表',
        term_start_monday: date,
        total_weeks: totalWeeks
      });

      // 新建后自动切到这张课表，用户不必再点一次
      await timetableApi.setCurrent(created.id);

      wx.hideLoading();
      this.setData({ showCreate: false });
      wx.showToast({ title: '已创建并切换', icon: 'success' });
      this.loadList();
    } catch (err) {
      wx.hideLoading();
      console.error('[timetable-manage] 创建失败', err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  /* ================= 编辑（改名 / 开课日期 / 总周次） ================= */

  onOpenEdit(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((t) => String(t.id) === String(id));
    if (!item) return;

    this.setData({
      showCreate: false,
      editingId: id,
      editForm: {
        name: item.name,
        date: item.termStartMonday,
        weeksIndex: item.weeksIndex
      }
    });
  },

  onCancelEdit() {
    this.setData({ editingId: null });
  },

  onEditName(e) {
    this.setData({ 'editForm.name': e.detail.value });
  },

  onEditDate(e) {
    this.setData({ 'editForm.date': e.detail.value });
  },

  onEditWeeks(e) {
    this.setData({ 'editForm.weeksIndex': Number(e.detail.value) });
  },

  async onSaveEdit() {
    const id = this.data.editingId;
    if (id == null) return;

    const { name, date, weeksIndex } = this.data.editForm;
    wx.showLoading({ title: '保存中' });
    try {
      await timetableApi.updateTimetable(id, {
        name: (name || '').trim() || '未命名课表',
        term_start_monday: date,
        total_weeks: weeksIndex + 1
      });
      wx.hideLoading();
      this.setData({ editingId: null });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.loadList();
    } catch (err) {
      wx.hideLoading();
      console.error('[timetable-manage] 保存失败', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  /* ================= 切换当前课表 ================= */

  async onSetCurrent(e) {
    const id = e.currentTarget.dataset.id;
    if (String(id) === String(this.data.currentId)) return;

    try {
      await timetableApi.setCurrent(id);
      wx.showToast({ title: '已切换', icon: 'success' });
      this.loadList();
    } catch (err) {
      console.error('[timetable-manage] 切换失败', err);
      wx.showToast({ title: '切换失败，请重试', icon: 'none' });
    }
  },

  /* ================= 删除（级联删课程） ================= */

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((t) => String(t.id) === String(id));
    if (!item) return;

    if (this.data.list.length <= 1) {
      wx.showToast({ title: '至少保留一张课表', icon: 'none' });
      return;
    }

    const extra = item.courseCount > 0
      ? `该课表下的 ${item.courseCount} 门课程也会一并删除，`
      : '';

    wx.showModal({
      title: '删除课表',
      content: `确定删除「${item.name}」吗？${extra}此操作不可恢复。`,
      confirmText: '删除',
      confirmColor: '#f53f3f',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中' });
        try {
          const result = await timetableApi.removeTimetable(id);
          wx.hideLoading();
          const msg = result.removedCourses > 0
            ? `已删除，含 ${result.removedCourses} 门课程`
            : '已删除';
          wx.showToast({ title: msg, icon: 'success' });
          this.loadList();
        } catch (err) {
          wx.hideLoading();
          console.error('[timetable-manage] 删除失败', err);
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      }
    });
  },

  noop() {}
});
