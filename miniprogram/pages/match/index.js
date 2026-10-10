/**
 * pages/match/index.js —— 找搭子 / 多人课表共享（空闲时间对齐）
 *
 * 页面结构：输入区（邀请码 + 已绑定同学多选）→ 结果区（可视化网格 + 明细）→ 兜底提示
 *
 * 多人语义：
 *   参与者 = 我 + 勾选的同学（可再凭邀请码临时加一位）。
 *   「空闲」= **全员都空**；网格四态见 alignGrid / alignGridMulti。
 *   2 人时保留更细的「我忙 / 对方忙」区分；≥3 人合并为「部分空闲 x/N」。
 *
 * 可视化网格四态：
 *   free   全员都空 → 高亮
 *   clash  全员都忙（撞课）→ 标灰
 *   mine/theirs（仅 2 人）只有一方忙
 *   partial（≥3 人）部分人忙
 * 节次轴与课表页共用（buildSlotAxis），节数、午休/晚休分隔带保持一致。
 *
 * 产品分水岭：被选同学若一门课都没有，跳过并在结果里说明，而不是当成「全天有空」。
 * 「没录课程」再分三种，提示语各不相同（见 onAlign）：
 *   绑定已失效（对方身份变了）/ 还没建课表 / 建了课表但还没录入课程。
 * 另外：自己一门课都没有时直接拦下 —— 否则「共同空闲」全是假象。
 */
const {
  alignFreeWithRange, alignGrid,
  alignFreeMulti, alignGridMulti,
  isCounterpartEmpty
} = require('../../logic/free-align');
const { listCourses, fetchFriendCourses } = require('../../api/course');
const {
  findByInviteCode, bindFriend, listFriendProfiles,
  updateFriendGroup, removeFriend
} = require('../../api/profile');
const schedule = require('../../utils/schedule');

const app = getApp();
const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 2 人模式的格子文字（free/out 不显示文字，只靠底色区分）
const CELL_LABEL = { clash: '撞', mine: '我', theirs: '他', free: '', out: '' };

