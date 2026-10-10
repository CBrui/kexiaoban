/**
 * pages/build/index.js —— 建表页（对话建表 / 手工录入 两个入口）
 *
 * 说明：AI 对话建表与图片识别建表共用同一条解析管线（api/ai.js），
 *       在「结构化课程 JSON」这一步汇合，之后共用同一套预览确认界面。
 *       微信版本过低（基础库 < 3.15.1）不具备 wx.cloud.extend.AI 时，
 *       自动回退到本页的本地规则解析 localParse()，保证功能不中断。
 */
const { addCourse, listCourses, updateCourse, removeCourse } = require('../../api/course');
const timetableApi = require('../../api/timetable');
const aiApi = require('../../api/ai');
const { parseWeeks } = require('../../utils/week');
const { getTotalSlots } = require('../../utils/schedule');
const shiftLogic = require('../../logic/course-shift');

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
    parseError: '',
    streamHint: '',          // 流式解析进度提示（打字机效果）
    usedAI: false,           // 本次结果来自 AI 还是本地规则（用于展示来源标识）

    // 调课（补课 / 换课 / 挪课 / 停课）
    shiftPlans: [],          // 变更计划预览（展示用，已转成 WXML 友好的结构）
    shiftError: '',
    _shiftRaw: [],           // 原始计划（含课程引用），执行时用它落库

    // 拍照导入
    imagePath: '',           // 已选图片的本地临时路径（用于预览）
    recognizing: false,      // 图片识别中
    imageHint: '',           // 识别进度提示
    imageElapsed: 0,         // 识别已耗时（秒），用于可视化等待
    imageError: '',          // 识别错误提示
    fastMode: false,         // 快速识别：跳过版式分析，省约 4 秒（周次可能读不到）
    weeksHint: '',           // 课表版式规则摘要（周次写在哪），拍图识别后展示
    weeksEvidence: '',       // 图上与周次有关的原文，供用户核对

    // missing_fields 里的字段名 → 中文标签（WXML 里直接索引取用）
    missingLabel: {
      name: '课程名',
      day_of_week: '星期',
      start_slot: '开始节次',
      weeks: '周次'
    }
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

  onUnload() {
    // 识别计时器必须随页面销毁清掉，否则页面已卸载定时器还在 setData
    if (this._recognizeTimer) {
      clearInterval(this._recognizeTimer);
      this._recognizeTimer = null;
    }
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

  /* ================= 调课：补课 / 换课 / 挪课 / 停课 ================= */

  /**
   * 构建调课所需的学期上下文
   *
   * 学期起始周与总周数**以当前课表为准**（多课表各有各的配置），
   * 课表缺失字段时才回退到全局默认，避免把 A 课表的周次套到 B 课表上。
   */
  async buildShiftCtx() {
    const config = require('../../config');
    let t = null;
    try {
      t = await timetableApi.getCurrentTimetable();
    } catch (e) {
      console.warn('[build] 获取当前课表失败，回退全局学期配置', e);
    }

    return {
      termStartMonday: (t && t.term_start_monday) || config.TERM_START_MONDAY,
      maxWeek: Number(t && t.total_weeks) || config.DEFAULT_TOTAL_WEEKS || 20,
      today: new Date()
    };
  },

  /** 把内部计划转成 WXML 可直接渲染的结构（WXML 里不能调函数） */
  toShiftView(plans) {
    const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];
    return (plans || []).map((p) => ({
      ok: p.ok,
      reason: p.reason || '',
      actionText: p.actionText || '调课',
      summary: p.summary || '',
      removeList: (p.removes || []).map((r) => ({
        name: r.name,
        slotText: r.slotText,
        nextWeeks: r.nextWeeks,
        willDelete: !!r.willDelete
      })),
      addList: (p.adds || []).map((a) => ({
        name: a.name,
        dayText: `周${DAY_TEXT[Number(a.day_of_week) - 1] || '?'}`,
        slotText: shiftLogic.slotRangeOf(a).join('-'),
        weeks: a.weeks
      })),
      conflictList: (p.conflicts || []).map((c) => ({
        name: c.name,
        slotText: c.slotText,
        withName: c.withName
      }))
    }));
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

  /* ---------- 拍照导入 ---------- */

  /**
   * 选图：优先相机，也允许从相册选（用户可能已经有教务系统截图）。
   * 微信要求拍照/选图必须由用户点击触发，不能自动调起。
   */
  onPickImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        this.setData({
          imagePath: file.tempFilePath,
          imageError: '',
          parsed: []      // 换图后清掉上一次的结果，避免误确认
        });
      },
      fail: (err) => {
        // 用户主动取消不算错误
        if (err && String(err.errMsg || '').indexOf('cancel') >= 0) return;
        this.setData({ imageError: '打开相机/相册失败，请重试' });
      }
    });
  },

  onClearImage() {
    this.setData({ imagePath: '', imageError: '', imageHint: '', parsed: [], weeksHint: '', weeksEvidence: '' });
  },

  /**
   * 切换识别模式。
   * 完整模式（默认）：云函数先做一次课表版式分析（周次写在哪），再提取课程 ——
   * 实测多约 4 秒，但周次写在标题 / 图例 / 分块时也能读出来。
   * 快速模式：跳过版式分析，只跑一次提取 —— 快，但上述版式的周次可能读不到。
   */
  onToggleFast(e) {
    this.setData({ fastMode: !!(e.detail && e.detail.value) });
  },

  /**
   * 识别入口：压缩 → 上传云存储 → 云函数调视觉模型 → 复用同一套校验与预览。
   * 与对话建表走同一条管线的不同输入形态，结果结构完全一致。
   */
  async onParseImage() {
    const filePath = this.data.imagePath;
    if (!filePath) {
      wx.showToast({ title: '请先选择一张课表图片', icon: 'none' });
      return;
    }

    this.setData({
      recognizing: true,
      imageError: '',
      imageHint: '正在压缩并上传图片…',
      imageElapsed: 0,
      weeksHint: '',
      weeksEvidence: '',
      parsed: []
    });

    // 视觉模型读一张课表要 45 秒上下，期间若界面一动不动，用户会当成卡死并
    // 提前退出（真机一旦切后台，callFunction 就会被断开并报错）。用秒表把
    // 等待可视化，让用户知道「还在跑」。
    const tickStart = Date.now();
    this._recognizeTimer = setInterval(() => {
      if (!this.data.recognizing) return;
      this.setData({ imageElapsed: Math.round((Date.now() - tickStart) / 1000) });
    }, 1000);

    try {
      const res = await aiApi.parseCoursesFromImage(filePath, {
        fast: this.data.fastMode,
        onProgress: (stage) => {
          if (!this.data.recognizing) return;
          this.setData({ imageHint: stage });
        }
      });

      if (res.ok) {
        const hint = this.buildWeeksHint(res.layout);
        let weeksHint = hint.text;
        let weeksEvidence = hint.evidence;
        if (!res.layout && this.data.fastMode) {
          // 快速模式没有版式分析。若仍有用例没读到周次，明确告诉用户怎么补救，
          // 而不是让他在预览页里自己发现「待补充」。
          const miss = res.list.filter(
            (c) => (c.missing_fields || []).indexOf('weeks') >= 0
          ).length;
          weeksHint = miss
            ? `快速模式：有 ${miss} 门课没读到周次，关掉「快速识别」重试可提高准确率`
            : '快速模式：已跳过课表版式分析';
        }
        this.setData({
          parsed: res.list,
          usedAI: true,
          imageHint: '',
          weeksHint,
          weeksEvidence
        });
        // 识别成功且已有结果，切回结果区仍在当前 tab，用户可直接核对
        wx.showToast({ title: `识别出 ${res.list.length} 门课`, icon: 'success' });
        return;
      }

      this.setData({ imageError: res.message });
    } catch (e) {
      console.error('[build] 图片识别失败', e);
      this.setData({ imageError: aiApi.messageOf(aiApi.PARSE_ERROR.MODEL_ERROR) });
    } finally {
      if (this._recognizeTimer) {
        clearInterval(this._recognizeTimer);
        this._recognizeTimer = null;
      }
      this.setData({ recognizing: false, imageHint: '', imageElapsed: 0 });
    }
  },

  /**
   * 把版式规则总结成一行提示。用户反馈过「识别不到周数」，把「周次写在哪」
   * 和「图上原文」摆出来，用户就能立刻判断是模型没读到、还是本来就没有。
   */
  buildWeeksHint(layout) {
    if (!layout) return { text: '', evidence: '' };

    const parts = [];
    if (layout.weeksSourceText) parts.push(layout.weeksSourceText);
    if (layout.mapping && layout.mapping.length) {
      const m = layout.mapping
        .map((x) => (x.scope ? `${x.scope}：${x.weeks}` : x.weeks))
        .join('；');
      parts.push(m);
    }
    const text = parts.length ? `课表规则：${parts.join('，')}` : '';

    // 图上周次原文可能有几百字，展示只留开头一段
    let evidence = layout.weeksEvidence || '';
    if (evidence.length > 60) evidence = evidence.slice(0, 60) + '…';
    return { text, evidence };
  },

  /* ---------- 对话建表 ---------- */
  onDialogInput(e) {
    this.setData({ dialogText: e.detail.value, parseError: '' });
  },

  /**
   * 调课管线：解析指令 → 生成变更计划 → 交给用户确认
   *
   * 这里只产出计划不落库。「换成」会先把目标日那一周从原课周次规则里挖掉，
   * 绝不整条删除课程——否则这门课在所有周都会消失。
   */
  async runShift(text, ctx) {
    this.setData({
      parsing: true,
      parseError: '',
      shiftError: '',
      parsed: [],
      shiftPlans: [],
      streamHint: '正在解析…'
    });

    try {
      const res = await aiApi.parseShiftInstructions(text, ctx, {
        onProgress: (chunk, full) => {
          if (!this.data.parsing) return;
          this.setData({ streamHint: `正在解析…已生成 ${full.length} 字` });
        }
      });

      if (!res.ok) {
        this.setData({
          parsing: false,
          streamHint: '',
          shiftError: aiApi.messageOf(res.code) || '没读懂这句调课，换个说法试试'
        });
        return;
      }

      const courses = await listCourses();
      const rawPlans = [];
      for (const inst of res.list) {
        rawPlans.push(shiftLogic.buildShiftPlan(inst, courses, ctx));
      }

      // 原始计划存实例上（含课程引用），不进 data，避免 WXML 遍历到内部字段
      this._shiftRaw = rawPlans;

      this.setData({
        parsing: false,
        streamHint: '',
        shiftPlans: this.toShiftView(rawPlans),
        usedAI: res.usedAI
      });
    } catch (e) {
      console.error('[build] 调课解析失败', e);
      this.setData({
        parsing: false,
        streamHint: '',
        shiftError: aiApi.messageOf(aiApi.PARSE_ERROR.MODEL_ERROR)
      });
    }
  },

  /** 丢弃调课计划 */
  onCancelShift() {
    this._shiftRaw = [];
    this.setData({ shiftPlans: [], shiftError: '' });
  },

  /** 执行调课计划：挖周 / 删课 / 新增，全部落库 */
  async onConfirmShift() {
    const plans = (this._shiftRaw || []).filter((p) => p && p.ok);
    if (!plans.length) {
      wx.showToast({ title: '没有可执行的变更', icon: 'none' });
      return;
    }

    const conflicts = plans.reduce((n, p) => n + (p.conflicts || []).length, 0);

    wx.showLoading({ title: '正在调整' });
    let removed = 0;
    let updated = 0;
    let added = 0;

    try {
      for (const p of plans) {
        for (const r of p.removes || []) {
          if (r.willDelete) {
            await removeCourse(r.courseId);
            removed++;
          } else {
            // 只改周次规则，把当天那一周挖掉，其余周次原样保留
            await updateCourse(r.courseId, { weeks: r.nextWeeks });
            updated++;
          }
        }

        for (const a of p.adds || []) {
          const rec = Object.assign({}, a);
          delete rec._from;
          await addCourse(rec);
          added++;
        }
      }

      wx.hideLoading();
      wx.showToast({
        title: `已调整：改 ${updated} · 删 ${removed} · 加 ${added}`,
        icon: 'none',
        duration: 2500
      });

      this._shiftRaw = [];
      this.setData({ shiftPlans: [], shiftError: '', dialogText: '' });

      if (conflicts) {
        console.warn('[build] 本次调课存在节次冲突', conflicts);
      }
    } catch (e) {
      wx.hideLoading();
      console.error('[build] 调课写入失败', e);
      wx.showToast({ title: '写入失败，请重试', icon: 'none' });
    }
  },

  /** 点调课示例：填入输入框并直接跑一遍，让用户马上看到效果 */
  onUseShiftExample(e) {
    const t = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.text) || '';
    if (!t) return;
    this.setData({ dialogText: t, parseError: '', shiftError: '' });
    this.onParse();
  },

  onUseExample() {
    this.setData({
      dialogText: '周一三四节高等数学，王老师，A301，1-16周单周；周三一二节英语，李老师，B203'
    });
  },

  /**
   * 解析入口：走统一解析管线（api/ai.js）。
   * 微信版本过低时管线返回 AI_UNAVAILABLE，这里自动回退本地规则解析，
   * 保证旧版微信上功能仍然可用（只是识别能力弱一些）。
   */
  async onParse() {
    const text = (this.data.dialogText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先说一句你的课表', icon: 'none' });
      return;
    }

    // 意图路由：带调课动词且能找到日期 → 走调课管线，否则走原建课管线。
    // 放在这里而不是解析之后，是为了让「今天补上周二的课」不被当成新增课程。
    const shiftCtx = await this.buildShiftCtx();
    if (shiftLogic.looksLikeShift(text, shiftCtx)) {
      return this.runShift(text, shiftCtx);
    }

    this.setData({
      parsing: true,
      parseError: '',
      parsed: [],
      streamHint: '正在解析…',
      usedAI: false,
      // 对话建表没有版式分析这一步，清掉拍图遗留的规则提示
      weeksHint: '',
      weeksEvidence: ''
    });

    try {
      const res = await aiApi.parseCourses(text, {
        onProgress: (chunk, full) => {
          // 只在仍有解析中时更新，避免流结束后的回调把提示又写回去
          if (!this.data.parsing) return;
          this.setData({ streamHint: `正在解析…已生成 ${full.length} 字` });
        }
      });

      if (res.ok) {
        this.setData({ parsed: res.list, usedAI: true, streamHint: '' });
        return;
      }

      if (res.code === aiApi.PARSE_ERROR.AI_UNAVAILABLE) {
        // 能力不具备 → 回退本地规则解析（离线可用）
        console.info('[build] 小程序 AI 能力不可用，回退本地规则解析');
        const list = this.localParse(text);
        this.setData({
          parsed: list,
          usedAI: false,
          parseError: list.length ? '' : aiApi.messageOf(aiApi.PARSE_ERROR.NO_COURSE)
        });
        return;
      }

      this.setData({ parseError: res.message });
    } catch (e) {
      console.error('[build] 解析失败', e);
      this.setData({ parseError: aiApi.messageOf(aiApi.PARSE_ERROR.MODEL_ERROR) });
    } finally {
      this.setData({ parsing: false, streamHint: '' });
    }
  },

  /**
   * 本地规则解析（降级路径）。
   * 按标点切句，逐句用正则抽字段；输出结构与 AI 管线保持一致
   * （同样带 missing_fields），这样预览页不需要区分来源。
   * @returns {object[]} 结构化课程数组
   */
  localParse(text) {
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

    // 结构校验：必填项 + 周次必须可解析（模型或规则都可能给出非法周次）
    const invalid = list.find((c) => !c.name || !c.day_of_week || !c.start_slot);
    if (invalid) {
      wx.showToast({ title: '有课程缺少必填信息,请补齐', icon: 'none' });
      return;
    }
    const badWeeks = list.find((c) => !parseWeeks(c.weeks).length);
    if (badWeeks) {
      wx.showToast({ title: '有课程周次格式有误,请检查', icon: 'none' });
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
