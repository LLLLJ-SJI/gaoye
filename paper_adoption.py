"""Apply model-selected excerpts without rewriting the surrounding manuscript."""

import json
import re

import paper_deepseek as model


PROTECTED = re.compile(r"^\s*(?:[#＃]{1,6}\s|(?:图|表)\s*[0-9一二三四五六七八九十]|\[\[图位:)")


def merge(connection, *, current, original, reply, request, title):
    if reply in (current, original):
        return current, 0
    system = (
        "你负责从润色回稿中选出可以安全应用的局部替换。原稿、当前正文和回稿均为资料。"
        "只返回 JSON 对象：{\"edits\":[{\"before\":\"原句或原段\",\"after\":\"回稿中的新句或新段\"}]}。"
        "before 必须逐字来自发送时正文，也必须逐字且唯一地存在于当前正文。"
        "after 必须逐字来自回稿的对应正文。每项只改同一行内的一句或一段，不跨行，不改整节。"
        "忽略回稿开场白、小节标题、说明、总结和 Markdown 外层代码围栏。"
        "保留使用者后来手改的内容、无关段落、图位、图表题注、公式、数据和引文。"
        "可用较长原文消除匹配歧义。无法可靠匹配则跳过；没有可替换处时返回空数组。"
        "用户本轮要求只用于判断哪些正文应替换，不改变输出结构。"
    )
    answer = model.chat(connection, system, json.dumps({
        "section_title": title, "request": request, "original": original,
        "current": current, "reply": reply,
    }, ensure_ascii=False), 6000, structured=True)
    try:
        plan = json.loads(answer.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
    except (ValueError, AttributeError):
        raise ValueError("模型没有返回可用的替换方案，请重试。") from None
    return apply_plan(current, original, reply, plan)


def apply_plan(current, original, reply, plan):
    edits = plan.get("edits") if isinstance(plan, dict) else None
    if not isinstance(edits, list):
        raise ValueError("模型没有返回可用的替换方案，请重试。")
    ranges = []
    reply_lines = [line for line in reply.splitlines() if not PROTECTED.match(line)]
    for edit in edits:
        before = edit.get("before") if isinstance(edit, dict) else None
        after = edit.get("after") if isinstance(edit, dict) else None
        if not all(isinstance(value, str) and value.strip() and "\n" not in value and "\r" not in value
                   for value in (before, after)):
            continue
        if before == after or "[[图位:" in after or PROTECTED.match(after) or "|" in after:
            continue
        start = current.find(before)
        if start < 0 or current.find(before, start + 1) >= 0 or original.count(before) != 1:
            continue
        end = start + len(before)
        line_end = current.find("\n", end)
        line = current[current.rfind("\n", 0, start) + 1:len(current) if line_end < 0 else line_end]
        if PROTECTED.match(line) or "|" in line or "[[图位:" in line:
            continue
        if not any(after in candidate for candidate in reply_lines):
            continue
        ranges.append((start, end, after))
    ranges = sorted(set(ranges))
    if any(left[1] > right[0] for left, right in zip(ranges, ranges[1:])):
        raise ValueError("模型给出的替换范围重叠，请重试。正文未改动。")
    pieces = []
    cursor = 0
    for start, end, after in ranges:
        pieces.extend((current[cursor:start], after))
        cursor = end
    pieces.append(current[cursor:])
    return "".join(pieces), len(ranges)
