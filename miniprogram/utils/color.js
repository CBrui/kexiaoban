/**
 * utils/color.js —— 课程取色
 *
 * 目标（两条都要满足）：
 *   1. **同一门课，颜色固定** —— 多次打开、切周次、看详情，颜色都不变，便于视觉记忆
 *   2. **不同课程，颜色尽量不同** —— 一张课表里几乎所有格子颜色都不一样，才看得出分组
 *
 * 为什么不能只靠哈希：
 *   原来只按课程名哈希取 8 色。8 门课里至少两门撞色的概率是 **99.7%**
 *   （生日问题：1 - 8!/8^8 ≈ 0.998），10 门课的课表实测有 3 组撞色 ——
 *   「高等数学 / 数据结构 / 体育」全是同一个橙色，颜色分组等于没有。
 *
 * 现在的做法：**哈希定位 + 表内线性探测消重**
 *   - 先按课程名哈希决定「首选的色位」→ 保证同一门课每次都从同一个色位出发
 *   - 该色位若已被别的课程占用，则往后找下一个空色位 → 保证同一张表里异课异色
 *   - 分配顺序按课程名排序 → 与课程的录入顺序无关，只要课程集合不变，结果就完全一致
 */

// 12 色调色板（扁平、低饱和，适合长时间注视）
// 前 8 个是原调色板，顺序保留；后 4 个为本次新增，用来把撞色概率压下去。
const PALETTE = [
  '#5B8FF9', // 蓝
  '#61DDAA', // 绿
  '#65789B', // 灰蓝
  '#F6BD16', // 黄
  '#7262FD', // 紫
  '#78D3F8', // 浅蓝
  '#9661BC', // 深紫
  '#F6903D', // 橙
  '#269A99', // 深青
  '#D4380D', // 砖红
  '#7CB305', // 草绿
  '#EB2F96'  // 品红
];

/**
 * 课程名 → 哈希值（同为 Java String.hashCode 的 31 进制写法）
 * 负数已被 & 0xffffffff 处理成非负，这里再取一次绝对值兜底。
 * @param {string} name
 * @returns {number} 非负整数
 */
function hashOf(name) {
  const str = String(name == null ? '' : name);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash);
}

/**
 * 课程名 → 首选色位下标
 * @param {string} name
 * @returns {number} 0..PALETTE.length-1
 */
function baseIndexOf(name) {
  return hashOf(name) % PALETTE.length;
}

/**
 * 课程名 → 稳定颜色（单点查询，不做消重）
 * 用于拿不到整张课表课程名单的场景（如详情卡片兜底）。
 * 需要「异课异色」时请用 buildColorMap。
 *
 * @param {string} name 课程名称
 * @returns {string} 十六进制色值
 */
function colorOf(name) {
  if (!name) return PALETTE[0];
  return PALETTE[baseIndexOf(name)];
}

/**
 * 为一组课程名分配颜色表：同课同色、异课异色。
 *
 * @param {string[]} names 课程名列表（可含重复、空值，内部会去重清洗）
 * @param {string[]} [palette] 自定义调色板，默认 12 色
 * @returns {object} { '高等数学': '#5B8FF9', ... }
 */
function buildColorMap(names, palette) {
  const colors = palette && palette.length ? palette : PALETTE;
  const uniq = Array.from(
    new Set(
      (names || [])
        .map((n) => String(n == null ? '' : n).trim())
        .filter(Boolean)
    )
  ).sort();

  const map = {};
  const used = new Set();

  for (const name of uniq) {
    let idx = hashOf(name) % colors.length;
    let probe = 0;
    // 线性探测：从首选色位往后找第一个没被占用的
    while (used.has(idx) && probe < colors.length) {
      idx = (idx + 1) % colors.length;
      probe += 1;
    }
    if (used.has(idx)) {
      // 调色板被占满（课程数 > 色数）：允许少数课程复用首选色，
      // 至少保证「同一门课的颜色」仍然稳定。
      map[name] = colors[hashOf(name) % colors.length];
      continue;
    }
    used.add(idx);
    map[name] = colors[idx];
  }

  return map;
}

/**
 * 生成课程色块的浅色底（用于背景）
 * 简单做法：返回同色系 14% 透明度
 */
function softOf(hex) {
  const c = String(hex || '').replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

module.exports = { colorOf, softOf, buildColorMap, PALETTE };
