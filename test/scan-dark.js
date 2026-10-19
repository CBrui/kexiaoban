/**
 * 深色模式漏网扫描（临时工具，非单测）
 *
 * 找出所有「浅色硬编码背景/边框」中，没有在文件末尾媒体查询里被覆盖的类。
 * 背景色亮度阈值 200（0-255 均值），只管 background / border，不管文字色。
 *
 * 用法：node test/scan-dark.js
 */
const fs = require('fs');

const pageDir = 'miniprogram/pages';
const files = ['miniprogram/app.wxss']
  .concat(fs.readdirSync(pageDir)
    .filter((d) => fs.existsSync(`${pageDir}/${d}/index.wxss`))
    .map((d) => `${pageDir}/${d}/index.wxss`));

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function isLight(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (r + g + b) / 3 > 200;
}

let total = 0;
files.forEach((f) => {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const mq = lines.findIndex((l) => l.indexOf('prefers-color-scheme') !== -1);
  const darkBody = mq >= 0 ? lines.slice(mq).join('\n') : '';
  let cur = '?';
  const miss = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(\.[a-zA-Z0-9_.-]+)/);
    if (m) cur = m[1];
    if (mq >= 0 && i >= mq) return; // 跳过深色块自身
    const cm = l.match(/#[0-9a-fA-F]{3,6}/g);
    if (!cm) return;
    if (l.indexOf('--') !== -1) return; // CSS 变量定义/引用行不算
    if (l.indexOf('color:') !== -1 && l.indexOf('background') === -1) return; // 纯文字色不算
    cm.forEach((c) => {
      if (isLight(c) && (l.indexOf('background') !== -1 || l.indexOf('border') !== -1)) {
        if (darkBody.indexOf(cur) === -1) miss.push(`  ${i + 1}行 ${cur} -> ${c}`);
      }
    });
  });
  if (miss.length) {
    console.log(`⚠️  ${f}`);
    miss.forEach((x) => console.log(x));
    total += miss.length;
  }
});

console.log(total === 0 ? '✓ 无漏网浅底色' : `共 ${total} 处待确认`);
