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
function extractJSONLike(raw, open, close) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  // 0) 剥掉推理模型的外层标签（t1 系列会输出 <answer>…</answer>，
  //    甚至把思考过程写在标签外面）。优先取 answer 内的内容，
  //    避免思维过程中出现的 [ ] 干扰后面的切片兜底。
  const ans = text.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (ans) text = ans[1].trim();

  // 1) 直接尝试
  const direct = tryParse(text);
  if (direct !== null) return direct;

  // 2) 剥掉 markdown 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }

  // 3) 截取第一个 open 到最后一个 close
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start !== -1 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced !== null) return sliced;
  }

  return null;
}

/** 抽取 JSON 数组（课程列表用） */
function extractJSON(raw) {
  return extractJSONLike(raw, '[', ']');
}

/** 抽取 JSON 对象（版式分析结果用） */
function extractJSONObject(raw) {
  const obj = extractJSONLike(raw, '{', '}');
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
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
/**
 * 宽容取字段：模型偶尔会自创字段名（实测 t1-vision 会输出 day / period /
 * courseName / classroom），这里按优先级依次尝试，命中即用。
 * 目标字段名永远排第一，别名只作为兜底，避免影响正常路径。
 */
function pick(raw, keys) {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
  }
  return undefined;
}

/**
 * 中文星期 → 数字。模型有时会把 1 写成「周一」「星期一」。
 * 取不到返回 undefined（区别于 0）。
 */
function dayFromText(v) {
  if (v == null) return undefined;
  const s = String(v);
  const n = toInt(s);
  if (n != null) return n;
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  for (let i = 0; i < names.length; i++) {
    if (s.indexOf(names[i]) >= 0) return i + 1;
  }
  if (s.indexOf('天') >= 0) return 7;
  return undefined;
}

/** 从模型原始输出里抽出「课程名」，兼容 name / courseName / course / title */
function nameOf(raw) {
  const v = pick(raw, ['name', 'courseName', 'course_name', 'course', 'title', 'subject']);
  return v == null ? '' : String(v).trim();
}

/**
 * 单条课程记录的校验与规整。
 * 字段名以客户端 Schema 为准，但对模型的常见别名做兜底识别（见 pick/dayFromText）。
 *
 * @param {object} raw 模型返回的单条记录
 * @param {number} totalSlots 当前总大节数
 * @param {string} [fallbackWeeks] 整表统一周次（版式规则得出），仅用于该条没写周次时
 */
