/**
 * api/ai.js —— AI 统一解析管线
 *
 * 设计要点（P1 / M4）：
 *   对话建表与图片识别**不是两个功能，而是同一条管线的两种输入形态**，
 *   在「结构化课程 JSON」这一步汇合，之后共用同一套校验与预览确认页。
 *
 *   管线：预处理 → 调用大模型（流式）→ Schema 校验 → 结构化课程 JSON
 *
 * 为什么放 api/ 而不是页面里：
 *   1. 页面只关心「拿到结构化课程」，不关心模型细节；
 *   2. P2 图片识别可直接复用同一条管线，只换输入形态；
 *   3. 依赖可注入（modelProvider），测试能塞假模型，不消耗真实 Token。
 *
 * 能力降级：
 *   wx.cloud.extend.AI 需要基础库 ≥ 3.15.1。旧版微信上该能力不存在，
 *   由 isAIAvailable() 探测，调用方据此回退本地规则解析（不能报错收场）。
 */

const { parseWeeks } = require('../utils/week');
const { getTotalSlots } = require('../utils/schedule');

// 免费体验模型。正式上线要换售卖模型时改这里即可（如 hy3 / deepseek-v4-flash）。
const DEFAULT_MODEL = 'hy3';
// 模型供应商标识（云开发售卖的模型统一走 cloudbase）
const PROVIDER = 'cloudbase';

/** 字段合法性：星期 1-7、节次 1..totalSlots、节数 1..totalSlots */
const DAY_MIN = 1;
const DAY_MAX = 7;

/**
 * 系统提示词：把模型的输出空间压缩到「固定字段的 JSON 数组」。
 * 明确要求「不认识就返回 null，不要猜」——猜测性填表比留空更糟，
 * 会把用户原本正确的课表改错，而且用户很难发现。
 */
const SYSTEM_PROMPT = [
  '你是一个课表解析助手。用户会用自然语言描述课程，你要把它解析成结构化 JSON。',
  '',
  '严格输出一个 JSON 数组，不要输出任何解释文字，不要加 markdown 代码块标记。',
  '数组中每个元素代表一门课，字段固定为：',
  '{',
  '  "name": "课程名，字符串",',
  '  "day_of_week": "星期几，数字 1-7，1 表示周一",',
  '  "start_slot": "开始节次，数字",',
  '  "slot_count": "连续节数，数字，默认 1",',
  '  "teacher": "教师，字符串",',
  '  "location": "上课地点，字符串",',
  '  "weeks": "周次规则，字符串，如 1-16 或 1-16 单 或 3,5,7"',
  '}',
  '',
  '规则：',
  '1. 只填充用户在原文中明确提到的信息。无法确定的字段一律填 null，绝对不要猜测或编造。',
  '2. 中文数字要转成阿拉伯数字，例如「三四节」表示开始节次 3、连续节数 2。',
  '3. 「周二」「星期天」这类表述要转成 day_of_week 数字，周日和周日都算 7。',
  '4. 周次只说「1-16周」时 weeks 填 "1-16"；说「单周」时填 "1-16 单"。完全没提周次时 weeks 填 null。',
  '5. slot_count 在用户只说了一个节次时填 1，说了一个区间或连续节次时按实际跨度填。',
  '6. 如果整段话里没有任何可识别的课程，输出空数组 []。'
].join('\n');

/* ================= 能力探测 ================= */

/**
 * 当前环境是否具备小程序内调用大模型的能力。
 * 基础库 < 3.15.1 时 wx.cloud.extend.AI 不存在，直接返回 false，
 * 由调用方回退本地规则解析。
 */
function getAIClient() {
  if (typeof wx === 'undefined') return null;
  if (!wx.cloud || !wx.cloud.extend || !wx.cloud.extend.AI) return null;
  return wx.cloud.extend.AI;
}

function isAIAvailable() {
  return !!getAIClient();
}

/* ================= 输入预处理 ================= */

