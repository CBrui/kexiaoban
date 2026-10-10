/**
 * logic/course-shift.js —— 调课（补课 / 换课 / 挪课 / 停课）指令解析与变更计划
 *
 * 解决的场景：
 *   「今天补上周二的课」「今天换成上周二的课」
 *   「周三的高数调到周五第3节」「今天只补上周二的34节」
 *   以及直接粘贴一整段教务处调休通知，自动拆成多条变更。
 *
 * 设计要点（踩过的坑先写在这里）：
 * 1. **本模块只生成计划，不落库**。落库在页面层执行，因为要弹确认、
 *    要调 api/course.js。逻辑层保持纯函数，方便测试。
 * 2. **「换掉今天」绝不能 removeCourse**。课程是周次规则模型，
 *    weeks="1-16" 的课直接删会让它所有周都消失。必须调用
 *    removeWeekFromRule 只把当天那一周从规则里挖掉。
 * 3. **单日例外模型**：所有调课都只影响指令涉及的那一天（源日/目标日），
 *    通过「挖周 + 新建仅含该周的记录」实现，与现有周次规则渲染天然兼容，
 *    不需要改渲染层和「找搭子」对齐算法。
 */
const { parseWeeks, removeWeekFromRule, addWeekToRule, weekInRule } = require('../utils/week');
const { resolveDateExpr } = require('./shift-date');

/* ================= 动作词表 ================= */

/** 换：目标日改成源日的课（先清目标日，再放源日的课） */
const REPLACE_WORDS = ['换成', '换为', '替换成', '改成', '改为', '调成', '按', '照', '跟着', '上成', '变成'];
/** 补：目标日追加源日的课（保留目标日原有课） */
const APPEND_WORDS = ['补上', '补', '加上', '加', '追加', '增添', '增加'];
/** 挪：把源日某门课移到目标日（只影响源日那一天） */
const MOVE_WORDS = ['调到', '调至', '移到', '移至', '挪到', '挪至', '改到', '改至', '换到', '换至'];
/** 停：目标日没课 */
const CANCEL_WORDS = ['停课', '没课', '不上', '取消', '停上', '放假', '休息'];

const ACTION_TEXT = {
  replace: '换课',
  append: '补课',
  move: '挪课',
  cancel: '停课'
};

/* ================= 日期候选提取 ================= */

const DAY_WORDS = '今天|今日|当天|当日|明天|明日|次日|后天|昨天|昨日|前天';

/**
 * 带修饰的周表达：修饰词里**已经带了**「周/星期」，后面直接跟星期数字。
 *
 * 曾经写错过一版：写成 `(?:上周|本周)?(?:周|星期)\\s*[一二…]`，
 * 「上周」把「周」字吃掉后还要求再匹配一个「周」，于是「上周二」整条
 * 匹配失败、退化成裸「周二」= 本周，「上周二」被静默当成「本周二」。
 * 这里把整串修饰词（含周字）整体列出，避免二次匹配「周」。
 */
const WEEK_PREFIX = '上上个星期|上上星期|上上周|上个星期|上星期|上周|上一周|' +
  '这个星期|这星期|本周|这周|这一周|' +
  '下下个星期|下下星期|下下周|下个星期|下星期|下周|下一周';

/** 在文本里找出所有日期表述（用于区分「目标日」和「源日」） */
const DATE_PATTERN = new RegExp(
  `(${DAY_WORDS})` +
  `|((?:${WEEK_PREFIX})\\s*[一二三四五六日天])` +
  `|((?:周|星期|礼拜)\\s*[一二三四五六日天])` +
  `|(第?\\s*\\d{1,2}\\s*周\\s*(?:周|星期|礼拜)?\\s*[一二三四五六日天])` +
  `|(\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?)`,
  'g'
);

/**
 * 提取文本里的所有日期表述并按出现顺序返回
 * @returns {Array<{text:string, index:number, resolved:object}>}
 */