function normalizeItem(raw, totalSlots, fallbackWeeks) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const missing = [];

  // 课程名：空字符串 / null / 非字符串都算缺失
  const name = nameOf(raw);
  if (!name) missing.push('name');

  // 星期：必须是 1-7 的整数（兼容「周一」这类写法）
  let day = dayFromText(pick(raw, ['day_of_week', 'dayOfWeek', 'day', 'weekday', 'week_day']));
  if (day == null || day < DAY_MIN || day > DAY_MAX) {
    day = 0;
    missing.push('day_of_week');
  }

  // 开始节次：必须落在 1..totalSlots（兼容 period / startSlot / start 等）
  let start = toInt(pick(raw, ['start_slot', 'startSlot', 'start', 'period', 'slot', 'section']));
  if (start == null || start < 1 || start > totalSlots) {
    start = 0;
    missing.push('start_slot');
  }

  // 连续节数：默认 1；与 start 相加不得越界
  let count = toInt(pick(raw, ['slot_count', 'slotCount', 'count', 'span', 'length', 'duration']));
  if (count == null || count < 1) count = 1;
  if (start && start + count - 1 > totalSlots) {
    count = totalSlots - start + 1;
  }

  // 周次：模型可能给 null，也可能给不合法的写法。
  // 该条确实没写周次时，若版式规则给出了「整表统一周次」（标题/图例写明），
  // 则用它兜底 —— 这不是猜测，而是把图上明确写着、只是没写在格子里的规则套上。
  const weeksRaw = pick(raw, ['weeks', 'week', 'weekRange', 'week_range']);
  let weeks = weeksRaw == null ? '' : String(weeksRaw).trim();
  if (!weeks || !parseWeeks(weeks).length) {
    if (fallbackWeeks && parseWeeks(fallbackWeeks).length) {
      weeks = fallbackWeeks;
    } else {
      weeks = '';
      missing.push('weeks');
    }
  }

  // 完全没有用的记录直接丢弃（既无课程名，也无任何位置信息）
  if (!name && !day && !start) return null;

  const teacher = pick(raw, ['teacher', 'teacherName', 'instructor']);
  const location = pick(raw, ['location', 'classroom', 'room', 'place', 'address']);

  return {
    name,
    day_of_week: day,
    start_slot: start,
    slot_count: count,
    teacher: teacher == null ? '' : String(teacher).trim(),
    location: location == null ? '' : String(location).trim(),
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
 * @param {*} parsed 模型返回的数组
 * @param {number} totalSlots 总大节数
 * @param {object} [options] { fallbackWeeks } 整表统一周次，用于给没写周次的课程兜底
 * @returns {{ list: object[], rejected: number }}
 */
function normalizeList(parsed, totalSlots, options) {
  if (!Array.isArray(parsed)) return { list: [], rejected: 0 };

  const fallbackWeeks = (options && options.fallbackWeeks) || '';
  const list = [];
  let rejected = 0;
  for (const raw of parsed) {
    const item = normalizeItem(raw, totalSlots, fallbackWeeks);
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
  NO_COURSE: 'NO_COURSE',
  // 图片识别专属
  NO_FILE: 'NO_FILE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT'
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
    case PARSE_ERROR.NO_FILE:
      return '没有拿到图片，请重新选择或拍摄';
    case PARSE_ERROR.UPLOAD_FAILED:
      return '图片上传失败，请检查网络后重试';
    case PARSE_ERROR.IMAGE_TOO_LARGE:
      return '图片过大，请换一张更小或更清晰的图片';
    case PARSE_ERROR.MODEL_TIMEOUT:
      return '识别超时了，请保持小程序在前台并重试';
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

function fail(code, extra) {
  // extra：可选的诊断附加信息（detail / code 等），供调用方打日志或做更细的
  // 分支处理。不参与用户可见文案，避免把服务端技术细节抖到界面上。
  return Object.assign(
    { ok: false, list: [], code, message: messageOf(code) },
    extra || {}
  );
}

/* ================= 版式规则（P2 两阶段识别） ================= */

/**
 * 版式来源 → 给用户看的一句话。用户反馈「识别不到周数」，很多时候是周次根本
 * 不在格子里（只写在标题或按周次分块），把来源讲明白，用户就知道该核对哪里。
 */
const WEEKS_SOURCE_TEXT = {
  cell: '周次写在课程格子里',
  header: '周次写在标题/表头（整表统一）',
  legend: '周次写在图例说明里',
  block: '表格按周次分块',
  color: '用颜色区分周次',
  none: '未发现周次信息'
};

/**
 * 解析云函数阶段一返回的版式规则。
 * 宽容处理：模型可能裹代码块或加前言，用 extractJSONObject 兜底。
 *
 * @param {string} layoutRaw 版式分析原始文本
 * @returns {object|null} 结构化版式信息；无法解析时返回 null
 */
function parseLayout(layoutRaw) {
  const obj = extractJSONObject(layoutRaw);
  if (!obj) return null;

  const source = String(obj.weeks_source || '').trim().toLowerCase();
  const rawMapping = Array.isArray(obj.weeks_mapping) ? obj.weeks_mapping : [];
  const mapping = rawMapping
    .filter((m) => m && m.weeks != null && String(m.weeks).trim())
    .map((m) => ({
      scope: String(m.scope == null ? '' : m.scope).trim(),
      weeks: String(m.weeks).trim()
    }));

  return {
    title: String(obj.title == null ? '' : obj.title).trim(),
    axisX: Array.isArray(obj.axis_x) ? obj.axis_x.slice(0, 10).map(String) : [],
    axisY: Array.isArray(obj.axis_y) ? obj.axis_y.slice(0, 15).map(String) : [],
    weeksSource: WEEKS_SOURCE_TEXT[source] ? source : '',
    weeksSourceText: WEEKS_SOURCE_TEXT[source] || '',
    weeksEvidence: String(obj.weeks_evidence == null ? '' : obj.weeks_evidence).trim(),
    mapping,
    slotRule: String(obj.slot_rule == null ? '' : obj.slot_rule).trim(),
    cellRule: String(obj.cell_rule == null ? '' : obj.cell_rule).trim(),
    multiCourseRule: String(obj.multi_course_rule == null ? '' : obj.multi_course_rule).trim(),
    notes: String(obj.notes == null ? '' : obj.notes).trim()
  };
}

/**
 * 从版式规则里取出「整表统一周次」，用于给没写周次的课程兜底。
 *
 * 只在**确凿**的情况下返回：映射表里只有一条，且来源是「整表统一」性质的
 * （标题/图例/颜色），或者是明显表示全局的范围词。分块周次（左表 1-8 周、
 * 右表 9-16 周）绝不能整体套用，那种情况必须由模型逐条判断是哪一门。
 *
 * @returns {string} 周次规则原文；不适用时返回 ''
 */
function globalWeeksOf(layout) {
  if (!layout || layout.mapping.length !== 1) return '';
  const only = layout.mapping[0];
  const src = layout.weeksSource;
  const globalScope = /整个|整张|全表|全图|所有|全部|均|统一|每一?门/.test(only.scope);
  const srcIsGlobal = src === 'header' || src === 'legend' || src === 'color';
  if (!srcIsGlobal && !globalScope) return '';
  // 必须是解析得出的合法周次，避免把「每周」这类无法解析的描述塞进去
  return parseWeeks(only.weeks).length ? only.weeks : '';
}

/* ================= 图片识别入口（P2） ================= */

// 图片压缩档位：长边 1600px 内（README 既定要求）。
// 阶梯下降，尽量保住清晰度的同时压进云函数能处理的体积。
const COMPRESS_PLANS = [
  { quality: 80 },
  { quality: 60 },
  { quality: 40 }
];

// 图片长边上限（px）—— README 既定：压缩至长边 1600px 内
const IMAGE_MAX_EDGE = 1600;

/**
 * 压缩图片。wx.compressImage 只接受 quality，尺寸压缩需要传 compressedWidth，
 * 这里按「长边不超过 1600」计算目标宽度。
 *
 * @param {string} src 本地临时路径
 * @returns {Promise<string>} 压缩后的临时路径（失败时原样返回 src）
 */
function compressImage(src) {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || !wx.compressImage) {
      resolve(src);
      return;
    }
    // 先取原图尺寸，再算需要压到多宽
    wx.getImageInfo({
      src,
      success(info) {
        const longEdge = Math.max(info.width || 0, info.height || 0);
        const scale = longEdge > IMAGE_MAX_EDGE ? IMAGE_MAX_EDGE / longEdge : 1;
        const width = Math.round((info.width || 0) * scale);

        let idx = 0;
        const attempt = () => {
          const plan = COMPRESS_PLANS[idx];
          wx.compressImage({
            src,
            quality: plan.quality,
            compressedWidth: scale < 1 ? width : undefined,
            success: (res) => resolve(res.tempFilePath || src),
            fail: () => {
              idx += 1;
              if (idx < COMPRESS_PLANS.length) attempt();
              else resolve(src);   // 全部失败就用原图，让云函数侧去兜底
            }
          });
        };
        attempt();
      },
      fail: () => resolve(src)
    });
  });
}

