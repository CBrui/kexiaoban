/**
 * 云函数 recognizeTimetable —— 课表截图识别（P2 · M5）
 *
 * 为什么必须走云函数：
 *   1. 图片理解需要多模态模型，`wx.cloud.extend.AI`（小程序端）只提供文本生成；
 *   2. 云函数运行在服务端，可用 `@cloudbase/node-sdk` 的 AI 能力，且
 *      模型密钥不落到客户端（客户端打包后可反编译，硬编码密钥等于公开）。
 *
 * 为什么图片走云存储而不是 base64 直传：
 *   `wx.cloud.callFunction` 的入参体积上限约 1MB，手机原图 base64 后轻松两三兆，
 *   直传必挂。客户端先把压缩后的图上传云存储、拿到 fileID，云函数再按 fileID
 *   下载 —— 云函数内部的网络调用不受这个 1MB 限制。
 *
 * 与 P1 的关系：
 *   本函数只负责「图片 → 结构化课程 JSON」这一段，返回的字段与客户端
 *   `api/ai.js` 的 Schema 完全一致（name / day_of_week / start_slot /
 *   slot_count / teacher / location / weeks）。客户端复用同一套校验与预览页，
 *   这就是「对话建表与图片识别是同一条管线的两种输入形态」的落地。
 *
 * 传输契约（event）：
 *   { fileID: string }  → { ok: true, raw: string }   raw 为模型原始输出
 *   错误统一返回 { ok: false, error, message }
 *
 * 注意：本函数**不**解析 JSON。解析与校验统一由客户端 `api/ai.js` 完成，
 * 避免同一套逻辑在两端各写一遍。云函数只保证「拿到模型的完整文本输出」。
 */
const cloud = require('wx-server-sdk');

// AI 请求默认超时只有 15 秒 —— 视觉模型读一张课表往往要 20~60 秒，
// 实测 15 秒必然 ESOCKETTIMEDOUT。t1-vision 属深度思考系列，实测单张课表
// 超过 60 秒，因此这里给到 280 秒（云函数本身设 300 秒，留 20 秒给下载与收尾）。
// 注意：wx-server-sdk 需 4.0.1+ 才有 cloud.ai()。
const AI_TIMEOUT = 280000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: AI_TIMEOUT });

const ai = cloud.ai();

// 视觉模型：hunyuan-t1-vision 是专用多模态理解模型（OpenAI 兼容的 image_url 结构），
// 优点：格式兼容、输入便宜；缺点：t1 是深度思考系列，一张课表要 60 秒以上。
// 已实测排除的替代：hunyuan-turbos-vision-video-20250728 对这种 messages 结构返回 400
// （它是 video_url 优先的视频模型，图片走不同参数），因此仍用 t1-vision。
// 模型需先在环境里启用（DescribeAIModels → UpdateAIModel，见 README 部署步骤）。
const VISION_MODEL = 'hunyuan-t1-vision-20250916';
const MODEL_GROUP = 'cloudbase';

// 单张图片大小上限（字节）：超过直接拒绝，避免把超大图喂给模型浪费额度
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const fail = (error, message, extra) =>
  Object.assign({ ok: false, error, message: message || '' }, extra || {});

/**
 * 系统提示词：把模型输出空间压缩到「固定字段 JSON 数组」。
 * 与客户端 P1 的提示词口径保持一致，但额外强调网格布局的判读规则 ——
 * 截图是二维表格，模型需要理解「横轴星期、纵轴节次」才能正确映射坐标。
 *
 * 实战教训（2026-10-10 实测）：hunyuan-t1-vision 若不给出示例，会自创字段名
 * （day / period / courseName / classroom）、用中文写星期、并把结果包进
 * <answer> 标签。仅靠「字段固定为…」的说明约束不住，必须给一条完整示例。
 */
const SYSTEM_PROMPT = [
  '你是一个课表识别助手。用户会给你一张课表截图或照片，你要把它还原成结构化 JSON。',
  '',
  '课表通常是二维表格：横向是星期（周一…周日），纵向是节次（第1节…第N节），',
  '格子里是课程名称、教师、教室等信息。一门课如果跨多个节次，会占用多个连续的格子。',
  '',
  '【输出格式铁律】',
  '只输出一个 JSON 数组。不要输出任何解释、不要加 markdown 代码块、不要加 <answer> 等标签。',
  '第一个字符必须是 [ ，最后一个字符必须是 ] 。',
  '字段名必须严格使用下面这 7 个英文名，禁止改名、禁止增加字段：',
  '  name         课程名（字符串）',
  '  day_of_week  星期几（数字 1-7，1=周一）',
  '  start_slot   开始节次（数字，取该课占用的第一个节次）',
  '  slot_count   连续节数（数字，跨几节就填几，只占一节填 1）',
  '  teacher      教师（字符串）',
  '  location     上课地点（字符串）',
  '  weeks        周次规则（字符串，如 "1-16" 或 "1-16 单" 或 "3,5,7"）',
  '',
  '【正确输出示例】（严格照此格式，注意字段名与数字类型）',
  '[',
  '  {"name":"高等数学","day_of_week":1,"start_slot":1,"slot_count":2,"teacher":"张伟","location":"A101","weeks":"1-16"},',
  '  {"name":"大学英语","day_of_week":1,"start_slot":3,"slot_count":1,"teacher":"李娜","location":"B203","weeks":null}',
  ']',
  '',
  '【判读规则】',
  '1. 只填写图片中明确可见的信息。看不清或没有的字段一律填 null，绝对不要猜测或编造。',
  '2. 一门课跨多个节次时必须合并为一条记录（slot_count 填跨的节数），不要逐个格子拆成多条。',
  '3. 同一时段若确有多门课（单双周交替、上下半学期不同课），按不同课程分别输出。',
  '4. 节次序号以左侧表头（「第1节」「第2节」…）为准；表头被裁掉无法确定时 start_slot 填 null。',
  '5. 星期必须是 1-7 的数字，不要写「周一」；周次是字符串，不要换算成别的形式。',
  '6. 图片里没有可识别的课程（拍糊了、不是课表），输出空数组 []。'
].join('\n');

