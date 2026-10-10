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
 *   { fileID: string }                  → { ok, raw, layout, model, ms }
 *   { fileID, layout: false }           → 跳过版式分析，只跑一次提取（省时省钱）
 *   { probe: true }                     → 模型通道探活
 *   { model: '...' }                    → 临时指定视觉模型（A/B 对比）
 *   错误统一返回 { ok: false, error, message, detail, code }
 *
 * 两阶段设计（2026-10-10 新增，解决「识别不到周次」）：
 *   阶段一 版式分析：只让模型读懂课表的「阅读规则」—— 尤其是**周次信息写在
 *   哪里**（格子内 / 标题 / 图例 / 按周次分块 / 用颜色区分）。因为真实课表的
 *   周次常常不在格子里，而原提示词只说了「weeks 是个字符串字段」，模型不知道
 *   该去哪找，于是普遍返回 null。
 *   阶段二 课程提取：把阶段一得出的版式规则**注入提示词**，再让模型按规则提取
 *   课程与周次。规则先行，等于给模型一张「寻宝图」。
 *
 * 两阶段的代价：多一次视觉调用（实测约 +3~5 秒），总计仍在 15 秒内，
 * 远低于 callFunction 的 60 秒硬上限。版式分析失败时不阻断主流程（降级为
 * 单阶段提取 + layoutError 标记）。
 *
 * 注意：本函数**不**解析课程 JSON。解析与校验统一由客户端 `api/ai.js` 完成，
 * 避免同一套逻辑在两端各写一遍。云函数只保证「拿到模型的完整文本输出」，
 * 外加版式分析的原始文本。
 */
const cloud = require('wx-server-sdk');

// AI 请求默认超时只有 15 秒 —— 视觉模型读一张课表要几十秒，15 秒必然
// ESOCKETTIMEDOUT。这里放宽到 50 秒：真正的天花板不是云函数（可设 300 秒），
// 而是**客户端 wx.cloud.callFunction 的 60 秒硬上限**（官方明确：该接口对云
// 函数超时的限制上限为 60 秒，控制台调大也突破不了，超时报
// -501002 / ESOCKETTIMEDOUT）。因此服务端计算必须留在 60 秒内，
// 给到 50 秒留 10 秒给下载与回传。
// 注意：wx-server-sdk 需 4.0.1+ 才有 cloud.ai()。
const AI_TIMEOUT = 50000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: AI_TIMEOUT });

const ai = cloud.ai();

const MODEL_GROUP = 'cloudbase';

/**
 * 视觉模型选择 —— 这是踩过坑的关键决策：
 *
 * 候选（CloudBase 可用模型列表 https://docs.cloudbase.net/ai/available-models）：
 *   hy-vision-2.0-instruct      图生文 ·「快思考」  ← 现在用这个
 *   hunyuan-t1-vision-20250916  图生文 ·「深度思考」
 *   hunyuan-turbos-vision-video-20250728  视频理解（图片 messages 会 400）
 *
 * 为什么弃用 t1-vision：它是深度思考（thinking）模型，实测单张课表要 44~60 秒，
 * 直接顶到 callFunction 的 60 秒硬上限。用户实测表现就是「AI 服务暂时不可用」
 * （客户端先超时断开，catch 到后被归一化成 MODEL_ERROR）。
 * hy-vision-2.0-instruct 是官方标注的「快思考」图生文模型，同为 ¥3/¥9 每百万
 * token，速度显著更快，才是这个场景正确的基础模型。
 *
 * 可用 event.model 临时指定模型做 A/B 对比，不传则用默认值。
 */
const DEFAULT_VISION_MODEL = 'hy-vision-2.0-instruct';
const FALLBACK_VISION_MODEL = 'hunyuan-t1-vision-20250916';