Page({
  data: {
    inviteCode: '',
    loading: false,
    friendChips: [],     // [{owner_id, nickname, avatar_url, group, selected}]
    friendGroups: [],    // [{name, chips:[{...chip, idx}]}] 分组渲染视图
    selectedCount: 0,
    tip: '',
    tipType: '',         // empty | none | error
    searched: false,
    wakeSlot: 1,
    sleepSlot: 6,
    slotOptions: [],
    // 可视化网格
    dayLabels: DAY_LABELS,
    axis: [],
    hasGrid: false,
    gridMode: 'duo',     // duo(2人) | multi(≥3人)
    participantsLabel: '',
    skippedNote: '',
    gridWeeks: [],
    weekIdx: 0,
    currentWeek: 0,
    gridRows: [],
    freeSegments: 0
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
      const friends = await listFriendProfiles(user.owner_id);
      const friendChips = (friends || [])
        .filter((f) => f && f.owner_id)
        .map((f) => ({
          owner_id: f.owner_id,
          nickname: f.nickname || this.shortId(f.owner_id),
          avatar_url: f.avatar_url || '',
          group: f.group || '',
          selected: false
        }));
      this.setData({
        friendChips,
        friendGroups: this.buildFriendGroups(friendChips)
      });
    } catch (e) {
      console.error('[match] 加载同学列表失败', e);
    }
  },

  /**
   * 把扁平的同学列表按分组拆成渲染视图。
   * 未分组（group 为空）归入 name='' 的组，界面显示为「未分组」。
   */
  buildFriendGroups(chips) {
    const order = [];
    const map = {};
    chips.forEach((c, idx) => {
      const key = (c.group && String(c.group).trim()) || '';
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(Object.assign({}, c, { idx }));
    });
    return order.map((key) => ({ name: key, chips: map[key] }));
  },

  /** 现有分组名（去重、保持出现顺序） */
  existingGroups() {
    const set = [];
    this.data.friendChips.forEach((c) => {
      const g = (c.group && String(c.group).trim()) || '';
      if (g && set.indexOf(g) < 0) set.push(g);
    });
    return set;
  },

  /** 昵称缺失时的兜底显示：同学 + 身份尾号 */
  shortId(ownerId) {
    const s = String(ownerId || '');
    return '同学' + (s.length > 4 ? s.slice(-4) : s);
  },

  onToggleFriend(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const chip = this.data.friendChips[idx];
    if (!chip) return;
    const key = `friendChips[${idx}].selected`;
    const selected = !chip.selected;
    this.setData({
      [key]: selected,
      selectedCount: this.data.friendChips.filter((c, i) => (i === idx ? selected : c.selected)).length
    });
  },

  onInputCode(e) {
    this.setData({ inviteCode: e.detail.value.toUpperCase() });
  },

  /* ---------- 长按同学：分组 / 删除 ---------- */
  onLongPressFriend(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const chip = this.data.friendChips[idx];
    if (!chip) return;
    this._pressIdx = idx;

    const groups = this.existingGroups();
    // wx.showActionSheet 最多 6 项，分组超出时截断（仍可「新建分组」）
    const itemList = groups.slice(0, 4).concat(['新建分组', '删除']);
    wx.showActionSheet({
      itemList,
      success: (res) => this.onFriendAction(res.tapIndex, groups)
    });
  },

  async onFriendAction(tapIndex, groups) {
    const chip = this.data.friendChips[this._pressIdx];
    if (!chip) return;

    if (tapIndex < groups.length) {
      // 选择已有分组
      await this.applyFriendGroup(chip.owner_id, groups[tapIndex]);
    } else if (tapIndex === groups.length) {
      // 新建分组：弹输入框
      wx.showModal({
        title: '新建分组',
        editable: true,
        placeholderText: '输入分组名称',
        success: async (r) => {
          if (r.confirm && r.content) {
            await this.applyFriendGroup(chip.owner_id, r.content.trim());
          }
        }
      });
    } else {
      // 删除
      wx.showModal({
        title: '删除同学',
        content: `确定删除「${chip.nickname}」吗？删除后需重新用邀请码添加。`,
        confirmColor: '#f53f3f',
        success: async (r) => {
          if (r.confirm) await this.applyRemoveFriend(chip.owner_id);
        }
      });
    }
  },

  async applyFriendGroup(ownerId, group) {
    try {
      await updateFriendGroup(ownerId, group);
      wx.showToast({ title: '已设置分组', icon: 'success' });
      await this.loadFriends();
    } catch (e) {
      console.error('[match] 设置分组失败', e);
      wx.showToast({ title: '设置失败，请重试', icon: 'none' });
    }
  },

  async applyRemoveFriend(ownerId) {
    try {
      await removeFriend(ownerId);
      wx.showToast({ title: '已删除', icon: 'success' });
      await this.loadFriends();
    } catch (e) {
      console.error('[match] 删除同学失败', e);
      wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    }
  },

  onPickWake(e) {
    this.setData({ wakeSlot: Number(e.detail.value) + 1 });
  },

  onPickSleep(e) {
    this.setData({ sleepSlot: Number(e.detail.value) + 1 });
  },

  async onAlign() {
    const code = (this.data.inviteCode || '').trim();
    const picked = this.data.friendChips.filter((c) => c.selected);

    if (!picked.length && !code) {
      wx.showToast({ title: '请勾选同学，或输入对方邀请码', icon: 'none' });
      return;
    }

    this.setData({
      loading: true, tip: '', tipType: '',
      hasGrid: false, gridRows: [], skippedNote: '', searched: true
    });

    try {
      const user = app.globalData.user;
      const myOwnerId = user && user.owner_id;

      // 1. 组建参与者：勾选的同学 + 邀请码临时添加的一位
      const participants = picked.map((c) => ({
        owner_id: c.owner_id,
        nickname: c.nickname
      }));

      if (code) {
        const friendProfile = await findByInviteCode(code);
        if (!friendProfile) {
          this.setData({ tip: '邀请码有误，请检查后重试', tipType: 'error' });
          return;
        }
        if (!friendProfile.owner_id) {
          console.error('[match] 对方档案缺少身份标识（owner_id / _openid）', friendProfile);
          this.setData({ tip: '对方账号信息异常，暂时无法比对', tipType: 'error' });
          return;
        }
        if (myOwnerId && friendProfile.owner_id === myOwnerId) {
          this.setData({ tip: '不能和自己找搭子哦', tipType: 'error' });
          return;
        }
        if (participants.some((p) => p.owner_id === friendProfile.owner_id)) {
          wx.showToast({ title: '该同学已在列表中', icon: 'none' });
        } else {
          participants.push({
            owner_id: friendProfile.owner_id,
            nickname: friendProfile.nickname || this.shortId(friendProfile.owner_id)
          });
        }
        // 建立绑定关系（单向）。绑定失败不影响本次查询，仅记录告警
        if (myOwnerId) {
          try {
            await bindFriend(myOwnerId, friendProfile.owner_id, {
              nickname: friendProfile.nickname || '',
              avatar_url: friendProfile.avatar_url || ''
            });
          } catch (e) {
            console.warn('[match] 绑定关系失败（不影响本次查询）', e);
          }
          // 把新同学补进多选列表，方便下次直接勾选
          this.loadFriends();
        }
      }

      if (!participants.length) {
        wx.showToast({ title: '请勾选至少一位同学', icon: 'none' });
        return;
      }

      // 2. 取双方/多方课程（我 + 每位参与者）。
      //    先看自己：自己一门课都没有时，「共同空闲」必然是假象（自己这边全空），
      //    结果会把人误导 —— 明确拦下并引导去录课程，而不是给一份看起来正常的结果。
      const myCourses = await listCourses();
      if (isCounterpartEmpty(myCourses)) {
        this.setData({
          tip: '你还没录入课程，先添加课程再和同学比对空闲时间',
          tipType: 'empty'
        });
        return;
      }

      const friendEntries = await Promise.all(
        participants.map((p) =>
          fetchFriendCourses(p.owner_id).catch(() => ({
            courses: [], hasTimetable: false, staleBinding: false
          }))
        )
      );

      // 3. 没有可用于比对课程的同学跳过（不能当成「全天有空」，会误导）。
      //    按原因分三类，提示语各不相同：
      //      · 绑定已失效 —— 对方身份变了，旧绑定读不到其课程，需重新添加
      //      · 还没建课表
      //      · 建了课表、只是还没录入课程
      const valid = [];
      const skipped = [];   // [{ nickname, hasTimetable, staleBinding }]
      participants.forEach((p, i) => {
        const entry = friendEntries[i];
        if (isCounterpartEmpty(entry.courses)) {
          skipped.push({
            nickname: p.nickname,
            hasTimetable: !!entry.hasTimetable,
            staleBinding: !!entry.staleBinding
          });
        } else {
          valid.push({ ...p, courses: entry.courses });
        }
      });

      // 把已跳过的同学按原因分组，拼出准确的提示语
      const staleNames = skipped.filter((s) => s.staleBinding).map((s) => s.nickname);
      const noTableNames = skipped
        .filter((s) => !s.staleBinding && !s.hasTimetable).map((s) => s.nickname);
      const noCourseNames = skipped
        .filter((s) => !s.staleBinding && s.hasTimetable).map((s) => s.nickname);
      const skipParts = [];
      if (staleNames.length) {
        skipParts.push(`${staleNames.join('、')}的绑定已失效，请让对方重新分享邀请码后重新添加`);
      }
      if (noTableNames.length) skipParts.push(`${noTableNames.join('、')}还没建课表`);
      if (noCourseNames.length) skipParts.push(`${noCourseNames.join('、')}建了课表但还没录入课程`);

      if (!valid.length) {
        this.setData({
          tip: `${skipParts.join('；')}，暂时无法比对空闲时间`,
          tipType: 'empty'
        });
        return;
      }

      const skippedNote = skipParts.length ? `${skipParts.join('；')}，本次未参与比对` : '';
      const courseLists = [myCourses].concat(valid.map((v) => v.courses));
      const range = {
        wakeSlot: this.data.wakeSlot,
        sleepSlot: this.data.sleepSlot
      };
      const isDuo = valid.length === 1;

      // 4. 计算共同空闲（文字明细）。
      //    注意两者返回形态不同：alignFreeWithRange 直接返回数组，
      //    alignFreeMulti 返回 { weeks, result } —— 这里统一收敛成数组
      const freeList = isDuo
        ? alignFreeWithRange(myCourses, valid[0].courses, range)
        : alignFreeMulti(courseLists, range).result;

      // 5. 计算可视化网格
      const gridRes = isDuo
        ? alignGrid(myCourses, valid[0].courses, Object.assign({ slotCount: this._totalSlots }, range))
        : alignGridMulti(courseLists, Object.assign({ slotCount: this._totalSlots }, range));

      if (!freeList.length) {
        this.setData({
          tip: '这一学期没有找到共同空闲。可以试试放宽起床/就寝节次，或减少参与人数',
          tipType: 'none',
          skippedNote
        });
        return;
      }

      // 6. 渲染网格：默认显示第一个周次（空闲时段明细已移除，只保留网格）
      this._gridRes = gridRes;
      const freeSegments = freeList.reduce((n, w) => n + w.slots.length, 0);
      const weekIdx = 0;
      const currentWeek = gridRes.weeks[weekIdx] || 0;
      const names = valid.map((v) => v.nickname || this.shortId(v.owner_id));

      this.setData({
        freeSegments,
        hasGrid: gridRes.weeks.length > 0,
        gridMode: isDuo ? 'duo' : 'multi',
        participantsLabel: isDuo ? `我与 ${names[0]}` : `我与 ${names.length} 位同学`,
        skippedNote,
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
   * 兼容两种格子形态：alignGrid 的字符串态 / alignGridMulti 的对象态。
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
        const raw = (g[d] && g[d][slotIdx]) || 'out';
        const state = typeof raw === 'string' ? raw : raw.state;
        let label = '';
        if (typeof raw === 'string') {
          label = CELL_LABEL[state] || '';
        } else if (state === 'partial') {
          label = `${raw.freeCount}/${raw.total}`;
        }
        cells.push({ state, label });
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