/**
 * 下载云存储文件并转 base64。
 * 云函数内下载不受 callFunction 的 1MB 入参限制。
 */
async function downloadAsBase64(fileID) {
  const res = await cloud.downloadFile({ fileID });
  const buffer = res.fileContent;
  if (!buffer || !buffer.length) {
    throw new Error('EMPTY_FILE');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('TOO_LARGE');
  }
  return {
    base64: buffer.toString('base64'),
    bytes: buffer.length
  };
}

/**
 * 从 fileID 推断 MIME 类型。微信云存储的 fileID 不带扩展名时占多数，
 * 兜底用 jpeg（wx.compressImage 的默认输出格式）。
 */
function mimeOf(fileID) {
  const s = String(fileID || '').toLowerCase();
  if (s.indexOf('.png') >= 0) return 'image/png';
  if (s.indexOf('.webp') >= 0) return 'image/webp';
  return 'image/jpeg';
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_IDENTITY', '未取得调用者身份');

  // 探活模式：只做一次纯文本模型调用，用于确认模型通道是否可用
  if (event && event.probe === true) {
    const t0 = Date.now();
    try {
      const model = ai.createModel(MODEL_GROUP);
      const r = await model.generateText(
        {
          model: VISION_MODEL,
          messages: [{ role: 'user', content: '回复两个字：正常' }]
        },
        { timeout: AI_TIMEOUT }
      );
      return {
        ok: true,
        probe: true,
        ms: Date.now() - t0,
        text: (r && r.text) || '',
        usage: (r && r.usage) || null
      };
    } catch (e) {
      return fail('PROBE_FAILED', '模型探活失败', {
        ms: Date.now() - t0,
        detail: String((e && (e.message || e.errMsg)) || e).slice(0, 300),
        code: String((e && (e.code || e.errCode)) || '')
      });
    }
  }

  const fileID = event && event.fileID;
  if (!fileID) return fail('NO_FILE', '缺少图片 fileID');

  let image;
  const tDownload = Date.now();
  try {
    image = await downloadAsBase64(fileID);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === 'EMPTY_FILE') return fail('EMPTY_FILE', '图片内容为空，请重新选择');
    if (msg === 'TOO_LARGE') return fail('TOO_LARGE', '图片过大，请压缩后重试');
    console.error('[recognizeTimetable] 下载失败', e);
    return fail('DOWNLOAD_FAILED', '图片下载失败，请重试');
  }
  console.log('[recognizeTimetable] 下载耗时', Date.now() - tDownload, 'ms, bytes=', image.bytes);

  const tModel = Date.now();
  try {
    const model = ai.createModel(MODEL_GROUP);
    const result = await model.generateText(
      {
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请识别这张课表，按要求的 JSON 格式输出。' },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeOf(fileID)};base64,${image.base64}` }
              }
            ]
          }
        ]
      },
      { timeout: AI_TIMEOUT }
    );

    // 只回传文本，JSON 解析与 Schema 校验统一放在客户端管线里做
    const raw = (result && result.text) || '';
    console.log('[recognizeTimetable] 模型耗时', Date.now() - tModel, 'ms, rawLen=', raw.length);
    if (!raw) return fail('EMPTY_RESULT', '模型没有返回内容，请换一张更清晰的图片');

    return {
      ok: true,
      raw,
      usage: (result && result.usage) || null,
      imageBytes: image.bytes,
      ms: { download: tModel - tDownload, model: Date.now() - tModel }
    };
  } catch (e) {
    console.error('[recognizeTimetable] 模型调用失败', e);
    // 回传错误摘要：模型/网关报错时便于排查（不含任何凭据，只保留类型与消息）
    const detail = String((e && (e.message || e.errMsg)) || e).slice(0, 300);
    const code = (e && (e.code || e.errCode)) || '';
    return fail('MODEL_ERROR', '图片识别服务暂时不可用，可以改用手工录入', {
      detail,
      code: String(code),
      ms: Date.now() - tModel
    });
  }
};