/**
 * 预处理：清掉零宽字符、统一全角标点、压掉多余空白。
 * 模型对脏输入很敏感（比如全角逗号会让它把一句话拆成两门课）。
 */
function preprocess(text) {
  return String(text == null ? '' : text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[；]/g, ';')
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 从模型返回的文本里抽出 JSON 数组。
 * 模型即使被要求「只输出 JSON」，也常会裹上 ```json 代码块或加一句前言，
 * 所以这里做兜底提取，而不是直接 JSON.parse 整个响应。
 */
function extractJSON(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  // 1) 直接尝试
  const direct = tryParse(text);
  if (direct !== null) return direct;

  // 2) 剥掉 markdown 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }

  // 3) 截取第一个 [ 到最后一个 ]
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced !== null) return sliced;
  }

  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/* ================= Schema 校验 ================= */

/**
 * 把模型吐出的单个对象规整成合法课程记录。
 *
 * 关键原则：**不猜**。无法确定的字段留空并记入 missing_fields，
 * 让用户在预览页补齐 —— 猜错会让用户根本发现不了问题。
 *
 * @param {object} raw 模型返回的单个元素
 * @param {number} totalSlots 当前总大节数，用于节次越界裁剪
 * @returns {object|null} 规整后的课程；完全不可用时返回 null
 */
function normalizeItem(raw, totalSlots) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const missing = [];

  // 课程名：空字符串 / null / 非字符串都算缺失
  const name = raw.name == null ? '' : String(raw.name).trim();
  if (!name) missing.push('name');

  // 星期：必须是 1-7 的整数
  let day = toInt(raw.day_of_week);
  if (day == null || day < DAY_MIN || day > DAY_MAX) {
    day = 0;
    missing.push('day_of_week');
  }

  // 开始节次：必须落在 1..totalSlots
  let start = toInt(raw.start_slot);
  if (start == null || start < 1 || start > totalSlots) {
    start = 0;
    missing.push('start_slot');
  }

  // 连续节数：默认 1；与 start 相加不得越界
  let count = toInt(raw.slot_count);
  if (count == null || count < 1) count = 1;
  if (start && start + count - 1 > totalSlots) {
    count = totalSlots - start + 1;
  }

  // 周次：模型可能给 null，也可能给不合法的写法
  let weeks = raw.weeks == null ? '' : String(raw.weeks).trim();
  if (!weeks || !parseWeeks(weeks).length) {
    weeks = '';
    missing.push('weeks');
  }

  // 完全没有用的记录直接丢弃（既无课程名，也无任何位置信息）
  if (!name && !day && !start) return null;

  return {
    name,
    day_of_week: day,
    start_slot: start,
    slot_count: count,
    teacher: raw.teacher == null ? '' : String(raw.teacher).trim(),
    location: raw.location == null ? '' : String(raw.location).trim(),
    weeks: weeks || '1-16',   // 展示兜底；missing_fields 里仍然标记了 weeks
    missing_fields: missing
  };
}

/**
 * 宽松取整：接受数字、数字字符串、以及 "3节" 这类带单位的值。
 * 取不到整数返回 null（区别于 0，0 是合法的「没填」标记之外的无效值）。
 */
function toInt(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const m = String(v).match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * 校验并规整模型返回的整体结果。
 * @returns {{ list: object[], rejected: number }}
 */
function normalizeList(parsed, totalSlots) {
  if (!Array.isArray(parsed)) return { list: [], rejected: 0 };

  const list = [];
  let rejected = 0;
  for (const raw of parsed) {
    const item = normalizeItem(raw, totalSlots);
    if (item) list.push(item);
    else rejected += 1;
  }
  return { list, rejected };
}

/* ================= 解析失败原因 ================= */

const PARSE_ERROR = {
  EMPTY_INPUT: 'EMPTY_INPUT',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  MODEL_ERROR: 'MODEL_ERROR',
  BAD_OUTPUT: 'BAD_OUTPUT',
  NO_COURSE: 'NO_COURSE'
};

/**
 * 把错误码翻译成可以直接展示给用户的话。
 * 三层容错的文案都在这里，页面只管取用。
 */
function messageOf(code) {
  switch (code) {
    case PARSE_ERROR.EMPTY_INPUT:
      return '请先说一句你的课表';
    case PARSE_ERROR.AI_UNAVAILABLE:
      return '当前微信版本不支持 AI 解析，已切换为本地识别';
    case PARSE_ERROR.MODEL_ERROR:
      return 'AI 服务暂时不可用，可以改用下面的手工录入';
    case PARSE_ERROR.BAD_OUTPUT:
      return 'AI 返回的内容看不懂，可以换个说法再试，或改用手工录入';
    case PARSE_ERROR.NO_COURSE:
      return '没太看懂，可以说得更具体一点，比如「周一三四节高数，王老师，A301」';
    default:
      return '解析失败，可以改用下面的手工录入';
  }
}

/* ================= 主入口 ================= */

/**
 * 统一解析入口：自然语言 → 结构化课程数组
 *
 * @param {string} text 用户输入的自然语言
 * @param {object} [options]
 * @param {Function} [options.onProgress] 流式进度回调 (deltaText, fullText)
 * @param {object}   [options.modelProvider] 依赖注入：{ streamText } 形态的假模型（测试用）
 * @param {string}   [options.model] 模型标识，默认 hy3（免费体验模型）
 * @returns {Promise<{ ok: boolean, list: object[], code: string, message: string }>}
 */
async function parseCourses(text, options = {}) {
  const cleaned = preprocess(text);

  if (!cleaned) {
    return fail(PARSE_ERROR.EMPTY_INPUT);
  }

  const provider = options.modelProvider || getAIClient();

  if (!provider || typeof provider.createModel !== 'function') {
    // 能力不具备：交由调用方回退本地规则解析
    return fail(PARSE_ERROR.AI_UNAVAILABLE);
  }

  const totalSlots = safeTotalSlots();
  let raw = '';

  try {
    const model = provider.createModel(PROVIDER);
    const res = await model.streamText({
      data: {
        model: options.model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: cleaned }
        ]
      }
    });

    // 优先用 textStream 拼增量文本；顺带把进度抛给 UI 做打字机效果
    if (res && res.textStream) {
      for await (const chunk of res.textStream) {
        raw += chunk;
        if (typeof options.onProgress === 'function') {
          try {
            options.onProgress(chunk, raw);
          } catch (e) {
            // 进度回调是纯粹的表现层，它出错不能拖垮解析
            console.warn('[ai] onProgress 回调异常', e);
          }
        }
      }
    } else if (res && typeof res === 'string') {
      raw = res;
    }
  } catch (err) {
    console.error('[ai] 模型调用失败', err);
    return fail(PARSE_ERROR.MODEL_ERROR);
  }

  const parsed = extractJSON(raw);
  if (parsed === null) {
    console.warn('[ai] 模型输出无法解析为 JSON', raw);
    return fail(PARSE_ERROR.BAD_OUTPUT);
  }

  const { list } = normalizeList(parsed, totalSlots);
  if (!list.length) {
    return fail(PARSE_ERROR.NO_COURSE);
  }

  return { ok: true, list, code: '', message: '' };
}

/** 总大节数；作息配置异常时兜底 6，避免校验直接把所有结果判越界 */
function safeTotalSlots() {
  try {
    const n = getTotalSlots();
    return Number(n) > 0 ? Number(n) : 6;
  } catch (e) {
    return 6;
  }
}

function fail(code) {
  return { ok: false, list: [], code, message: messageOf(code) };
}

module.exports = {
  parseCourses,
  isAIAvailable,
  preprocess,
  extractJSON,
  normalizeItem,
  normalizeList,
  messageOf,
  PARSE_ERROR,
  DEFAULT_MODEL,
  SYSTEM_PROMPT
};
