/**
 * app.js —— 全局初始化
 * 职责：云服务客户端初始化、登录态检查、全局用户信息维护
 *
 * 注意：云环境 ID 通过 config.js 注入，不要提交到公开仓库。
 */
const { initClient } = require('./api/client');
const { ensureProfile, cleanupUngroupedFriends } = require('./api/profile');
const { CLOUD_ENV_ID, USE_CLOUD } = require('./config');

App({
  globalData: {
    user: null,          // 登录后写入的用户信息（profiles 表记录）
    openid: null,        // 云服务返回的用户标识
    ready: false,        // 初始化是否完成
    readyCallbacks: [],  // 等待初始化完成的回调
    // 课程数据是否已在别处被写过（手工新增 / AI 建表 / 调课）。
    // 由 api/course.js 的写操作置 true，课表页 onShow 检测到就静默重拉一次。
    // 小程序没有跨页事件总线，用这个脏标记避免每次切页都白读一次库。
    coursesDirty: false
  },

  onLaunch() {
    // 1. 初始化云服务客户端（一次即可，全局复用）
    initClient({
      envId: CLOUD_ENV_ID,
      useCloud: USE_CLOUD
    });

    // 2. 检查登录态
    this.checkLogin();
  },

  /**
   * 登录链路：wx.login 刷新会话 → 微信登录（服务端以 OPENID 为身份锚点）→ 确保档案存在
   * 完成后把 openid 与 profile 写入 globalData
   *
   * 为什么要先 wx.login()：云函数身份来自微信会话，会话过期后 callFunction 拿到的
   * OPENID 会失效或错乱。launch 时静默刷一次（失败不阻断，云函数自身也会校验）。
   *
   * 注意：owner_id 是登录身份的规范化字段，由 api/profile.js 的
   * ensureProfile() 统一保证存在（云模式优先走 auth 云函数，取平台写入的
   * _openid；本地模式用生成的模拟身份）。这里再兜一层 _openid / _id，
   * 避免任何一个环节漏填时 openid 变成 undefined 传到「找搭子」。
   */
  async checkLogin() {
    try {
      await this.loginIdentity();
      // 登录成功后清理「未分组」的同学（产品约定：未分组的同学下次登录时删除）。
      // 失败不阻断登录，仅告警。
      try {
        await cleanupUngroupedFriends();
      } catch (e) {
        console.warn('[app] 清理未分组同学失败（不影响登录）', e);
      }
    } catch (err) {
      console.error('[app] 登录失败', err);
      // 登录失败不阻断页面渲染，由页面给出重试入口
    } finally {
      this.globalData.ready = true;
      this.flushReady();
    }
  },

  /**
   * 真正执行登录链路，**失败时向上抛错**。
   *
   * 为什么拆出来：onLaunch 的 checkLogin 需要吞掉错误（不阻断渲染），
   * 而「重新登录 / 同步」这类手动入口需要把失败透出给界面做提示 ——
   * 两种诉求靠「一个会抛错的内部实现 + 各自的错误处理」满足，
   * 避免手动重试时失败被静默吃掉（点了像没反应）。
   */
  async loginIdentity() {
    await this.refreshWxSession();
    const profile = await ensureProfile();
    this.globalData.user = profile;
    this.globalData.openid = profile
      ? (profile.owner_id || profile._openid || profile.id || null)
      : null;
    if (!this.globalData.openid) {
      throw new Error('未取得用户标识 owner_id，协作功能（找搭子）将不可用');
    }
    return profile;
  },

  /**
   * 静默刷新微信登录会话（wx.login）。
   * 云开发下不需要拿 code 换 session —— callFunction 会自动携带身份；
   * 这里调它只是确保会话新鲜。失败静默（无网络时后续调用会自行报错）。
   */
  refreshWxSession() {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || !wx.login) {
        resolve(false);
        return;
      }
      wx.login({
        success: () => resolve(true),
        fail: (e) => {
          console.warn('[app] wx.login 失败（不阻断登录链路）', e);
          resolve(false);
        }
      });
    });
  },

  /**
   * 页面侧等待初始化完成的统一入口
   * 用法：app.whenReady(() => { ... })
   */
  whenReady(cb) {
    if (this.globalData.ready) {
      cb(this.globalData);
      return;
    }
    this.globalData.readyCallbacks.push(cb);
  },

  flushReady() {
    const list = this.globalData.readyCallbacks;
    while (list.length) {
      const cb = list.shift();
      try {
        cb(this.globalData);
      } catch (e) {
        console.error('[app] ready callback error', e);
      }
    }
  },

  /**
   * 手动重新登录（「重新登录 / 同步」入口）。
   *
   * 与 checkLogin 的区别：**失败会向上抛出**，调用方据此给出成功/失败提示。
   * 旧实现在失败时同样是静默的 —— 点了没有任何反馈，看起来「没效果」。
   */
  async retryLogin() {
    this.globalData.ready = false;
    try {
      return await this.loginIdentity();
    } finally {
      this.globalData.ready = true;
      this.flushReady();
    }
  }
});