// 单张图片大小上限（字节）：超过直接拒绝，避免把超大图喂给模型浪费额度
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 两次模型调用的**总时间预算**（毫秒）。
 *
 * 两阶段设计后，最坏情况是「版式分析 + 课程提取」各跑满 50 秒 = 100 秒，
 * 直接撞破云函数 60 秒的限制（客户端也是 60 秒硬上限）。所以必须有一个全局
 * 预算：每次调用前算剩余额度，第二次调用只允许用剩下的时间。留 15 秒给
 * 图片下载、回传与冷启动。
 */
const TOTAL_MODEL_BUDGET = 45000;

/** 至少给第二次调用留这么久，否则不划算 —— 省下的时间不够跑完提取 */
const MIN_CALL_BUDGET = 4000;

const fail = (error, message, extra) =>
  Object.assign({ ok: false, error, message: message || '' }, extra || {});

/**
 * 阶段一提示词：课表**版式分析**（不提取课程）。
 *
 * 为什么单独做这一步：真实课表的周次信息位置极其多变 —— 有的写在每个格子里，
 * 有的只写在标题（"第1-16周课表"），有的按周次把表格切成好几块（左表 1-8 周、
 * 右表 9-16 周），有的用底色 + 图例区分单双周。原提示词只交代了「weeks 是字符串
 * 字段」，模型根本没有「去哪找周次」的线索，于是大面积返回 null —— 用户反馈的
 * 「识别不到周数」就是这么来的。
 *
 * 这一步先把版式的「阅读规则」抠出来（尤其是 weeks_source 与 weeks_evidence），
 * 下一步再把它注入提取提示词。规则先行，模型才知道该看哪里。
 */
const LAYOUT_PROMPT = [
  '你是一个课表版式分析助手。用户会给你一张课表截图或照片。',
  '这一步**不要提取课程**，只做一件事：读懂这张课表的「阅读规则」，供下一步提取课程使用。',
  '',
  '请输出一个 JSON 对象，字段名严格使用下面这些英文名，禁止改名、禁止增加字段：',
  '  weeks_source     周次信息出现在哪里，只能取以下值之一：',
  '                     "cell"   写在每个课程格子里（格子里有"1-16周"这类文字）',
  '                     "header" 只写在标题或表头（如标题是"第1-16周课表"）',
  '                     "legend" 写在图例/说明文字里（如底部"浅蓝=1-16周，浅黄=1-8周"）',
  '                     "block"  表格按周次分成多块，每块有各自的标题',
  '                     "color"  用颜色/底色区分，需要对照图例才能确定',
  '                     "none"   图上确实没有任何周次信息',
  '  weeks_evidence   把图上**所有**与周次有关的文字**原样抄下来**（标题里的、表头里的、',
  '                    区块标题里的、图例里的、格子里的，全部抄）。这是最关键的一项，务必抄全。',
  '  weeks_mapping    周次与适用范围的对应关系，数组，每项形如',
  '                    {"scope":"适用范围","weeks":"周次原文"}。',
  '                    scope 必须能指认到具体的课程格子，有多条时各不相同：',
  '                      · 整表统一： [{"scope":"整个表格","weeks":"1-16周"}]',
  '                      · 按颜色分： [{"scope":"浅蓝色格子","weeks":"1-16周"},',
  '                                   {"scope":"浅绿色格子","weeks":"1-8周"},',
  '                                   {"scope":"浅橙色格子","weeks":"9-16周"}]',
  '                      · 按区块分： [{"scope":"左侧表格","weeks":"1-8周"},',
  '                                   {"scope":"右侧表格","weeks":"9-16周"}]',
  '                      · 周次写在每个格子里：填 []',
  '                    ⚠️ 只要 weeks_source 不是 cell，就必须把对应关系**逐条写清**；',
  '                    多条映射一律写成「整个表格」是错的（等于没给对应关系）。',
  '  slot_rule        节次编号说明：纵向表头如何编号、是否包含午休/晚间行、',
  '                    是否两小节合并为一个大节。不确定填 null。',
  '  multi_course_rule 同一时段出现多门课时的表现形式（单双周交替 / 分周次并列 / 上下半学期不同课）',
  '',
  '【铁律】',
  '只输出一个 JSON 对象。不要解释、不要加 markdown 代码块、不要加 <answer> 等标签。',
  '**不要换行、不要缩进，输出紧凑的单行 JSON**（这一步只是给下一步传规则，省下的时间留给识别）。',
  '第一个字符必须是 { ，最后一个字符必须是 } 。',
  '看不清或图中没有的信息填 null，绝对不要猜测或编造周次。'
].join('\n');

