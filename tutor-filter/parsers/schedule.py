"""排课解析：把「一周2次」「周六下午」「一次两小时」分开。

旧解析器最大的污染源在这里：它用一条正则同时找「周X」，于是
``一周一次`` 被读成「周一」、``一周2次`` 被读成「周2」。
39 条案例里几乎每条都被塞进一个假的星期。

现在的顺序是：先抽频次并从文本里遮掉，再找星期，最后算单次时长。
"""
from __future__ import annotations

import re

from .text import clip, unique

CN = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
WEEKDAY_CHAR = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7,
                "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7}
SLOT_WORDS = ("凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "夜里", "全天")

FREQ_PATTERNS = (
    r"(?:一周|每周|每星期|1周|一个?星期)\s*([一二两三四五六1-6])\s*(?:[-~至到]\s*[一二两三四五六1-6])?\s*(?:次|节)",
    r"([1-7])\s*次\s*/\s*(?:周|星期)",
    r"(?:周内|周中)\s*([一二两三四五六1-6])\s*次",
    r"(?:周末|周中|周内|晚上|寒假|暑假)\s*([一二两三四五六1-6])\s*(?:次|节)",
    r"(?:周|星期)[一二三四五六日天1-7]\s*([一二两三四五六1-6])\s*次",
)
WEEKDAY_RANGE_RE = re.compile(
    r"(?:周|星期|礼拜)\s*([一二三四五六日天1-7])\s*(?:到|至|-|~)\s*(?:周|星期|礼拜)?\s*([一二三四五六日天1-7])"
)
WEEKDAY_RE = re.compile(r"(?:周|星期|礼拜)\s*([一二三四五六日天1-7])")
# 周13 / 周三四五 / 周一三五 这类紧凑写法
WEEKDAY_COMPACT_RE = re.compile(r"(?:周|星期)\s*([一二三四五六日天1-7]{2,4})(?![0-9])")
EXCLUDE_WORDS = ("除了", "除", "避开", "不要", "不能", "没法", "不行")
CN_OR_NUM = r"([0-9一二两三四五六七八九十\.]+)"
DURATION_ONCE_RE = re.compile(
    rf"(?:一次|每次|每节|单次)\s*(?:课)?\s*{CN_OR_NUM}\s*(?:个)?\s*(?:小时|h|课时)", re.I
)
DURATION_RANGE_RE = re.compile(
    rf"(?:一次|每次|每节|单次)\s*{CN_OR_NUM}\s*[-~至到]\s*{CN_OR_NUM}\s*(?:个)?\s*小时", re.I
)
DURATION_HALF_RE = re.compile(r"(?:一次|每次|单次)\s*([一二两三四五六1-6])\s*个?\s*半\s*小时")
DURATION_PER_RE = re.compile(rf"{CN_OR_NUM}\s*(?:h|小时)\s*/\s*次", re.I)
DURATION_LOOSE_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(?:h|小时|钟头)(?:左右|上下)?", re.I)
PER_N_HOURS_RE = re.compile(r"/\s*(\d+(?:\.\d+)?)\s*(?:h|小时)", re.I)
HOURS_RANGE_RE = re.compile(
    r"(?<![\d.])(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h)(?![a-z/])", re.I
)
TIME_RANGE_RE = re.compile(
    r"(?P<sh>[0-9一二三四五六七八九十]{1,2})\s*[:：点.]\s*(?P<sm>\d{1,2}|半)?"
    r"\s*(?:到|至|-|~)\s*(?P<eh>[0-9一二三四五六七八九十]{1,2})\s*[:：点.]?\s*(?P<em>\d{1,2}|半)?"
)


def _cn(value: str) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    if value.isdigit():
        return int(value)
    if value == "十":
        return 10
    if value.startswith("十"):
        rest = CN.get(value[1:])
        return 10 + rest if rest is not None else None
    if len(value) == 1:
        return CN.get(value)
    return None


def _minutes(part: str) -> int:
    if not part:
        return 0
    if part == "半":
        return 30
    if part.isdigit():
        return int(part)
    return 0


def _mask(text: str, pattern: str) -> str:
    return re.sub(pattern, lambda m: " " * len(m.group(0)), text)


def _frequency(text: str) -> tuple[float | None, float | None, str]:
    for pattern in FREQ_PATTERNS:
        match = re.search(pattern, text)
        if not match:
            continue
        value = _cn(match.group(1))
        if not value:
            continue
        if match.group(0) and re.search(r"[-~至到]", match.group(0)):
            upper = re.search(r"[-~至到]\s*([一二两三四五六1-6])", match.group(0))
            if upper:
                high = _cn(upper.group(1)) or value
                return float(max(value, high)), float(min(value, high)), match.group(0)
        return float(value), float(value), match.group(0)
    return None, None, ""


def _weekdays(text: str) -> tuple[list[str], bool, list[str]]:
    """返回 (星期列表, 是否来自连续区间, 被「除了/避开」排除的星期)。"""
    found: list[int] = []
    excluded: list[int] = []
    range_expanded = False

    for segment in re.split(r"[，,。；;、\n]", text):
        if not segment.strip():
            continue
        is_excluded = any(word in segment for word in EXCLUDE_WORDS)

        for match in WEEKDAY_RANGE_RE.finditer(segment):
            start = WEEKDAY_CHAR.get(match.group(1))
            end = WEEKDAY_CHAR.get(match.group(2))
            if not start or not end:
                continue
            span = list(range(start, end + 1)) if start <= end else list(range(start, 8)) + list(range(1, end + 1))
            if is_excluded:
                excluded.extend(span)
                continue
            found.extend(span)
            if len(span) >= 3:
                range_expanded = True

        stripped = WEEKDAY_RANGE_RE.sub(" ", segment)

        if not is_excluded:
            pieces: list[str] = []
            last = 0
            for match in WEEKDAY_COMPACT_RE.finditer(stripped):
                tail = stripped[match.end():match.end() + 1]
                if tail and tail in "-~到至:.：点0123456789次节个课":
                    continue      # 「周六一次」「周日1-4」里的字不是星期组合
                pieces.append(stripped[last:match.start()])
                pieces.append(" " * len(match.group(0)))
                last = match.end()
                for char in match.group(1):
                    number = WEEKDAY_CHAR.get(char)
                    if number:
                        found.append(number)
            pieces.append(stripped[last:])
            stripped = "".join(pieces)

        for match in WEEKDAY_RE.finditer(stripped):
            number = WEEKDAY_CHAR.get(match.group(1))
            if not number:
                continue
            if is_excluded:
                excluded.append(number)
                continue
            found.append(number)

    ordered = unique([WEEKDAYS[number - 1] for number in found])
    excluded_labels = unique([WEEKDAYS[number - 1] for number in excluded if number not in found])
    return ordered, range_expanded, excluded_labels


def _to_float(value: str) -> float | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    if value in CN:
        return float(CN[value])
    if value.startswith("十"):
        rest = CN.get(value[1:])
        return 10.0 + (rest or 0)
    return None


def _hours(text: str, duration_text: str) -> float | None:
    match = DURATION_ONCE_RE.search(text)
    if match:
        value = _to_float(match.group(1))
        if value:
            return value
    match = DURATION_PER_RE.search(text)
    if match:
        value = _to_float(match.group(1))
        if value:
            return value
    match = DURATION_RANGE_RE.search(text)
    if match:
        low = _to_float(match.group(1))
        if low:
            return low
    match = DURATION_HALF_RE.search(text)
    if match:
        value = _to_float(match.group(1))
        if value:
            return value + 0.5
    match = HOURS_RANGE_RE.search(text)
    if match:
        low = float(match.group(1))
        if 0.5 <= low <= 8:
            return low
    match = TIME_RANGE_RE.search(text)
    if match:
        start_hour = _cn(match.group("sh"))
        end_hour = _cn(match.group("eh"))
        if start_hour is not None and end_hour is not None:
            start = start_hour * 60 + _minutes(match.group("sm"))
            end = end_hour * 60 + _minutes(match.group("em"))
            if end <= start:
                end += 12 * 60
            span = (end - start) / 60
            if 0.5 <= span <= 8:
                return round(span, 2)
    match = PER_N_HOURS_RE.search(duration_text)
    if match:
        return float(match.group(1))
    for match in DURATION_LOOSE_RE.finditer(text):
        value = float(match.group(1))
        if 0.5 <= value <= 8:
            return value
    return None


def _time_slot(text: str) -> str:
    for word in SLOT_WORDS:
        if word in text:
            return "上午" if word == "早上" else word
    return ""


def parse_schedule(schedule_text: str, extra_text: str = "") -> dict:
    """schedule_text 是【时间】标签的值，extra_text 用来补频次/时长线索。"""
    text = (schedule_text or "").strip()
    if not text:
        # 没有【时间】标签的模板（比如一行一条的群消息），用正文兜底
        text = (extra_text or "").strip()
    if not text:
        return {
            "frequency_per_week": None, "frequency_min": None, "weekdays": [],
            "time_slot": "", "time_text": "", "hours_per_lesson": None,
            "freq_derived": 0, "weekend": False, "excluded_weekdays": [],
            "frequency_text": "",
        }

    frequency, frequency_min, frequency_text = _frequency(text)
    if frequency is None and extra_text:
        frequency, frequency_min, frequency_text = _frequency(extra_text)

    # 先遮掉频次，避免「一周一次」被读成「周一」
    masked = _mask(text, r"(?:一周|每周|每星期|1周|周内)\s*[一二两三四五六1-6]\s*(?:[-~至到]\s*[一二两三四五六1-6])?\s*(?:次|节)")
    masked = _mask(masked, r"[1-7]\s*次\s*/\s*(?:周|星期)")
    weekdays, range_expanded, excluded_weekdays = _weekdays(masked)

    freq_derived = 0
    if frequency is None and range_expanded and len(weekdays) >= 3 and re.search(r"每次|每天|周内", text):
        frequency = float(len(weekdays))
        frequency_min = frequency
        freq_derived = 1
    if frequency is None and re.search(r"每天|每日", text):
        frequency = 7.0
        frequency_min = 7.0
        freq_derived = 1

    hours = _hours(text, schedule_text + "\n" + extra_text)

    return {
        "frequency_per_week": frequency,
        "frequency_min": frequency_min,
        "weekdays": weekdays,
        "time_slot": _time_slot(text),
        "time_text": clip(text, 60),
        "hours_per_lesson": hours,
        "freq_derived": freq_derived,
        "weekend": "周末" in text,
        "excluded_weekdays": excluded_weekdays,
        "frequency_text": frequency_text,
    }
