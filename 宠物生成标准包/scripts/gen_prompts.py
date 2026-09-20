# -*- coding: utf-8 -*-
"""
gen_prompts.py —— 固定 pose 模板（0 LLM）。

这里只有"动作"描述，身份信息全部来自参考图，不写进文字。
所有字符串恒定、不随角色变化；generate.py 只把「参考图 + 这些固定文本」发给图生图 API。
因此整个生成流程不产生任何 LLM token、不做任何 LLM 决策。
"""

# 常量后缀：所有 prompt 尾部统一追加
STYLE_SUFFIX = "透明背景，全身完整入镜，无文字，无水印，无网格，无速度线"

# 9 个状态：state -> 固定动作描述（帧数在 petformat.STATE_ROWS 里固定）
STATE_ACTIONS = {
    "idle": "保持角色外观完全不变，全身站立待机，轻微上下呼吸起伏，放松的表情，眼睛半闭",
    "running-right": "保持角色外观完全不变，朝画面右侧奔跑，身体前倾，四肢交替迈步",
    "running-left": "保持角色外观完全不变，朝画面左侧奔跑，身体前倾，四肢交替迈步",
    "waving": "保持角色外观完全不变，开心地挥手打招呼，一只爪子举起左右摆动，微笑",
    "jumping": "保持角色外观完全不变，向上跳跃，起跳、腾空、落地三个阶段，四肢舒展",
    "failed": "保持角色外观完全不变，失败受挫的表情，耷拉脑袋、耳朵下垂，冒汗",
    "waiting": "保持角色外观完全不变，等待中的姿态，抬头张望或轻轻左右摇晃，期待的表情",
    "running": "保持角色外观完全不变，专注工作的姿态，快速敲击或埋头忙碌，认真的表情",
    "review": "保持角色外观完全不变，审查检查的姿态，一手托腮或凑近观察，思考判断的表情",
}


def state_frame_prompt(state, frame_idx, total):
    """逐帧模式：固定动作 + 第 i/N 帧（数字由脚本按循环序号算出，非 LLM 决策）。"""
    return "%s，本动作共 %d 帧，这是第 %d 帧，%s" % (
        STATE_ACTIONS[state], total, frame_idx + 1, STYLE_SUFFIX)


def state_strip_prompt(state, total):
    """条带模式：一次出一条 N 帧横向序列，脚本切格。"""
    return "%s，生成 %d 帧横向动画序列，等距排列，每帧完整独立，%s" % (
        STATE_ACTIONS[state], total, STYLE_SUFFIX)


def direction_prompt(angle):
    """单个视线方向（固定角度）。"""
    return ("保持角色外观完全不变，全身正面站立，视线/脸朝向 %.1f° 方向"
            "（0°=正上，90°=正右，180°=正下，270°=正左），身体朝向保持不变，%s") % (
        angle, STYLE_SUFFIX)


def direction_strip_prompt(angles):
    """条带模式：一条横向序列含 8 个连续视线方向。"""
    seq = "、".join("%g°" % a for a in angles)
    return ("保持角色外观完全不变，全身正面站立，生成 8 帧横向序列，"
            "视线/脸朝向依次为 %s，身体朝向保持不变，%s") % (seq, STYLE_SUFFIX)