/**
 * 阶段二提示词：课程提取（可注入阶段一的版式规则）。
 *
 * 实战教训（2026-10-10 实测）：仅靠「字段固定为…」的说明约束不住模型，必须给
 * 完整示例；同时**必须显式告诉它周次该去哪读**，否则大量字段返回 null。
 */
const EXTRACT_PROMPT_BASE = [
  '你是一个课表识别助手。用户会给你一张课表截图或照片，你要把它还原成结构化 JSON。',
  '',
  '课表通常是二维表格：横向是星期（周一…周日），纵向是节次（第1节…第N节），',
  '格子里是课程名称、教师、教室等信息。一门课如果跨多个节次，会占用多个连续的格子。',
  '',
  '【输出格式铁律】',
  '只输出一个 JSON 数组。不要输出任何解释、不要加 markdown 代码块、不要加 <answer> 等标签。',
  '**不要换行、不要缩进，输出紧凑的单行 JSON**（实测模型生成速度约 40 token/秒，',
  '换行与缩进纯属浪费生成时间，紧凑写法能省一成以上的耗时）。',
  '第一个字符必须是 [ ，最后一个字符必须是 ] 。',
  '字段名必须严格使用下面这 7 个英文名，禁止改名、禁止增加字段：',
  '  name         课程名（字符串）',
  '  day_of_week  星期几（数字 1-7，1=周一）',
  '  start_slot   开始节次（数字，取该课占用的第一个节次）',
  '  slot_count   连续节数（数字，跨几节就填几，只占一节填 1）',
  '  teacher      教师（字符串）',
  '  location     上课地点（字符串）',
  '  weeks        周次规则（字符串，如 "1-16" 或 "1-16 单" 或 "1-16 双" 或 "3,5,7"）',
  '',
  '【正确输出示例】（严格照此格式：单行、无缩进、注意字段名与数字类型）',
  '[{"name":"高等数学","day_of_week":1,"start_slot":1,"slot_count":2,"teacher":"张伟","location":"A101","weeks":"1-16"},{"name":"大学英语","day_of_week":1,"start_slot":3,"slot_count":1,"teacher":"李娜","location":"B203","weeks":"1-8"}]',
  '',
  '【判读规则】',
  '1. 只填写图片中明确可见的信息。看不清或没有的字段一律填 null，绝对不要猜测或编造。',
  '2. 一门课跨多个节次时必须合并为一条记录（slot_count 填跨的节数），不要逐个格子拆成多条。',
  '3. 同一时段若确有多门课（单双周交替、上下半学期不同课），按不同课程分别输出。',
  '4. 节次序号以左侧表头（「第1节」「第2节」…）为准；表头被裁掉无法确定时 start_slot 填 null。',
  '5. 星期必须是 1-7 的数字，不要写「周一」。',
  '6. 图片里没有可识别的课程（拍糊了、不是课表），输出空数组 []。'
].join('\n');

/**
 * 周次专项要求 —— 单独成一节，因为这是最容易丢信息的字段。
 * 明确「按 weeks_source 指出的位置去读」，并给出每种情形的读法。
 */