/**
 * 上传图片到云存储。
 * 路径按 openid 前缀隔离，且**不落库**——图片仅用于本次识别，
 * 识别完成后由调用方（或用户的清理动作）删除，符合 README 的隐私约定。
 */
function uploadImage(filePath) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.uploadFile) {
      reject(new Error('UPLOAD_UNAVAILABLE'));
      return;
    }
    const ext = (filePath.match(/\.(\w+)$/) || [, 'jpg'])[1];
    const cloudPath = `timetable-ocr/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: (err) => reject(err)
    });
  });
}

/**
 * 删除云存储文件。识别结束后清理，失败不抛错（清理是尽力而为，
 * 不能因为清理失败就让用户看到报错）。
 */
function removeImage(fileID) {
  return new Promise((resolve) => {
    if (!fileID || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.deleteFile) {
      resolve(false);
      return;
    }
    wx.cloud.deleteFile({
      fileList: [fileID],
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

/**
 * 图片 → 结构化课程（P2 主入口）
 *
 * 完整链路：压缩 → 上传云存储 → 调 recognizeTimetable 云函数 → 复用同一套
 * Schema 校验 → 返回与 parseCourses 完全同构的结果。页面可直接复用预览页。
 *
 * @param {string} filePath 本地图片临时路径（来自 wx.chooseMedia）
 * @param {object} [options]
 * @param {Function} [options.uploader] 依赖注入：图片上传器 (localPath) → fileID（测试用）
 * @param {Function} [options.callFunction] 依赖注入：云函数调用器（测试用）
 * @param {Function} [options.onProgress] 阶段进度回调 (stageText)
 * @param {boolean} [options.keepImage] 识别后是否保留云存储图片（默认删除）
 * @returns {Promise<{ok, list, code, message}>}
 */
async function parseCoursesFromImage(filePath, options = {}) {
  if (!filePath) return fail(PARSE_ERROR.NO_FILE);

  // 注入式调用器（测试/自定义通道）直接放行；默认通道需探测云能力
  const cloudCall = options.callFunction || (hasCloudChannel() ? defaultCallFunction : null);
  // 无云函数通道时提前短路，避免白跑一次压缩 + 上传
  if (!cloudCall) return fail(PARSE_ERROR.AI_UNAVAILABLE);

  const uploader = options.uploader || uploadImage;

  const report = (text) => {
    if (typeof options.onProgress !== 'function') return;
    try {
      options.onProgress(text);
    } catch (e) {
      console.warn('[ai] onProgress 回调异常', e);
    }
  };

  let fileID = null;
  try {
    // 1) 压缩（长边 1600px 内）
    report('正在压缩图片…');
    const compressed = await compressImage(filePath);

    // 2) 上传云存储
    report('正在上传图片…');
    try {
      fileID = await uploader(compressed);
    } catch (e) {
      console.error('[ai] 图片上传失败', e);
      return fail(PARSE_ERROR.UPLOAD_FAILED);
    }

    // 3) 调云函数（服务端调视觉模型）
    report('正在识别课表…');
    let res;
    const tCall = Date.now();
    try {
      res = await cloudCall(fileID);
    } catch (e) {
      // 走到这里通常是「客户端先断开」：视觉模型单张课表要 45 秒以上，
      // 若用户切后台、息屏或网络抖动，callFunction 会先抛错，而云函数其实
      // 还在跑。把完整的 errMsg / errCode 打出来，否则现场只剩一句
      // 「AI 服务暂时不可用」，无从判断是超时、断网还是权限问题。
      const errMsg = String((e && (e.errMsg || e.message)) || e);
      const errCode = String((e && (e.errCode || e.code)) || '');
      console.error('[ai] 云函数调用失败', {
        errCode,
        errMsg,
        ms: Date.now() - tCall,
        fileID
      });
      // 超时/中断单独给文案，提示用户重试而不是以为功能坏了
      if (/timeout|timed?\s*out|ESOCKETTIMEDOUT|INTERRUPT/i.test(errMsg + errCode)) {
        return fail(PARSE_ERROR.MODEL_TIMEOUT);
      }
      return fail(PARSE_ERROR.MODEL_ERROR);
    }

    if (!res || res.ok !== true) {
      const code = (res && res.error) || '';
      // 关键：服务端 catch 已回传 detail / code / ms，这里必须一起打出来。
      // 之前只打 code + message，排查时 console 里看不到真实原因（如模型
      // 403、格式 400、超时），等于把最有价值的一行日志丢了。
      console.warn('[ai] 识别服务返回失败', {
        code,
        message: res && res.message,
        detail: res && res.detail,
        serverCode: res && res.code,
        serverMs: res && res.ms
      });
      if (code === 'TOO_LARGE') return fail(PARSE_ERROR.IMAGE_TOO_LARGE);
      if (code === 'MODEL_ERROR') {
        // 服务端把模型层的真实错误放在了 detail，带上便于快速定位。
        // 注意用 serverDetail/serverCode 而非 detail/code —— fail() 内部已有
        // code 字段（错误码本身），同名会被覆盖掉。
        return fail(PARSE_ERROR.MODEL_ERROR, {
          serverDetail: (res && res.detail) || '',
          serverCode: (res && res.code) || ''
        });
      }
      // EMPTY_FILE / DOWNLOAD_FAILED / EMPTY_RESULT 等给更具指向性的文案
      return fail(PARSE_ERROR.MODEL_ERROR, {
        serverDetail: (res && (res.message || res.error)) || '',
        serverCode: code
      });
    }

    // 4) 复用与文本解析完全相同的抽取 + 校验逻辑
    const parsed = extractJSON(res.raw);
    if (parsed === null) {
      console.warn('[ai] 图片识别输出无法解析为 JSON', res.raw);
      return fail(PARSE_ERROR.BAD_OUTPUT);
    }

    // 5) 版式规则：既用于界面展示「周次写在哪」，也用于给没写周次的课程兜底
    const layout = parseLayout(res.layout);
    const fallbackWeeks = globalWeeksOf(layout);
    if (layout) {
      console.log('[ai] 课表版式规则', {
        weeksSource: layout.weeksSource,
        weeksEvidence: layout.weeksEvidence,
        mapping: layout.mapping,
        fallbackWeeks
      });
    } else if (res.layout) {
      console.warn('[ai] 版式规则无法解析', String(res.layout).slice(0, 300));
    }

    const { list } = normalizeList(parsed, safeTotalSlots(), { fallbackWeeks });
    if (!list.length) return fail(PARSE_ERROR.NO_COURSE);

    return { ok: true, list, code: '', message: '', layout };
  } finally {
    // 5) 清理云存储图片（默认行为）。隐私约定：图片仅用于本次识别。
    if (fileID && !options.keepImage) {
      await removeImage(fileID);
    }
  }
}

/**
 * 默认云函数调用器：调 recognizeTimetable。
 */
/** 当前环境是否具备「云存储 + 云函数」通道（图片识别必需） */
function hasCloudChannel() {
  return typeof wx !== 'undefined' && !!(wx.cloud && wx.cloud.callFunction);
}

function defaultCallFunction(fileID) {
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return null;
  return wx.cloud.callFunction({
    name: 'recognizeTimetable',
    data: { fileID },
    // 注意：callFunction 的客户端等待有 **60 秒硬上限**（微信官方明确该接口
    // 对云函数超时的限制上限为 60 秒，控制台把云函数调到 300 秒也突破不了，
    // 超时报 -501002 / ESOCKETTIMEDOUT）。所以这里设 55000 只是「尽量用满」，
    // 写更大没有意义。真正让识别稳定的是服务端换了快思考模型
    // （hy-vision-2.0-instruct 实测 ~6 秒，旧 t1-vision 要 45 秒以上）。
    config: { timeout: 55000 }
  }).then((r) => (r && r.result) || null);
}

module.exports = {
  parseCourses,
  parseCoursesFromImage,
  isAIAvailable,
  preprocess,
  extractJSON,
  extractJSONObject,
  normalizeItem,
  normalizeList,
  compressImage,
  removeImage,
  messageOf,
  PARSE_ERROR,
  DEFAULT_MODEL,
  IMAGE_MAX_EDGE,
  SYSTEM_PROMPT,
  // 两阶段识别（P2）：版式规则解析与「整表统一周次」兜底
  parseLayout,
  globalWeeksOf
};
