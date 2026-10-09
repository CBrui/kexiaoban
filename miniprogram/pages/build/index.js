/**
 * pages/build/index.js —— 建表页（对话建表 / 手工录入 两个入口）
 *
 * 说明：AI 对话建表与图片识别建表共用同一条解析管线，
 *       在「结构化课程 JSON」这一步汇合，之后共用同一套预览确认界面。
 *       当前版本先实现手工录入 + 对话解析骨架（本地规则解析），
 *       接入云服务大模型后替换 parseByAI 的实现即可。
 */
const { addCourse } = require('../../api/course');
const timetableApi = require('../../api/timetable');
const { parseWeeks } = require('../../utils/week');
const { getTotalSlots } = require('../../utils/schedule');

const app = getApp();

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

Page({
  data: {
    tab: 'manual',           // manual | dialog
    dayLabels: DAY_LABELS,
    slotOptions: [],
    maxSlot: 6,              // 当前总大节数（由作息配置动态计算）
    form: {
      name: '',
      teacher: '',
      location: '',
      dayIndex: 0,
      startSlot: 1,
      slotCount: 1,
      weeks: '1-16'
    },
    // 对话解析
    dialogText: '',
    parsing: false,
    parsed: [],              // 待确认列表
    parseError: ''
  },

  onLoad() {
    this.refreshSlotOptions();
    // 多课表：课程必须归属于某张课表。没有课表时先建一张默认课表，
    // 否则这里新增的课程会没有归属而显示不出来。
    app.whenReady(() => timetableApi.ensureDefaultTimetable());
  },

  onShow() {
    // 从节次设置页返回时，总大节数可能已变化，需刷新节次选项
    this.refreshSlotOptions();
  },

  refreshSlotOptions() {
    const total = getTotalSlots();
    const slots = [];
    for (let i = 1; i <= total; i++) slots.push(i);
    this.setData({ slotOptions: slots, maxSlot: total });
  },

  onSwitchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  /* ---------- 手工录入 ---------- */
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onPickDay(e) {
    this.setData({ 'form.dayIndex': Number(e.detail.value) });
  },

  onPickStartSlot(e) {
    this.setData({ 'form.startSlot': Number(e.detail.value) });
  },

  onPickSlotCount(e) {
    this.setData({ 'form.slotCount': Number(e.detail.value) });
  },

  validateForm() {
    const f = this.data.form;
    if (!f.name.trim()) return '请填写课程名称';
    if (!parseWeeks(f.weeks).length) return '周次格式有误，例如 1-16 或 1-16 单';
    const endSlot = Number(f.startSlot) + Number(f.slotCount) - 1;
    if (endSlot > this.data.maxSlot) {
      return `节次超出范围：第 ${f.startSlot} 节连上 ${f.slotCount} 节会超过第 ${this.data.maxSlot} 节`;
    }
    return '';
  },

  async onSubmitManual() {
    const err = this.validateForm();
    if (err) {
      wx.showToast({ title: err, icon: 'none', duration: 2500 });
      return;
    }

    const f = this.data.form;
    wx.showLoading({ title: '保存中' });
    try {
      // 兜底：确保存在可归属的课表（正常路径下 onLoad 已创建）
      await timetableApi.ensureDefaultTimetable();
      await addCourse({
        name: f.name.trim(),
        teacher: f.teacher.trim(),
        location: f.location.trim(),
        day_of_week: f.dayIndex + 1,
        start_slot: Number(f.startSlot),
        slot_count: Number(f.slotCount),
        weeks: f.weeks.trim(),
        source_type: 'manual'
      });
      wx.hideLoading();
      wx.showToast({ title: '已添加', icon: 'success' });
      this.resetForm();
    } catch (e) {
      wx.hideLoading();
      console.error('[build] 保存失败', e);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  resetForm() {
    this.setData({
      form: {
        name: '',
        teacher: '',
        location: '',
        dayIndex: 0,
        startSlot: 1,
        slotCount: 2,
        weeks: '1-16'
      }
    });
  },

  onGoTimetable() {
    wx.switchTab({ url: '/pages/timetable/index' });
  },

  /* ---------- 对话建表 ---------- */
  onDialogInput(e) {
    this.setData({ dialogText: e.detail.value, parseError: '' });
  },

  onUseExample() {
    this.setData({
      dialogText: '周一三四节高等数学，王老师，A301，1-16周单周；周三一二节英语，李老师，B203'
    });
  },

  /**
   * 解析入口
   * 当前为本地规则解析（离线可用）。接入云服务大模型后，
   * 这里替换为流式调用，返回结构与 localParse 保持一致。
   */
  async onParse() {
    const text = (this.data.dialogText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先说一句你的课表', icon: 'none' });
      return;
    }

    this.setData({ parsing: true, parseError: '', parsed: [] });
    try {
      const list = await this.parseByAI(text);
      if (!list.length) {
        this.setData({
          parseError: '没太看懂,可以说得更具体一点,比如「周一三四节高数」'
        });
      }
      this.setData({ parsed: list });
    } catch (e) {
      console.error('[build] 解析失败', e);
      this.setData({ parseError: '解析失败,可以改用下面的手工录入' });
    } finally {
      this.setData({ parsing: false });
    }
  },

  /**
   * 解析实现。本地规则版：按标点切句，逐句抽取字段。
   * 后续替换为云服务大模型流式调用，输出结构保持一致。
   * @returns {Promise<object[]>} 结构化课程数组
   */
  async parseByAI(text) {
    const sentences = text.split(/[;；\n]+/).map((s) => s.trim()).filter(Boolean);
    const result = [];

    const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    const DAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

    for (const s of sentences) {
      const item = {
        name: '',
        day_of_week: 0,
        start_slot: 0,
        slot_count: 1,
        teacher: '',
        location: '',
        weeks: '1-16',
        missing_fields: []
      };

      // 星期
      const dayMatch = s.match(/(?:周|星期)([一二三四五六日天])/);
      if (dayMatch) {
        item.day_of_week = DAY_MAP[dayMatch[1]] || 0;
      } else {
        item.missing_fields.push('day_of_week');
      }

      // 节次：支持「三四节」「一二节」「5-6节」
      const slotMatch = s.match(/(?:第)?([一二三四五六七八九十]+|\d+)[-~到至]?(?:([一二三四五六七八九十]+|\d+))?节/);
      if (slotMatch) {
        const toNum = (v) => (/^\d+$/.test(v) ? parseInt(v, 10) : CN_NUM[v] || 0);
        const a = toNum(slotMatch[1]);
        const b = slotMatch[2] ? toNum(slotMatch[2]) : a;
        if (a && b && b >= a) {
          item.start_slot = a;
          item.slot_count = b - a + 1;
        }
      }
      if (!item.start_slot) item.missing_fields.push('start_slot');

      // 周次
      const weekMatch = s.match(/(\d+\s*[-~到至]\s*\d+\s*周?\s*(?:单|双)?周?|\d+\s*周)/);
      if (weekMatch) {
        item.weeks = weekMatch[1].replace(/周/g, '').trim();
      }

      // 教师
      const teacherMatch = s.match(/([\u4e00-\u9fa5]{1,3}(?:老师|教授|讲师))/);
      if (teacherMatch) item.teacher = teacherMatch[1];

      // 地点：教室号模式，如 A301 / 教三201
      const locMatch = s.match(/([A-Za-z]?\d{2,4}(?:室|教室)?|[\u4e00-\u9fa5]{1,3}楼\d{2,4})/);
      if (locMatch) item.location = locMatch[1];

      // 课程名：去掉已识别的片段后剩余的连续中文
      let name = s
        .replace(/(?:周|星期)[一二三四五六日天]/g, '')
        .replace(/(?:第)?([一二三四五六七八九十]+|\d+)[-~到至]?(?:([一二三四五六七八九十]+|\d+))?节/g, '')
        .replace(/(\d+\s*[-~到至]\s*\d+\s*周?\s*(?:单|双)?周?|\d+\s*周)/g, '')
        .replace(/([\u4e00-\u9fa5]{1,3}(?:老师|教授|讲师))/g, '')
        .replace(/([A-Za-z]?\d{2,4}(?:室|教室)?|[\u4e00-\u9fa5]{1,3}楼\d{2,4})/g, '')
        .replace(/[，,。.、\s]/g, '');
      if (name) {
        item.name = name;
      } else {
        item.missing_fields.push('name');
      }

      result.push(item);
    }

    return result;
  },

  onEditParsed(e) {
    const idx = e.currentTarget.dataset.idx;
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({ [`parsed[${idx}].${field}`]: value });
  },

  onRemoveParsed(e) {
    const idx = e.currentTarget.dataset.idx;
    const list = this.data.parsed.slice();
    list.splice(idx, 1);
    this.setData({ parsed: list });
  },

  async onConfirmParsed() {
    const list = this.data.parsed || [];
    if (!list.length) return;

    // 结构校验：必填项
    const invalid = list.find((c) => !c.name || !c.day_of_week || !c.start_slot);
    if (invalid) {
      wx.showToast({ title: '有课程缺少必填信息,请补齐', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '写入中' });
    try {
      // 兜底：确保存在可归属的课表
      await timetableApi.ensureDefaultTimetable();
      const records = list.map((c) => ({
        name: c.name,
        teacher: c.teacher,
        location: c.location,
        day_of_week: Number(c.day_of_week),
        start_slot: Number(c.start_slot),
        slot_count: Number(c.slot_count) || 1,
        weeks: c.weeks || '1-16',
        raw_text: this.data.dialogText,
        source_type: 'dialog'
      }));
      for (const r of records) {
        await addCourse(r);
      }
      wx.hideLoading();
      wx.showToast({ title: `已添加 ${records.length} 门课`, icon: 'success' });
      this.setData({ parsed: [], dialogText: '' });
      setTimeout(() => this.onGoTimetable(), 800);
    } catch (e) {
      wx.hideLoading();
      console.error('[build] 批量写入失败', e);
      wx.showToast({ title: '写入失败，请重试', icon: 'none' });
    }
  }
});
