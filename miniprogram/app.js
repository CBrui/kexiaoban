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
   * 登录链路：微信登录 → 换取用户会话 → 确保档案存在
   * 完成后把 openid 与 profile 写入 globalData
   *
   * 注意：owner_id 是登录身份的规范化字段，由 api/profile.js 的
   * ensureProfile() 统一保证存在（云模式下取平台写入的 _openid，
   * 本地模式下取自生成的模拟身份）。这里再兜一层 _openid / _id，
   * 避免任何一个环节漏填时 openid 变成 undefined 传到「找搭子」。
   */
  async checkLogin() {
    try {
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
