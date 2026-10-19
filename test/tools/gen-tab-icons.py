#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成小程序 tabBar 图标（零依赖：只用 Python 标准库）

为什么不用现成图标库 / ImageMagick / sharp：
  项目里没有这些工具，为四个图标装一大堆依赖不划算。这里用「有符号距离场 + 超采样」
  自己画线条并手写 PNG 编码，脚本可入库、可复现 —— 以后想改线宽、圆角、配色，
  改下面的常量重跑即可，不用去某个设计软件里手工导出。

用法：
  python test/tools/gen-tab-icons.py             # 只生成图标
  python test/tools/gen-tab-icons.py --preview   # 额外输出 tab-preview.png 评审图

输出：
  miniprogram/images/tab/{timetable,build,match,profile}[-active].png
  81×81 PNG（微信 tabBar 推荐尺寸），透明底 + 单色线稿

风格约定（四个图标统一）：
  - 线宽 5.0（在 81 画布上），圆头端点
  - 图形区留边 ~10，视觉重心居中
  - 未选中 #8a8f99（与 theme.json 的 tabFontColor 对齐，浅深背景都够看）
  - 选中 #4a86ff（取浅色 #3a7afe 与深色 #5b90ff 的中间值 ——
    tabBar 的 iconPath 不支持 @ 主题变量，只能一套图两套背景共用，取折中最稳）
