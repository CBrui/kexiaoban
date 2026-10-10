# -*- coding: utf-8 -*-
"""生成「周次不在格子里」的课表图，复现「识别不到周数」的问题。

变体 A：标题式 —— 周次只写在标题里（第1-16周），格子里只有课程名/教师/教室
变体 B：分块式 —— 两张表，左表标题「第1-8周」、右表标题「第9-16周」，格子里无周次
"""
from PIL import Image, ImageDraw, ImageFont
import os

BG = (255, 255, 255)
LINE = (200, 205, 215)
HEAD_BG = (238, 242, 250)
COURSE_FILL = (226, 238, 255)
COURSE_FILL2 = (255, 240, 214)
COURSE_EDGE = (108, 152, 226)
TEXT = (34, 38, 48)
SUB = (110, 118, 132)

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
F_SUB = font(20)
F_HEAD = font(20)
F_SLOT = font(17)
F_NAME = font(18)
F_SUB2 = font(14)


def draw_base(w, h):
    img = Image.new('RGB', (w, h), BG)
    return img, ImageDraw.Draw(img)


def draw_table(d, x0, y0, col_w, row_h, days, slots, day_names, slot_labels,
               courses, fill=COURSE_FILL, weeks_text=None):
    """画一张表格。courses: (day_idx, start_slot, span, name, teacher, room)"""
    # 表头行
    head_y = y0 - row_h * 0.7
    d.rectangle([x0, head_y, x0 + col_w, y0], fill=HEAD_BG, outline=LINE)
    d.text((x0 + 10, head_y + 8), '节次', font=F_HEAD, fill=TEXT)
    for i, dn in enumerate(day_names):
        cx = x0 + col_w * (i + 1)
        d.rectangle([cx, head_y, cx + col_w, y0], fill=HEAD_BG, outline=LINE)
        d.text((cx + 12, head_y + 8), dn, font=F_HEAD, fill=TEXT)
    # 网格
    for r in range(slots):
        ry = y0 + row_h * r
        d.rectangle([x0, ry, x0 + col_w, ry + row_h], fill=(250, 251, 253), outline=LINE)
        d.text((x0 + 10, ry + 10), slot_labels[r][0], font=F_SLOT, fill=TEXT)
        d.text((x0 + 10, ry + 32), slot_labels[r][1], font=F_SUB2, fill=SUB)
        for c in range(days):
            cx = x0 + col_w * (c + 1)
            d.rectangle([cx, ry, cx + col_w, ry + row_h], outline=LINE)
    # 课程块（注意：不写周次）
    for (day, sstart, span, name, teacher, room) in courses:
        cx = x0 + col_w * (day + 1)
        cy = y0 + row_h * sstart
        ch = row_h * span
        pad = 5
        d.rounded_rectangle([cx + pad, cy + pad, cx + col_w - pad, cy + ch - pad],
                            radius=8, fill=fill, outline=COURSE_EDGE, width=2)
        tx = cx + pad + 10
        d.text((tx, cy + pad + 10), name, font=F_NAME, fill=TEXT)
        d.text((tx, cy + pad + 36), teacher, font=F_SUB2, fill=SUB)
        d.text((tx, cy + pad + 56), room, font=F_SUB2, fill=SUB)


SLOTS = ['第1节', '第2节', '第3节', '第4节', '第5节', '第6节']
TIMES = ['08:00', '10:05', '14:00', '16:05', '19:00', '20:55']
SLOT_LABELS = list(zip(SLOTS, TIMES))
DAYS5 = ['周一', '周二', '周三', '周四', '周五']

# ---------------- 变体 A：标题式 ----------------
W, H = 1200, 950
img, d = draw_base(W, H)
x0, y0 = 40, 220
col_w = (W - 2 * x0) / 6
row_h = (H - y0 - 50) / 6
d.text((x0, 40), '计算机科学与技术 2 班 课表', font=F_TITLE, fill=TEXT)
# 周次只出现在标题行（这是关键：格子里没有周次）
d.text((x0, 92), '适用周次：第 1-16 周', font=F_SUB, fill=(190, 80, 60))
courses_a = [
    (0, 0, 2, '高等数学', '张伟', 'A101'),
    (0, 2, 1, '大学英语', '李娜', 'B203'),
    (1, 1, 2, '数据结构', '王强', '机房301'),
    (2, 0, 1, '线性代数', '刘敏', 'A205'),
    (3, 0, 2, '操作系统', '赵磊', 'A308'),
    (4, 2, 2, '软件工程', '周芳', 'B105'),
]
draw_table(d, x0, y0, col_w, row_h, 5, 6, DAYS5, SLOT_LABELS, courses_a)
out_a = os.path.join(OUT_DIR, 'timetable_header_weeks.png')
img.save(out_a, 'PNG')
print('saved A:', out_a, os.path.getsize(out_a))

# ---------------- 变体 B：分块式 ----------------
W2, H2 = 1500, 950
img2, d2 = draw_base(W2, H2)
d2.text((40, 34), '2026 秋季学期 电子信息工程 1 班 课表', font=F_TITLE, fill=TEXT)
gap = 40
tbl_w = (W2 - 80 - gap) / 2
col_w2 = tbl_w / 6
y0b = 230
row_h2 = (H2 - y0b - 50) / 6

d2.text((40, 100), '第 1-8 周', font=F_SUB, fill=(30, 110, 60))
d2.text((40 + tbl_w + gap, 100), '第 9-16 周', font=F_SUB, fill=(180, 70, 40))

courses_b1 = [
    (0, 0, 2, '高等数学', '张伟', 'A101'),
    (1, 1, 2, '数据结构', '王强', '机房301'),
    (2, 0, 2, '操作系统', '赵磊', 'A308'),
    (4, 3, 1, '体育', '孙涛', '田径场'),
]
courses_b2 = [
    (0, 2, 1, '大学英语', '李娜', 'B203'),
    (1, 3, 2, '计算机网络', '陈军', 'B302'),
    (2, 2, 1, '线性代数', '刘敏', 'A205'),
    (3, 0, 2, '软件工程', '周芳', 'B105'),
]
draw_table(d2, 40, y0b, col_w2, row_h2, 5, 6, DAYS5, SLOT_LABELS, courses_b1,
           fill=COURSE_FILL)
draw_table(d2, 40 + tbl_w + gap, y0b, col_w2, row_h2, 5, 6, DAYS5, SLOT_LABELS,
           courses_b2, fill=COURSE_FILL2)
out_b = os.path.join(OUT_DIR, 'timetable_block_weeks.png')
img2.save(out_b, 'PNG')
print('saved B:', out_b, os.path.getsize(out_b))
