/**
 * pages/match/index.js —— 找搭子（空闲时间对齐）
 *
 * 页面结构：输入区 → 结果区（可视化网格 + 空闲时段明细）→ 兜底提示
 *
 * 可视化网格四态：
 *   free   双方都空 → 高亮
 *   clash  双方都忙（撞课）→ 标灰
 *   mine   只有我忙
 *   theirs 只有对方忙
 * 与课表页共用同一套节次轴（buildSlotAxis），因此节数、午休/晚休分隔带
 * 都与用户自己课表一致。
 *
 * 产品分水岭：若对方尚未建课表，提示「对方还没建课表」，
 *             而不是显示「全天有空」——后者技术上正确但会误导用户。
 */
const { alignFreeWithRange, alignGrid, isCounterpartEmpty } = require('../../logic/free-align');
const { listCourses, listCoursesByOwner } = require('../../api/course');
const { findByInviteCode, bindFriend, listFriends } = require('../../api/profile');
const schedule = require('../../utils/schedule');

const app = getApp();
const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 格子状态 → 显示文字（free/out 不显示文字，只靠底色区分）
const CELL_LABEL = { clash: '撞', mine: '我', theirs: '他', free: '', out: '' };

Page({
  data: {
    inviteCode: '',
    loading: false,
    friends: [],
    result: [],          // [{week, slots:[{dayLabel, from, to}]}]  空闲时段明细
    resultCount: 0,
    tip: '',             // 兜底提示
    tipType: '',         // empty | none | error
    searched: false,
    wakeSlot: 1,
    sleepSlot: 6,
    slotOptions: [],
    // 可视化网格
    dayLabels: DAY_LABELS,
    axis: [],            // 节次轴（含休息行），来自 schedule.buildSlotAxis()
    hasGrid: false,
    gridWeeks: [],       // 有课（或空闲）的周次列表
    weekIdx: 0,
    currentWeek: 0,
    gridRows: [],        // 当前周的渲染行
    freeSegments: 0      // 共同空闲时段总数（所有周次合计）
  },

  onLoad() {
    // 用「用户实际作息」的节次轴，而不是写死 12 节——这样网格才和课表页一致
    const axis = schedule.buildSlotAxis();
    const totalSlots = schedule.getTotalSlots();
    const slotOptions = [];
    for (let i = 1; i <= totalSlots; i++) slotOptions.push(i);

    this._axis = axis;
    this._totalSlots = totalSlots;

    this.setData({ axis, slotOptions, sleepSlot: totalSlots });
    app.whenReady(() => this.loadFriends());
  },

  async loadFriends() {
    const user = app.globalData.user;
    // owner_id 是「找搭子」的前提，由 api/profile.js 的 ensureProfile 规范化保证；
    // 拿不到就跳过（登录失败时不阻断页面渲染）
    if (!user || !user.owner_id) {
      console.warn('[match] 尚未取得用户标识（owner_id），跳过好友列表加载');
      return;
    }
    try {
      const rels = await listFriends(user.owner_id);
      const friends = (rels || [])
        .filter((r) => r && r.friend_owner_id)
        .map((r) => ({ owner_id: r.friend_owner_id }));
      this.setData({ friends });
    } catch (e) {
      console.error('[match] 加载同学列表失败', e);
    }
  },

  onInputCode(e) {
    this.setData({ inviteCode: e.detail.value.toUpperCase() });
  },

  onPickWake(e) {
    this.setData({ wakeSlot: Number(e.detail.value) + 1 });
  },

  onPickSleep(e) {
    this.setData({ sleepSlot: Number(e.detail.value) + 1 });
  },

  async onAlign() {
    const code = (this.data.inviteCode || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入对方的邀请码', icon: 'none' });
      return;
    }

    this.setData({
      loading: true, tip: '', tipType: '',
      result: [], hasGrid: false, gridRows: [], searched: true
    });

    try {
      // 1. 通过邀请码找到同学
      const friendProfile = await findByInviteCode(code);
      if (!friendProfile) {
        this.setData({ tip: '邀请码有误，请检查后重试', tipType: 'error' });
        return;
      }

      // 1.1 对方档案必须带身份标识，否则后续无法取课程
      if (!friendProfile.owner_id) {
        console.error('[match] 对方档案缺少身份标识（owner_id / _openid）', friendProfile);
        this.setData({ tip: '对方账号信息异常，暂时无法比对', tipType: 'error' });
        return;
      }

      const user = app.globalData.user;
      if (user && friendProfile.owner_id === user.owner_id) {
        this.setData({ tip: '不能和自己找搭子哦', tipType: 'error' });
        return;
      }

      // 2. 建立绑定关系（单向）。绑定失败不影响本次查询，仅记录告警
      if (user && user.owner_id) {
        try {
          await bindFriend(user.owner_id, friendProfile.owner_id);
        } catch (e) {
          console.warn('[match] 绑定关系失败（不影响本次查询）', e);
        }
      }

      // 3. 取双方课程
      const myCourses = await listCourses();
      const friendCourses = await listCoursesByOwner(friendProfile.owner_id);

      // 4. 对方未建课表 —— 产品分水岭
      if (isCounterpartEmpty(friendCourses)) {
        this.setData({ tip: '对方还没建课表，暂时无法比对空闲时间', tipType: 'empty' });
        return;
      }

      // 5. 计算共同空闲（文字明细，保留原功能）
      const slots = alignFreeWithRange(myCourses, friendCourses, {
        wakeSlot: this.data.wakeSlot,
        sleepSlot: this.data.sleepSlot
      });

      // 5.1 计算可视化网格（撞课/空闲四态）
      const gridRes = alignGrid(myCourses, friendCourses, {
        slotCount: this._totalSlots,
        wakeSlot: this.data.wakeSlot,
        sleepSlot: this.data.sleepSlot
      });

      if (!slots.length) {
        this.setData({
          tip: '这一学期没有找到共同空闲。可以试试放宽起床/就寝节次，或换一位同学',
          tipType: 'none'
        });
        return;
      }

      // 6. 格式化输出：空闲时段明细
      const result = slots.map((item) => ({
        week: item.week,
        slots: item.slots.map((s) => ({
          dayLabel: DAY_LABELS[s.day - 1],
          from: s.from,
          to: s.to,
          text: s.from === s.to ? `第 ${s.from} 节` : `第 ${s.from}-${s.to} 节`
        }))
      }));

      // 7. 渲染网格：默认显示第一个周次
      this._gridRes = gridRes;
      const freeSegments = slots.reduce((n, w) => n + w.slots.length, 0);
      const weekIdx = 0;
      const currentWeek = gridRes.weeks[weekIdx] || 0;

      this.setData({
        result,
        resultCount: result.length,
        freeSegments,
        hasGrid: gridRes.weeks.length > 0,
        gridWeeks: gridRes.weeks,
        weekIdx,
        currentWeek,
        gridRows: currentWeek ? this.buildGridRows(gridRes, currentWeek) : []
      });
    } catch (e) {
      console.error('[match] 对齐失败', e);
      this.setData({ tip: '查询失败，请检查网络后重试', tipType: 'error' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 把某一周的网格数据，按节次轴展开成可渲染的行。
   * 休息行整行铺开；普通节次行拆成 7 个 day 格子。
   */
  buildGridRows(gridRes, week) {
    const g = gridRes.grid[week];
    if (!g) return [];
    return this._axis.map((a) => {
      if (a.type === 'break') {
        return { type: 'break', label: a.label };
      }
      const slotIdx = a.slot - 1;
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const state = (g[d] && g[d][slotIdx]) || 'out';
        cells.push({ state, label: CELL_LABEL[state] || '' });
      }
      return { type: 'slot', slot: a.slot, start: a.start, end: a.end, cells };
    });
  },

  onPrevWeek() {
    if (this.data.weekIdx > 0) this.gotoWeek(this.data.weekIdx - 1);
  },

  onNextWeek() {
    if (this.data.weekIdx < this.data.gridWeeks.length - 1) {
      this.gotoWeek(this.data.weekIdx + 1);
    }
  },

  gotoWeek(idx) {
    const week = this.data.gridWeeks[idx];
    if (!week || !this._gridRes) return;
    this.setData({
      weekIdx: idx,
      currentWeek: week,
      gridRows: this.buildGridRows(this._gridRes, week)
    });
  },

  onRetry() {
    this.onAlign();
  },

  onGoBuild() {
    wx.switchTab({ url: '/pages/build/index' });
  }
});
