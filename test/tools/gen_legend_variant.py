# -*- coding: utf-8 -*-
"""变体 C：颜色 + 图例式。
整张表只有一个，格子不写周次，用底色区分周次，底部用小字图例说明。
这是最难的一种版式 —— 必须读懂图例才能确定周次。
"""
from PIL import Image, ImageDraw, ImageFont
import os

BG = (255, 255, 255)
LINE = (200, 205, 215)
HEAD_BG = (238, 242, 250)
TEXT = (34, 38, 48)
SUB = (110, 118, 132)

BLUE = (219, 234, 255)
GREEN = (214, 240, 220)
ORANGE = (255, 231, 206)
EDGE = (150, 165, 185)

OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '.tmp'))
font_path = None
for p in [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\msyhbd.ttc',
          r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\simsun.ttc']:
    if os.path.exists(p):
        font_path = p
        break


def font(sz):
    if font_path:
        try:
            return ImageFont.truetype(font_path, sz)
        except Exception:
            pass
    return ImageFont.load_default()


F_TITLE = font(28)
F_HEAD = font(20)
F_SLOT = font(17)
F_NAME = font(18)
F_SUB = font(14)
F_LEGEND = font(15)

W, H = 1200, 980
img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)

x0, y0 = 40, 210
days, slots = 5, 6
col_w = (W - 2 * x0) / (days + 1)
row_h = (H - y0 - 190) / slots

d.text((x0, 40), '通信工程 1 班 2026 秋季课表', font=F_TITLE, fill=TEXT)

head_y = y0 - row_h * 0.7
d.rectangle([x0, head_y, x0 + col_w, y0], fill=HEAD_BG, outline=LINE)
d.text((x0 + 10, head_y + 8), '节次', font=F_HEAD, fill=TEXT)
day_names = ['周一', '周二', '周三', '周四', '周五']
for i, dn in enumerate(day_names):
    cx = x0 + col_w * (i + 1)
    d.rectangle([cx, head_y, cx + col_w, y0], fill=HEAD_BG, outline=LINE)
    d.text((cx + 12, head_y + 8), dn, font=F_HEAD, fill=TEXT)

slot_names = ['第1节', '第2节', '第3节', '第4节', '第5节', '第6节']
times = ['08:00', '10:05', '14:00', '16:05', '19:00', '20:55']
for r in range(slots):
    ry = y0 + row_h * r
    d.rectangle([x0, ry, x0 + col_w, ry + row_h], fill=(250, 251, 253), outline=LINE)
    d.text((x0 + 10, ry + 10), slot_names[r], font=F_SLOT, fill=TEXT)
    d.text((x0 + 10, ry + 32), times[r], font=F_SUB, fill=SUB)
    for c in range(days):
        cx = x0 + col_w * (c + 1)
        d.rectangle([cx, ry, cx + col_w, ry + row_h], outline=LINE)

# (day_idx, start_slot, span, name, teacher, room, color)
courses = [
    (0, 0, 2, '电路分析', '沈明', 'C201', BLUE),      # 1-16周
    (0, 2, 1, '信号与系统', '吴静', 'C305', GREEN),    # 1-8周
    (1, 1, 2, '数字电路', '郑凯', '实验楼2', BLUE),    # 1-16周
    (2, 0, 1, '概率论', '何丽', 'A110', ORANGE),      # 9-16周
    (2, 3, 2, '通信原理', '马强', 'C402', BLUE),      # 1-16周
    (3, 0, 2, '电磁场', '林涛', 'A305', GREEN),       # 1-8周
    (4, 2, 2, '单片机', '许芳', '实验楼1', ORANGE),    # 9-16周
]

for (day, sstart, span, name, teacher, room, color) in courses:
    cx = x0 + col_w * (day + 1)
    cy = y0 + row_h * sstart
    ch = row_h * span
    pad = 5
    d.rounded_rectangle([cx + pad, cy + pad, cx + col_w - pad, cy + ch - pad],
                        radius=8, fill=color, outline=EDGE, width=2)
    tx = cx + pad + 10
    d.text((tx, cy + pad + 10), name, font=F_NAME, fill=TEXT)
    d.text((tx, cy + pad + 36), teacher, font=F_SUB, fill=SUB)
    d.text((tx, cy + pad + 56), room, font=F_SUB, fill=SUB)

# 底部图例（小字，周次信息只在这里）
ly = y0 + row_h * slots + 40
d.text((x0, ly), '图例：', font=F_LEGEND, fill=TEXT)
lx = x0 + 70
for color, label in [(BLUE, '第 1-16 周'), (GREEN, '第 1-8 周'), (ORANGE, '第 9-16 周')]:
    d.rectangle([lx, ly + 2, lx + 22, ly + 20], fill=color, outline=EDGE)
    d.text((lx + 30, ly), label, font=F_LEGEND, fill=SUB)
    lx += 200
d.text((x0, ly + 32), '说明：底色表示该课程的上课周次。', font=font(14), fill=SUB)

out = os.path.join(OUT_DIR, 'timetable_legend_weeks.png')
img.save(out, 'PNG')
print('saved C:', out, os.path.getsize(out))
