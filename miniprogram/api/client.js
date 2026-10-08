/**
 * api/client.js —— 数据访问层：统一云服务客户端封装
 *
 * 铁律：所有云接口调用必须走这一条路径。
 * 不要在页面里直接散落调用，否则后续换环境或加鉴权会全线返工。
 *
 * 设计：USE_CLOUD=false 时降级为本地存储适配器（wx.storage），
 *       保证在没有云环境时也能完整开发与演示。
 */
const { USE_CLOUD } = require('../config');

let client = null;
let mode = 'local';

/**
 * 初始化客户端（一次即可，全局复用）
 * @param {object} options { envId, useCloud }
 */
function initClient(options = {}) {
  const useCloud = options.useCloud !== undefined ? options.useCloud : USE_CLOUD;

  if (useCloud && typeof wx !== 'undefined' && wx.cloud) {
    try {
      wx.cloud.init({
        env: options.envId || '',
        traceUser: true
      });
      client = wx.cloud;
      mode = 'cloud';
      console.info('[api] 云服务客户端初始化成功, env =', options.envId);
    } catch (err) {
      console.error('[api] 云服务初始化失败，降级为本地模式', err);
      mode = 'local';
    }
  } else {
    mode = 'local';
    console.info('[api] 当前为本地存储模式（未启用云服务）');
  }
  return client;
}

/**
 * 获取客户端。未初始化时抛错，避免静默失败。
 */
function getClient() {
  if (mode === 'cloud' && !client) {
    throw new Error('云服务客户端未初始化，请先调用 initClient()');
  }
  return client;
}

function getMode() {
  return mode;
}

module.exports = { initClient, getClient, getMode };
