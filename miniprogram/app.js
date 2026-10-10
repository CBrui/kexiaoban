/**
 * app.js —— 全局初始化
 * 职责：云服务客户端初始化、登录态检查、全局用户信息维护
 *
 * 注意：云环境 ID 通过 config.js 注入，不要提交到公开仓库。
 */
const { initClient } = require('./api/client');
const { ensureProfile } = require('./api/profile');
const { CLOUD_ENV_ID, USE_CLOUD } = require('./config');

App({
  globalData: {
    user: null,          // 登录后写入的用户信息（profiles 表记录）
    openid: null,        // 云服务返回的用户标识
    ready: false,        // 初始化是否完成
    readyCallbacks: []   // 等待初始化完成的回调
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
      await this.refreshWxSession();
      const profile = await ensureProfile();
      this.globalData.user = profile;
      this.globalData.openid = profile
        ? (profile.owner_id || profile._openid || profile.id || null)
        : null;
      if (!this.globalData.openid) {
        console.warn('[app] 未取得用户标识 owner_id，部分协作功能（找搭子）将不可用');
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
   * 手动重试登录（提供给「云接口失败」的异常兜底）
   */
  async retryLogin() {
    this.globalData.ready = false;
    await this.checkLogin();
    return this.globalData.user;
  }
});