const WEEKS_RULES = [
  '',
  '【周次的读法（务必逐条执行，周次最容易漏）】',
  '1. 课表把周次写在哪里，就按下面说明去读，**不要因为格子里没写周次就填 null**：',
  '   - cell   逐格读格子里的周次文字（如 "1-16周"、"9-16周"、"单周"、"双周"）。',
  '   - header 标题/表头给的是整张表的周次，把它套用到每一门课。',
  '   - legend 按图例说明（颜色、符号与周次的对应）确定每门课的周次。',
  '   - block  表格按周次分块，按课程所在区块的标题确定其周次。',
  '   - color  按格子底色对照图例确定周次。**必须逐个格子比对**：先把该格子归入',
  '            图例里的某个颜色（如"浅绿"），再套用该颜色对应的周次。不要凭整体印象。',
  '2. weeks 一律填**周次规则原文的数字形式**，例如 "1-16"、"1-8"、"9-16"、',
  '   "1-16 单"、"1-16 双"、"3,5,7"。可以去掉「第」「周」等字，但不要换算成日期，',
  '   不要写「每周」「全学期」这类无法解析的话。',
  '3. 如果同一格子里并列了两门课且周次不同（如单周一门、双周一门），',
  '   拆成两条记录，各自填自己的周次。',
  '4. 只有在这张图确实没有任何周次线索（weeks_source 为 none）时，才填 null。'
].join('\n');

/**
 * 把阶段一的版式分析结果拼进提取提示词。
 *
 * 两个省 token（也就是省时间）的细节：
 *   1. **压掉换行与缩进** —— 模型习惯把 JSON 打印成多行缩进格式，实测能占掉三成
 *      以上的 token，而这里只是给模型看的上下文，紧凑单行完全等价。JSON 字符串
 *      内部不可能出现裸换行（会被转义），所以批量压缩空白是安全的。
 *   2. **限长 1200 字** —— 版式规则里真正影响周次的只有 weeks_source /
 *      weeks_evidence / weeks_mapping 三项，截断尾部不会伤到关键信息。
 *
 * @param {string} layoutRaw 阶段一模型返回的原始文本
 */
