/**
 * utils/color.js —— 课程名哈希取色
 *
 * 保证同一门课在多次打开时颜色一致，便于视觉记忆。
 */

// 8 色调色板（扁平、低饱和，适合长时间注视）
const PALETTE = [
  '#5B8FF9', // 蓝
  '#61DDAA', // 绿
  '#65789B', // 灰蓝
  '#F6BD16', // 黄
  '#7262FD', // 紫
  '#78D3F8', // 浅蓝
  '#9661BC', // 深紫
  '#F6903D'  // 橙
];

/**
 * 课程名 → 稳定颜色
 * @param {string} name 课程名称
 * @returns {string} 十六进制色值
 */
function colorOf(name) {
  if (!name) return PALETTE[0];
  let hash = 0;
  const str = String(name);
  for (let i = 0; i < str.length; i++) {
    // 与文档中的哈希写法保持一致
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * 生成课程色块的浅色底（用于背景）
 * 简单做法：返回同色系 12% 透明度
 */
function softOf(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

module.exports = { colorOf, softOf, PALETTE };
