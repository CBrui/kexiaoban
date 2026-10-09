/**
 * pages/match/index.js —— 找搭子（空闲时间对齐）
 *
 * 页面结构：输入区 → 结果区 → 兜底提示
 * 产品分水岭：若对方尚未建课表，提示「对方还没建课表」，
 *             而不是显示「全天有空」——后者技术上正确但会误导用户。
 */
const { alignFreeWithRange, isCounterpartEmpty } = require('../../logic/free-align');
const { listCourses, listCoursesByOwner } = require('../../api/course');
const { findByInviteCode, bindFriend, listFriends } = require('../../api/profile');

const app = getApp();
const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

Page({
  data: {
    inviteCode: '',
    loading: false,
    friends: [],
    result: [],          // [{week, slots:[{dayLabel, from, to}]}]
    resultCount: 0,
    tip: '',             // 兜底提示
    tipType: '',         // empty | none | error
    searched: false,
    wakeSlot: 1,
    sleepSlot: 12,
    slotOptions: []
  },

  onLoad() {
    const slots = [];
    for (let i = 1; i <= 12; i++) slots.push(i);
    this.setData({ slotOptions: slots });
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

    this.setData({ loading: true, tip: '', tipType: '', result: [], searched: true });

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

      // 5. 计算共同空闲
      const slots = alignFreeWithRange(myCourses, friendCourses, {
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

      // 6. 格式化输出
      const result = slots.map((item) => ({
        week: item.week,
        slots: item.slots.map((s) => ({
          dayLabel: DAY_LABELS[s.day - 1],
          from: s.from,
          to: s.to,
          text: s.from === s.to ? `第 ${s.from} 节` : `第 ${s.from}-${s.to} 节`
        }))
      }));

      this.setData({ result, resultCount: result.length });
    } catch (e) {
      console.error('[match] 对齐失败', e);
      this.setData({ tip: '查询失败，请检查网络后重试', tipType: 'error' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onRetry() {
    this.onAlign();
  },

  onGoBuild() {
    wx.switchTab({ url: '/pages/build/index' });
  }
});
