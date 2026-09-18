# -*- coding: utf-8 -*-
"""
petformat.py —— 桌面宠物固定规格常量（与《01-桌面宠物制作流程与交付规范》第2/3/4节一致）。

本模块是 scripts/ 下各脚本的唯一规格来源。改规格请改这里，不要在各脚本里散写数字。
只包含“固定的、不随角色变化的”技术参数；角色名称/动作/画风等开放内容不在这里。
"""

# —— 图集固定规格（第2节）——
ATLAS_WIDTH = 1536
ATLAS_HEIGHT = 2288
COLS = 8
ROWS = 11
FRAME_W = 192
FRAME_H = 208
SPRITE_VERSION = 2

# —— 9 个标准状态：行号、状态名、帧数、时长(ms)、标签、含义（第3节）——
# 顺序即行序，固定，不可调换。
STATE_ROWS = [
    # (row, state, frames, duration_ms, label, purpose)
    (0, "idle",          6, 160, "待机",     "放松且有生命感"),
    (1, "running-right", 8, 120, "向右移动", "明确朝画面右侧移动"),
    (2, "running-left",  8, 120, "向左移动", "明确朝画面左侧移动"),
    (3, "waving",        4, 160, "打招呼",   "欢迎、回应或完成"),
    (4, "jumping",       5, 150, "跳跃/启动", "启动时的上扬、跃起与回落"),
    (5, "failed",        8, 150, "失败",     "清楚表达受挫或困惑"),
    (6, "waiting",       6, 170, "等待",     "等待回应，区别于放松待机"),
    (7, "running",       6, 130, "工作",     "专注、持续工作，不作为左右移动"),
    (8, "review",        6, 170, "审查",     "观察、检查和判断"),
]

# —— 16 方向（第4节）：角度顺序固定，前8个在第9行，后8个在第10行 ——
DIRECTION_ANGLES = [
    0.0, 22.5, 45.0, 67.5, 90.0, 112.5, 135.0, 157.5,
    180.0, 202.5, 225.0, 247.5, 270.0, 292.5, 315.0, 337.5,
]
DIRECTION_DURATION_MS = 120

# —— 每行有效帧数（含两行方向行；第2节）——
FRAMES_PER_ROW = [s[2] for s in STATE_ROWS] + [8, 8]  # -> [6,8,8,4,5,8,6,6,6,8,8]

VALID_CELLS = sum(FRAMES_PER_ROW)   # 73
TRANSPARENT_CELLS = COLS * ROWS - VALID_CELLS  # 15


def state_of_row(row: int):
    """返回第 row 行对应的 (state, frames, duration_ms, label, purpose)，方向行返回 None 之外的约定。"""
    if row < 9:
        _, state, frames, dur, label, purpose = STATE_ROWS[row]
        return {"state": state, "frames": frames, "duration_ms": dur,
                "label": label, "purpose": purpose}
    return None


def angle_filename(angle: float) -> str:
    """方向帧文件名：0.png, 22.5.png, ..., 337.5.png"""
    return "%g.png" % angle


def direction_of_cell(row: int, col: int):
    """第 9/10 行第 col 列对应的角度；标准状态行返回 None。"""
    if row < 9:
        return None
    idx = (row - 9) * 8 + col
    return DIRECTION_ANGLES[idx]


def pet_json_states():
    """生成 pet.json 里 states 对象（9 个标准状态，数值/行号/时长固定）。"""
    states = {}
    for row, state, frames, dur, label, purpose in STATE_ROWS:
        states[state] = {
            "label": label,
            "purpose": purpose,
            "row": row,
            "frames": frames,
            "frameCount": frames,
            "durationMs": dur,
        }
    return states


def pet_json_animations():
    """生成 pet.json 里 animations 对象（两行视线方向）。"""
    return {
        "look-row-9": {
            "label": "视线方向第一组",
            "purpose": "000到157.5度连续视线",
            "row": 9,
            "frames": 8,
            "frameCount": 8,
            "durationMs": DIRECTION_DURATION_MS,
        },
        "look-row-10": {
            "label": "视线方向第二组",
            "purpose": "180到337.5度连续视线",
            "row": 10,
            "frames": 8,
            "frameCount": 8,
            "durationMs": DIRECTION_DURATION_MS,
        },
    }