function findDateExprs(text, ctx) {
  const s = String(text || '');
  const found = [];
  let m;
  const re = new RegExp(DATE_PATTERN.source, 'g');

  while ((m = re.exec(s)) !== null) {
    const word = m[0];
    if (!word || !word.trim()) continue;
    const resolved = resolveDateExpr(word, ctx);
    if (!resolved) continue;
    found.push({ text: word, index: m.index, resolved });
  }
  return found;
}

/* ================= 节次范围解析 ================= */

/**
 * 从文本里抽出节次范围，如「34节」「3-4节」「第3节」
 * @returns {number[]|null} 节次数组；未指定返回 null
 */
function parseSlots(text) {
  const s = String(text || '');

  // 3-4节 / 3至4节 / 3~4节
  let m = s.match(/(\d{1,2})\s*[-~—至]\s*(\d{1,2})\s*节/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a >= 1 && b >= a && b <= 24) {
      const out = [];
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    }
  }

  // 34节 —— 连写数字（大节最多 6 个，两位都 ≤ 9 才按连写处理）
  m = s.match(/(?:^|[^\d])(\d)\s*(\d)\s*节/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a >= 1 && b >= 1 && a <= 9 && b <= 9) return [a, b];
  }

  // 三四节 —— 中文数字连写
  m = s.match(/([一二三四五六七八九])\s*([一二三四五六七八九])\s*节/);
  if (m) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const a = map[m[1]];
    const b = map[m[2]];
    if (a && b) return [a, b];
  }

  // 第3节 / 3节
  m = s.match(/(\d{1,2})\s*节/);
  if (m) {
    const a = parseInt(m[1], 10);
    if (a >= 1 && a <= 24) return [a];
  }

  return null;
}

/* ================= 指令解析 ================= */

function findWord(text, words) {
  const s = String(text || '');
  let best = null;
  for (const w of words) {
    const i = s.indexOf(w);
    if (i === -1) continue;
    // 取最长的匹配词，避免「补」抢在「补上」前面
    if (!best || w.length > best.word.length) best = { word: w, index: i };
  }
  return best;
}

/**
 * 取某一天（周次+星期）当天的所有课程
 * @param {object[]} courses
 * @param {number} week
 * @param {number} dayOfWeek
 * @returns {object[]}
 */
function coursesOnDate(courses, week, dayOfWeek) {
  const w = Number(week);
  const d = Number(dayOfWeek);
  if (!Array.isArray(courses)) return [];
  return courses.filter((c) => {
    if (Number(c.day_of_week) !== d) return false;
    return weekInRule(c.weeks, w);
  });
}

/**
 * 课程名模糊匹配
 *
 * 用户口里的课名常常是简称：「高数」→「高等数学」、「大物」→「大学物理」。
 * 双向子串都试一遍，再退一步按「去掉大学/基础等常见修饰后」的子串比较。
 */
