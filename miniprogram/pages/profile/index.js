/**
 * pages/profile/index.js —— 个人中心
 *
 * 展示邀请码、个人资料维护、数据统计、进入提醒设置。
 */
const app = getApp();
const { updateProfile } = require('../../api/profile');
const { listCourses } = require('../../api/course');
const timetableApi = require('../../api/timetable');

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

  onRetry() {
    app.retryLogin().then(() => this.loadData());
  }
});
