/**
 * pages/profile/index.js —— 个人中心
 *
 * 展示邀请码、个人资料维护、数据统计、进入提醒设置。
 */
const app = getApp();
const { updateProfile } = require('../../api/profile');
const { listCourses } = require('../../api/course');
const timetableApi = require('../../api/timetable');
const { getMode, getClient } = require('../../api/client');

Page({
  data: {
    profile: null,
    courseCount: 0,
    timetableCount: 0,
    totalWeeks: 0,
    timetableName: '',
    loading: true,
    editMode: false,
    form: {
      nickname: '',
      college: '',
      major: '',
      class_name: ''
    }
  },

  onShow() {
    app.whenReady(() => this.loadData());
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const profile = app.globalData.user;

      // 当前课表：课程数、总周次、课表张数都跟随当前课表
      const current = await timetableApi.getCurrentTimetable();
      const all = await timetableApi.listTimetables();
      const courses = await listCourses();

      this.setData({
        profile,
        courseCount: (courses || []).length,
        timetableCount: (all || []).length,
        timetableName: current ? current.name : '',
        totalWeeks: current ? timetableApi.clampTotalWeeks(current.total_weeks) : 0,
        form: profile
          ? {
              nickname: profile.nickname || '',
              college: profile.college || '',
              major: profile.major || '',
              class_name: profile.class_name || ''
            }
          : {
              nickname: '',
              college: '',
              major: '',
              class_name: ''
            }
      });
    } catch (e) {
      console.error('[profile] 加载失败', e);
    } finally {
      this.setData({ loading: false });
    }
  },

  onGoTimetableManage() {
    wx.navigateTo({ url: '/pages/timetable-manage/index' });
  },

  onCopyInvite() {
    const profile = this.data.profile;
    if (!profile || !profile.invite_code) return;
    wx.setClipboardData({
      data: profile.invite_code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    });
  },

  /**
   * 选择微信头像（open-type="chooseAvatar"）。
   * 拿到的是临时路径，云模式下先传云存储再落库（fileID 可直接用于 <image>）；
   * 本地模式没有云存储，仅本次会话可见。
   */
  async onChooseAvatar(e) {
    const tempUrl = e.detail && e.detail.avatarUrl;
    const profile = this.data.profile;
    if (!tempUrl || !profile) return;

    wx.showLoading({ title: '更新头像' });
    try {
      let finalUrl = tempUrl;
      if (getMode() === 'cloud' && wx.cloud && wx.cloud.uploadFile) {
        const cloudPath = `avatars/${profile.owner_id}-${Date.now()}.jpg`;
        const up = await getClient().uploadFile({ cloudPath, filePath: tempUrl });
        finalUrl = up.fileID;
      }
      await updateProfile(profile.id, { avatar_url: finalUrl });
      app.globalData.user = { ...profile, avatar_url: finalUrl };
      this.setData({ profile: app.globalData.user });
      wx.hideLoading();
      wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.error('[profile] 更新头像失败', err);
      wx.showToast({ title: '头像更新失败，请重试', icon: 'none' });
    }
  },

  onToggleEdit() {
    this.setData({ editMode: !this.data.editMode });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  async onSaveProfile() {
    const profile = this.data.profile;
    if (!profile) return;

    wx.showLoading({ title: '保存中' });
    try {
      const updated = await updateProfile(profile.id, this.data.form);
      app.globalData.user = { ...profile, ...updated };
      this.setData({ profile: app.globalData.user, editMode: false });
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      console.error('[profile] 保存失败', e);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  onGoReminder() {
    wx.navigateTo({ url: '/pages/reminder/index' });
  },

  onGoSchedule() {
    wx.navigateTo({ url: '/pages/schedule/index' });
  },

  onGoBuild() {
    wx.switchTab({ url: '/pages/build/index' });
  },

  onClearLocal() {
    wx.showModal({
      title: '清空本地数据',
      content: '将删除本机存储的课表与设置（仅本地模式生效），确定继续吗？',
      confirmColor: '#f53f3f',
      success: (res) => {
        if (!res.confirm) return;
        try {
          wx.clearStorageSync();
          wx.showToast({ title: '已清空', icon: 'success' });
          setTimeout(() => this.loadData(), 800);
        } catch (e) {
          wx.showToast({ title: '清空失败', icon: 'none' });
        }
      }
    });
  },

  /**
   * 重新登录 / 同步。
   *
   * 真正重跑一遍登录链路（wx 会话 → 服务端登录 → 档案），再重新拉取本页数据。
   * 旧实现只有 `retryLogin().then(() => loadData())` —— 既没有加载反馈、也不处理失败，
   * 而本页数据在重登后通常没变化，于是点上去界面毫无动静，看起来「没效果」。
   * 这里补上：加载提示 + 成功/失败提示 + 防重复点击。
   */
  async onRetry() {
    if (this._relogging) return;
    this._relogging = true;

    wx.showLoading({ title: '正在重新登录…', mask: true });
    try {
      const user = await app.retryLogin();
      await this.loadData();
      wx.hideLoading();
      const ok = !!(user && user.owner_id);
      wx.showToast({
        title: ok ? '已重新登录' : '登录未完成，请检查网络',
        icon: ok ? 'success' : 'none'
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[profile] 重新登录失败', e);
      wx.showToast({ title: '重新登录失败，请检查网络后重试', icon: 'none' });
    } finally {
      this._relogging = false;
    }
  }
});