function nameMatches(courseName, keyword) {
  const a = String(courseName || '').trim();
  const b = String(keyword || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;

  // 去掉常见修饰词后再比一次：「高等数学」→「数学」，「大学物理」→「物理」
  const FILLER = /(大学|高等|基础|普通|高级|初级|应用|工程|现代|中级)/g;
  const a2 = a.replace(FILLER, '');
  const b2 = b.replace(FILLER, '');
  if (a2 && b2 && (a2.indexOf(b2) !== -1 || b2.indexOf(a2) !== -1)) return true;

  // 中文简称是**子序列**关系而非子串：「高数」= 高[等]数[学]、「大物」= 大[学]物[理]。
  // 子串比较全部落空，这里按「字符按顺序出现」再试一次。
  if (isSubSequence(b, a) || isSubSequence(a, b)) return true;

  return false;
}

/** b 的字符是否按顺序出现在 a 中（不要求连续） */
function isSubSequence(b, a) {
  if (!b || !a) return false;
  if (b.length > a.length) return false;
  let i = 0;
  for (const ch of a) {
    if (ch === b[i]) i++;
    if (i === b.length) return true;
  }
  return i === b.length;
}

/** 课程占用的节次区间 */
function slotRangeOf(course) {
  const start = Number(course.start_slot);
  const count = Number(course.slot_count) || 1;
  const out = [];
  for (let i = 0; i < count; i++) out.push(start + i);
  return out;
}

/** 按节次范围过滤课程：与指定节次有交集就整门保留（保持课程完整） */
function filterBySlots(courses, slots) {
  if (!slots || !slots.length) return courses.slice();
  return courses.filter((c) => slotRangeOf(c).some((s) => slots.indexOf(s) !== -1));
}

/**
 * 把一句话解析成调课指令
 *
 * @param {string} text 用户输入
 * @param {object} ctx { termStartMonday, today, maxWeek }
 * @returns {object|null} 指令；不是调课指令返回 null
 */
function parseShiftInstruction(text, ctx) {
  const s = String(text || '').trim();
  if (!s || !ctx) return null;

  const move = findWord(s, MOVE_WORDS);
  const cancel = findWord(s, CANCEL_WORDS);
  const replace = findWord(s, REPLACE_WORDS);
  const append = findWord(s, APPEND_WORDS);

  // 动作判定优先级：挪 > 停 > 换 > 补
  // 「换成」比「补」长且语义明确，findWord 已按长度择优，这里只需按动作类型排
  let action = null;
  let verb = null;
  if (move) {
    action = 'move';
    verb = move;
  } else if (cancel) {
    action = 'cancel';
    verb = cancel;
  } else if (replace) {
    action = 'replace';
    verb = replace;
  } else if (append) {
    action = 'append';
    verb = append;
  } else {
    return null; // 没有调课动词 → 交给原建课管线
  }

  const dates = findDateExprs(s, ctx);
  if (!dates.length) return null;

  // 动词两侧拆分日期
  //
  // after 用 `>= verb.index` 而不是 `> verb.index + 词长`：
  // 「今天补上周二的课」里动词会命中「补**上**」，而它末尾的「上」正是
  // 日期「**上**周二」的开头（两者共用同一个字）。按词长切会把「上周二」
  // 判成动词之前，源日直接丢失。放宽到起点位置即可正确落到动词之后。
  const before = dates.filter((d) => d.index < verb.index);
  const after = dates.filter((d) => d.index >= verb.index);

  let source = null;
  let target = null;

  if (action === 'move') {
    // 「周三的高数调到周五第3节」：动词前是源日，动词后是目标日
    source = before.length ? before[before.length - 1].resolved : null;
    target = after.length ? after[0].resolved : null;
    if (!target) target = before.length > 1 ? before[0].resolved : null;
  } else if (action === 'cancel') {
    // 「今天没课」：唯一日期即目标日
    target = dates[0].resolved;
  } else {
    // 「今天补上周二的课」：动词前是目标日，动词后是源日
    target = before.length ? before[0].resolved : null;
    source = after.length ? after[0].resolved : null;
    // 「把上周二的课补到今天」这类倒装：前面没有日期时反过来取
    if (!target && source) {
      target = source;
      source = (after[1] || before[0] || {}).resolved || null;
    }
  }

  // 日期带上索引，供节次解析定位（防止整句里的无关数字被当成节次）
  if (source) {
    const hit = dates.find((d) => d.resolved === source);
    if (hit) {
      source._index = hit.index;
      source._len = hit.text.length;
    }
  }

  if (!target) return null;
  if ((action === 'replace' || action === 'append') && !source) return null;

  // 目标节次（挪课时用）
  const tail = s.slice(verb.index + verb.word.length);
  const targetSlots = action === 'move' ? parseSlots(tail) : null;

  // 源日节次过滤（「只补上周二的34节」）
  // 只从源日表述**之后**开始找节次，避免把整句里别的数字（如「1-16周」）误当节次
  const srcText = source && source._index != null
    ? s.slice(source._index + (source._len || 0))
    : '';
  const sourceSlots = parseSlots(srcText);

  // 课程名（挪课时指定哪门课）
  let courseName = null;
  if (action === 'move') {
    const head = s.slice(0, verb.index);
    const nm = head.match(/(?:的|把|将)?\s*([^\s，,。;；的了把将]{2,12}?)\s*(?:课)?\s*$/);
    if (nm) courseName = String(nm[1]).trim();
  }

  return {
    action,
    actionText: ACTION_TEXT[action],
    source,
    target,
    sourceSlots: action === 'replace' || action === 'append' ? sourceSlots : null,
    targetSlots,
    courseName,
    raw: s
  };
}

/* ================= 变更计划生成 ================= */

/**
 * 生成一份调课变更计划（纯计算，不落库）
 *
 * @param {object} instruction parseShiftInstruction 的结果
 * @param {object[]} courses 当前课表全部课程
 * @param {object} ctx { termStartMonday, today, maxWeek, totalSlots }
 * @returns {object} 计划
 */
function buildShiftPlan(instruction, courses, ctx) {
  const empty = { ok: false, reason: '', summary: '', removes: [], adds: [], updates: [], conflicts: [] };
  if (!instruction || !instruction.target) {
    return Object.assign({}, empty, { reason: '没听懂要改哪一天', summary: '没听懂要改哪一天' });
  }

  const all = Array.isArray(courses) ? courses : [];
  const target = instruction.target;
  const source = instruction.source;
  const act = instruction.action;

  const plan = {
    ok: true,
    reason: '',
    action: act,
    actionText: instruction.actionText || ACTION_TEXT[act],
    target,
    source,
    removes: [],
    adds: [],
    updates: [],
    conflicts: [],
    summary: ''
  };

  const targetCourses = coursesOnDate(all, target.week, target.dayOfWeek);

  /* ---- 停课 / 换课：先把目标日这一周从原有课的规则里挖掉 ---- */
  if (act === 'cancel' || act === 'replace') {
    for (const c of targetCourses) {
      const nextWeeks = removeWeekFromRule(c.weeks, target.week);
      plan.removes.push({
        course: c,
        courseId: c.id,
        name: c.name,
        slotText: slotRangeOf(c).join('-'),
        nextWeeks,
        willDelete: !nextWeeks
      });
    }
  }

  /* ---- 补课 / 换课：把源日的课复制成「目标日 + 仅目标周次」的新记录 ---- */
  if ((act === 'append' || act === 'replace') && source) {
    let srcCourses = coursesOnDate(all, source.week, source.dayOfWeek);
    srcCourses = filterBySlots(srcCourses, instruction.sourceSlots);

    if (!srcCourses.length) {
      plan.ok = false;
      plan.reason = `没找到「${source.label || '那天'}」的课可搬`;
      return plan;
    }

    for (const c of srcCourses) {
      // 追加时检测与目标日原有课的节次冲突
      if (act === 'append') {
        const range = slotRangeOf(c);
        const hit = targetCourses.find((t) => {
          if (t.id === c.id) return false;
          return slotRangeOf(t).some((s) => range.indexOf(s) !== -1);
        });
        if (hit) {
          plan.conflicts.push({
            name: c.name,
            slotText: range.join('-'),
            withName: hit.name
          });
        }
      }

      plan.adds.push({
        name: c.name,
        teacher: c.teacher || '',
        location: c.location || '',
        day_of_week: target.dayOfWeek,
        start_slot: Number(c.start_slot),
        slot_count: Number(c.slot_count) || 1,
        weeks: String(target.week),
        source_type: 'shift',
        _from: source.label || ''
      });
    }
  }

  /* ---- 挪课：把源日那门课的那一次挪到目标日 ---- */
  if (act === 'move' && source) {
    let srcCourses = coursesOnDate(all, source.week, source.dayOfWeek);

    // 指定了课名就必须匹配上。匹配不到要报错，绝不能静默退化成「挪一整天的课」
    // —— 用户说的是「周三的高数调到周五」，悄悄把当天所有课都挪走是事故级行为。
    if (instruction.courseName) {
      const kw = String(instruction.courseName).trim();
      const matched = srcCourses.filter((c) => nameMatches(String(c.name || ''), kw));
      if (!matched.length) {
        plan.ok = false;
        plan.reason = `没在${source.label || '那天'}找到「${kw}」，请说全课程名`;
        plan.summary = plan.reason;
        return plan;
      }
      srcCourses = matched;
    }
    srcCourses = filterBySlots(srcCourses, instruction.sourceSlots);

    if (!srcCourses.length) {
      plan.ok = false;
      plan.reason = `没找到要挪的课`;
      plan.summary = plan.reason;
      return plan;
    }

    for (const c of srcCourses) {
      // 从原课规则里挖掉源日那一周（挖空则整条删除）
      const nextWeeks = removeWeekFromRule(c.weeks, source.week);
      plan.removes.push({
        course: c,
        courseId: c.id,
        name: c.name,
        slotText: slotRangeOf(c).join('-'),
        nextWeeks,
        willDelete: !nextWeeks
      });

      const slots = instruction.targetSlots;
      const startSlot = slots && slots.length ? slots[0] : Number(c.start_slot);
      const slotCount = slots && slots.length ? slots.length : Number(c.slot_count) || 1;

      plan.adds.push({
        name: c.name,
        teacher: c.teacher || '',
        location: c.location || '',
        day_of_week: target.dayOfWeek,
        start_slot: startSlot,
        slot_count: slotCount,
        weeks: String(source.week),
        source_type: 'shift',
        _from: source.label || ''
      });
    }
  }

  plan.summary = summarizePlan(plan);
  return plan;
}

/** 把计划压缩成一句人话，用于预览卡片标题 */
function summarizePlan(plan) {
  const t = plan.target || {};
  const tText = t.label ? `${t.label}（第${t.week}周 周${'一二三四五六日'.charAt(t.dayOfWeek - 1)}）` : '';
  const parts = [];

  if (plan.action === 'cancel') {
    parts.push(`${tText} 停课`);
  } else if (plan.action === 'replace') {
    const s = plan.source || {};
    parts.push(`${tText} 换成 ${s.label || '那天'}（第${s.week}周）的课`);
  } else if (plan.action === 'append') {
    const s = plan.source || {};
    parts.push(`${tText} 补上 ${s.label || '那天'}（第${s.week}周）的课`);
  } else if (plan.action === 'move') {
    const s = plan.source || {};
    parts.push(`把 ${s.label || '源日'} 的课挪到 ${tText}`);
  }

  const bits = [];
  if (plan.removes.length) bits.push(`移除 ${plan.removes.length} 门`);
  if (plan.adds.length) bits.push(`新增 ${plan.adds.length} 门`);
  if (bits.length) parts.push(`（${bits.join('，')}）`);

  return parts.join('');
}

/**
 * 一句话判断：这段文本像不像调课指令（用于入口意图路由）
 *
 * 必须「有调课动词」**且**「能找到日期」才算调课。
 * 否则「补一节高数」「加一门英语」这类建课表述会被误判成调课。
 */
function looksLikeShift(text, ctx) {
  const s = String(text || '');
  const hit = findWord(s, MOVE_WORDS) || findWord(s, CANCEL_WORDS) ||
    findWord(s, REPLACE_WORDS) || findWord(s, APPEND_WORDS);
  if (!hit) return false;
  if (!ctx) return true; // 拿不到上下文时只按动词粗判
  return findDateExprs(s, ctx).length > 0;
}

module.exports = {
  parseShiftInstruction,
  buildShiftPlan,
  coursesOnDate,
  parseSlots,
  findDateExprs,
  looksLikeShift,
  summarizePlan,
  slotRangeOf,
  nameMatches,
  ACTION_TEXT
};