"""

import math
import os
import struct
import sys
import zlib

# ---------- 画布参数 ----------
W = 81          # 输出边长（微信推荐 81×81）
SS = 4          # 超采样倍数：4x 绘制后 box 下采样，曲线更平滑
STROKE = 5.0    # 线宽（输出坐标系下的像素）
HALF = STROKE / 2.0

COLOR_NORMAL = (0x8A, 0x8F, 0x99)
COLOR_ACTIVE = (0x4A, 0x86, 0xFF)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       '..', '..', 'miniprogram', 'images', 'tab')


# ---------- 距离场图元 ----------
# 全部返回「到图形骨架的有符号距离」：描边类取 |d| 与 HALF 比较。

def d_round_rect(px, py, cx, cy, hw, hh, r):
    """圆角矩形描边的 SDF（外部为正，内部为负）"""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def d_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def d_seg(px, py, x1, y1, x2, y2):
    """到线段的距离（配合 |d|<HALF 即得胶囊形线条，端点天然圆头）"""
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 == 0.0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / l2
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def d_arc(px, py, cx, cy, r, a0, a1):
    """圆弧（角度制，屏幕坐标 y 向下，0=右、90=下、180=左）。
    超出角度范围时退化为到两端点的距离 —— 端点因此也是圆头。"""
    a0r = math.radians(a0)
    a1r = math.radians(a1)
    ang = math.atan2(py - cy, px - cx)
    span = a1r - a0r
    rel = (ang - a0r) % (2.0 * math.pi)
    if rel <= span:
        return abs(math.hypot(px - cx, py - cy) - r)
    e0x, e0y = cx + r * math.cos(a0r), cy + r * math.sin(a0r)
    e1x, e1y = cx + r * math.cos(a1r), cy + r * math.sin(a1r)
    return min(math.hypot(px - e0x, py - e0y), math.hypot(px - e1x, py - e1y))


# ---------- 光栅化 ----------

class Canvas(object):
    """超采样画布：存 0..1 的覆盖率。"""

    def __init__(self):
        self.n = W * SS
        self.buf = [0.0] * (self.n * self.n)
        self.px = 1.0 / SS          # 一个输出像素在绘制坐标里占多少
        self.scale = float(SS)      # 输出坐标 → 绘制坐标

    def _plot(self, x0, y0, x1, y1, fn):
        """在 bbox 内逐点求值。bbox 用输出坐标给，便于按图形写。"""
        n, px = self.n, self.px
        buf = self.buf
        gx0 = max(0, int(math.floor(x0 * self.scale)))
        gy0 = max(0, int(math.floor(y0 * self.scale)))
        gx1 = min(n - 1, int(math.ceil(x1 * self.scale)))
        gy1 = min(n - 1, int(math.ceil(y1 * self.scale)))
        for gy in range(gy0, gy1 + 1):
            py = (gy + 0.5) * px
            row = gy * n
            for gx in range(gx0, gx1 + 1):
                d = fn((gx + 0.5) * px, py)
                # 覆盖率：把 1 个输出像素宽的过渡带铺在边界上
                a = 0.5 - (abs(d) - HALF) / px
                if a <= 0.0:
                    continue
                a = 1.0 if a > 1.0 else a
                i = row + gx
                if a > buf[i]:
                    buf[i] = a

    def stroke(self, fn, bbox, pad=STROKE):
        b = (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad)
        self._plot(b[0], b[1], b[2], b[3], fn)

    def fill(self, fn, bbox, pad=2.0):
        """实心填充（用于课程小块）"""
        n, px = self.n, self.px
        buf = self.buf
        gx0 = max(0, int(math.floor((bbox[0] - pad) * self.scale)))
        gy0 = max(0, int(math.floor((bbox[1] - pad) * self.scale)))
        gx1 = min(n - 1, int(math.ceil((bbox[2] + pad) * self.scale)))
        gy1 = min(n - 1, int(math.ceil((bbox[3] + pad) * self.scale)))
        for gy in range(gy0, gy1 + 1):
            py = (gy + 0.5) * px
            row = gy * n
            for gx in range(gx0, gx1 + 1):
                d = fn((gx + 0.5) * px, py)
                a = 0.5 - d / px
                if a <= 0.0:
                    continue
                a = 1.0 if a > 1.0 else a
                i = row + gx
                if a > buf[i]:
                    buf[i] = a

    def downsample(self):
        """box 下采样到 W×W，返回 alpha 行（每行 W 个 0..1 浮点）"""
        n, s = self.n, SS
        buf = self.buf
        rows = []
        inv = 1.0 / (s * s)
        for y in range(W):
            row = []
            for x in range(W):
                acc = 0.0
                for dy in range(s):
                    base = (y * s + dy) * n + x * s
                    for dx in range(s):
                        acc += buf[base + dx]
                row.append(acc * inv)
            rows.append(row)
        return rows


# ---------- PNG 编码（RGBA，无滤波） ----------

def write_png(path, rows, rgb):
    w = h = len(rows)
    r, g, b = rgb
    raw = bytearray()
    for row in rows:
        raw.append(0)                       # filter type 0
        for a in row:
            v = int(a * 255.0 + 0.5)
            if v <= 0:
                raw += b'\x00\x00\x00\x00'
            else:
                raw += bytes((r, g, b, v))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)   # 8bit RGBA
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


# ---------- 四个图标 ----------

def icon_timetable(c):
    """课表：日历框 + 两个挂环 + 表头分隔线 + 两个课程块"""
    cx, cy, hw, hh, r = 40.5, 45.0, 28.5, 26.0, 9.0
    c.stroke(lambda x, y: d_round_rect(x, y, cx, cy, hw, hh, r),
             (cx - hw, cy - hh, cx + hw, cy + hh))
    # 挂环（略穿进框内，避免看起来像天线）
    c.stroke(lambda x, y: d_seg(x, y, 27.5, 9.5, 27.5, 22.0), (25.0, 7.0, 30.0, 24.5))
    c.stroke(lambda x, y: d_seg(x, y, 53.5, 9.5, 53.5, 22.0), (51.0, 7.0, 56.0, 24.5))
    # 表头分隔线
    c.stroke(lambda x, y: d_seg(x, y, 12.0, 34.0, 69.0, 34.0), (9.5, 31.5, 71.5, 36.5))
    # 课程块（实心小圆角方块，圆角靠 SDF 负值区域自然成形）
    # 水平按框内可用宽度居中（内沿 14.5..66.5，两块 14 宽 + 8 间隙 = 36），
    # 垂直落在表头线与底边之间的正中（36.5..68.5 → 52.5）
    for bx in (29.5, 51.5):
        by, bh, bw, br = 52.5, 6.0, 7.0, 2.0
        c.fill(lambda x, y, bx=bx, by=by, bw=bw, bh=bh, br=br:
               d_round_rect(x, y, bx, by, bw, bh, br),
               (bx - bw, by - bh, bx + bw, by + bh), pad=0.5)


def icon_build(c):
    """建表：表格框 + 内部横竖线 + 右上角加号"""
    cx, cy, hw, hh, r = 26.0, 47.0, 18.0, 25.0, 8.0
    c.stroke(lambda x, y: d_round_rect(x, y, cx, cy, hw, hh, r),
             (cx - hw, cy - hh, cx + hw, cy + hh))
    c.stroke(lambda x, y: d_seg(x, y, 8.0, 37.0, 44.0, 37.0), (5.5, 34.5, 46.5, 39.5))
    c.stroke(lambda x, y: d_seg(x, y, 26.0, 37.0, 26.0, 72.0), (23.5, 34.5, 28.5, 74.5))
    # 加号（与表格框留出间隙，避免视觉粘连）
    c.stroke(lambda x, y: d_seg(x, y, 54.5, 24.0, 71.5, 24.0), (52.0, 21.5, 74.0, 26.5))
    c.stroke(lambda x, y: d_seg(x, y, 63.0, 15.5, 63.0, 32.5), (60.5, 13.0, 65.5, 35.0))


def icon_match(c):
    """找搭子：并排两个人（头 + 肩弧）"""
    for hx in (21.0, 60.0):
        c.stroke(lambda x, y, hx=hx: d_circle(x, y, hx, 27.5, 9.5),
                 (hx - 9.5, 18.0, hx + 9.5, 37.0))
    for hx in (21.0, 60.0):
        c.stroke(lambda x, y, hx=hx: d_arc(x, y, hx, 56.5, 14.0, 180.0, 360.0),
                 (hx - 14.0, 42.5, hx + 14.0, 56.5))


def icon_profile(c):
    """我的：单人（头 + 肩弧），比例比「找搭子」里的小人大一号"""
    c.stroke(lambda x, y: d_circle(x, y, 40.5, 28.5, 11.5), (29.0, 17.0, 52.0, 40.0))
    c.stroke(lambda x, y: d_arc(x, y, 40.5, 68.0, 19.5, 180.0, 360.0),
             (21.0, 48.5, 60.0, 68.0))


ICONS = (
    ('timetable', icon_timetable),
    ('build', icon_build),
    ('match', icon_match),
    ('profile', icon_profile),
)


# ---------- 预览图（评审用，不进小程序包） ----------

PREVIEW_SCALE = 3


def write_preview(path, groups):
    """把图标按底色分组排成一张大图，评审用。

    groups: [(bg_rgb, [(icon_rows, color_rgb), ...]), ...]
    默认排 4 行：浅底普通 / 浅底选中 / 深底普通 / 深底选中 ——
    正好对应「浅色模式 tabBar」与「深色模式 tabBar」的真实观感。
    """
    s = PREVIEW_SCALE
    cell = W * s
    gap = 16
    cols = max(len(items) for _, items in groups)
    width = cols * cell + (cols + 1) * gap
    row_h = cell + gap
    height = len(groups) * row_h + gap

    canvas = [[(255, 255, 255)] * width for _ in range(height)]
    for row_idx, (bg, _) in enumerate(groups):
        y0 = gap + row_idx * row_h
        for y in range(cell):
            for x in range(width):
                canvas[y0 + y][x] = bg

    for row_idx, (bg, items) in enumerate(groups):
        y0 = gap + row_idx * row_h
        for ci, (alpha, color) in enumerate(items):
            x0 = gap + ci * (cell + gap)
            for y in range(cell):
                line = alpha[y // s]
                for x in range(cell):
                    a = line[x // s]
                    if a <= 0:
                        continue
                    br, bgc, bb = canvas[y0 + y][x0 + x]
                    canvas[y0 + y][x0 + x] = (
                        int(color[0] * a + br * (1 - a) + 0.5),
                        int(color[1] * a + bgc * (1 - a) + 0.5),
                        int(color[2] * a + bb * (1 - a) + 0.5),
                    )

    # 直接写 RGB（color type 2）
    h = len(canvas)
    raw = bytearray()
    for row in canvas:
        raw.append(0)
        for px in row:
            raw += bytes(px)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', width, h, 8, 2, 0, 0, 0)
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)
    return len(data)


def main():
    out = os.path.normpath(OUT_DIR)
    if not os.path.isdir(out):
        os.makedirs(out)

    normal = []
    active = []
    for name, painter in ICONS:
        c = Canvas()
        painter(c)
        rows = c.downsample()
        normal.append((rows, COLOR_NORMAL))
        active.append((rows, COLOR_ACTIVE))
        for suffix, rgb in (('', COLOR_NORMAL), ('-active', COLOR_ACTIVE)):
            path = os.path.join(out, '%s%s.png' % (name, suffix))
            size = write_png(path, rows, rgb)
            print('  %-24s %5d B' % (os.path.basename(path), size))

    if '--preview' in sys.argv:
        preview = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tab-preview.png')
        size = write_preview(preview, [
            ((255, 255, 255), normal),   # 浅色模式 · 未选中
            ((255, 255, 255), active),   # 浅色模式 · 选中
            ((26, 26, 28), normal),      # 深色模式 · 未选中
            ((26, 26, 28), active),      # 深色模式 · 选中
        ])
        print('  preview -> %s (%d B)' % (preview, size))

    print('done -> %s' % out)


if __name__ == '__main__':
    main()