function buildExtractPrompt(layoutRaw) {
  const parts = [EXTRACT_PROMPT_BASE];
  const compact = String(layoutRaw || '').replace(/\s+/g, ' ').trim();
  if (compact) {
    parts.push(
      '',
      '【本张课表的版式规则（前一步已分析得出，必须遵守）】',
      compact.slice(0, 1200)
    );
  }
  parts.push(WEEKS_RULES);
  return parts.join('\n');
}

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

  // 允许调用方指定模型（A/B 对比或应急切换），不传走默认快模型
  const visionModel =
    (event && event.model) || DEFAULT_VISION_MODEL;

  // 探活模式：只做一次纯文本模型调用，用于确认模型通道是否可用
  if (event && event.probe === true) {
    const t0 = Date.now();
    try {
      const model = ai.createModel(MODEL_GROUP);
      const r = await model.generateText(
        {
          model: event.probeModel || visionModel,
          messages: [{ role: 'user', content: '回复两个字：正常' }]
        },
        { timeout: AI_TIMEOUT }
      );
      return {
        ok: true,
        probe: true,
        model: event.probeModel || visionModel,
        ms: Date.now() - t0,
        text: (r && r.text) || '',
        usage: (r && r.usage) || null
      };
    } catch (e) {
      return fail('PROBE_FAILED', '模型探活失败', {
        model: event.probeModel || visionModel,
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
  const downloadMs = Date.now() - tDownload;
  console.log('[recognizeTimetable] 下载耗时', downloadMs, 'ms, bytes=', image.bytes);

  const dataUrl = `data:${mimeOf(fileID)};base64,${image.base64}`;
  const model = ai.createModel(MODEL_GROUP);

  // 全局时间预算起点：后面每次模型调用都从这里扣额度
  const tBudgetStart = Date.now();
  const remaining = () => TOTAL_MODEL_BUDGET - (Date.now() - tBudgetStart);

  // ---------- 构建带图的多模态 messages ----------
  const buildMessages = (systemPrompt, userText) => [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];

  // ---------- 阶段一：版式分析（可跳过） ----------
  // 只让模型读懂「阅读规则」，尤其周次写在哪里。失败不阻断主流程。
  const wantLayout = !(event && event.layout === false);
  let layoutRaw = '';
  let layoutMs = 0;
  let layoutError = '';
  let layoutUsage = null;

  if (wantLayout) {
    const tLayout = Date.now();
    // 版式分析最多用掉一半预算，保证提取阶段还有时间
    const layoutBudget = Math.min(AI_TIMEOUT, Math.max(MIN_CALL_BUDGET, Math.floor(remaining() * 0.5)));
    try {
      const r = await model.generateText(
        {
          model: visionModel,
          messages: buildMessages(
            LAYOUT_PROMPT,
            '请分析这张课表的版式规则，按要求的紧凑单行 JSON 对象输出。'
          )
        },
        { timeout: layoutBudget }
      );
      layoutRaw = (r && r.text) || '';
      layoutUsage = (r && r.usage) || null;
      layoutMs = Date.now() - tLayout;
      console.log(
        '[recognizeTimetable] 版式分析耗时', layoutMs, 'ms, len=', layoutRaw.length,
        'usage=', JSON.stringify(layoutUsage)
      );
    } catch (e) {
      layoutMs = Date.now() - tLayout;
      layoutError = String((e && (e.message || e.errMsg)) || e).slice(0, 200);
      console.error('[recognizeTimetable] 版式分析失败，降级为单阶段提取', e);
    }
  }

  // ---------- 阶段二：课程提取（带上版式规则） ----------
  const tModel = Date.now();
  const extractBudget = Math.max(MIN_CALL_BUDGET, Math.min(AI_TIMEOUT, remaining()));
  try {
    const result = await model.generateText(
      {
        model: visionModel,
        messages: buildMessages(
          buildExtractPrompt(layoutRaw),
          '请识别这张课表，按要求的 JSON 数组格式输出。'
        )
      },
      { timeout: extractBudget }
    );

    // 只回传文本，JSON 解析与 Schema 校验统一放在客户端管线里做
    const raw = (result && result.text) || '';
    const modelMs = Date.now() - tModel;
    const extractUsage = (result && result.usage) || null;
    console.log(
      '[recognizeTimetable] 提取耗时', modelMs, 'ms, rawLen=', raw.length,
      'model=', visionModel, 'layout=', wantLayout ? (layoutRaw ? 'ok' : 'failed') : 'skipped',
      'extractBudget=', extractBudget,
      'extractUsage=', JSON.stringify(extractUsage),
      'promptLen=', buildExtractPrompt(layoutRaw).length
    );
    if (!raw) return fail('EMPTY_RESULT', '模型没有返回内容，请换一张更清晰的图片');

    return {
      ok: true,
      raw,
      layout: layoutRaw,          // 版式规则原始文本，客户端可解析后展示
      model: visionModel,
      usage: extractUsage,
      usageLayout: layoutUsage,
      promptChars: buildExtractPrompt(layoutRaw).length,
      imageBytes: image.bytes,
      ms: { download: downloadMs, layout: layoutMs, model: modelMs, total: Date.now() - tDownload },
      layoutError: layoutError || undefined,
      layoutSkipped: wantLayout ? undefined : true
    };
  } catch (e) {
    console.error('[recognizeTimetable] 模型调用失败', e);
    // 回传错误摘要：模型/网关报错时便于排查（不含任何凭据，只保留类型与消息）
    const detail = String((e && (e.message || e.errMsg)) || e).slice(0, 300);
    const code = (e && (e.code || e.errCode)) || '';
    return fail('MODEL_ERROR', '图片识别服务暂时不可用，可以改用手工录入', {
      detail,
      code: String(code),
      model: visionModel,
      ms: Date.now() - tModel
    });
  }
};
