"""文本清洗与通用小工具。

家教群消息里混着 QQ 前缀（昵称 + 时间）、emoji、分隔线、小红书式话题标签，
还有全角标点。所有解析函数都先经过这里清洗，再交给各字段解析器。
"""
from __future__ import annotations

import re

EMOJI_RE = re.compile(
    "[\U0001f000-\U0001faff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u200d\u20e3]+"
)
# QQ/微信里用文字方括号表示的“表情”
NAMED_EMOJI_RE = re.compile(
    r"\[(?:烟花|合十|玫瑰|爱心|鼓掌|礼物|红包|微笑|开心|耶|强|赞|抱拳|握手|胜利|OK|ok|加油|月亮|太阳|调皮|呲牙|捂脸|流泪|偷笑|让我看看|666|机智|奸笑|呲牙笑|耶耶|庆祝|烟花\])\]"
)
QQ_PREFIX_RE = re.compile(
    r"^(?P<poster>.{1,24}?)\s*[:：]\s*"
    r"(?P<month>\d{1,2})-(?P<day>\d{1,2})\s+"
    r"(?P<hour>\d{1,2}):(?P<minute>\d{2})(?::(?P<second>\d{2}))?\s*$"
)
TAG_RE = re.compile(r"#\s*([^\s#]{1,24})")
SEPARATOR_RE = re.compile(r"^[\s\-=—–_~·、.。*★☆·•]+$")
FULLWIDTH = str.maketrans(
    "０１２３４５６７８９．：（）［］【】～　，；！？／＃",
    "0123456789.:()[][]~ ,;!?/#",
)
# 编号列表前缀：1、 1. （1） ① 等
LIST_PREFIX_RE = re.compile(r"^\s*(?:\d{1,2}\s*[、.．)）]|[（(]\s*\d{1,2}\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*")

CN_DIGITS = {
    "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
}
WEEKDAY_CHARS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7,
                 "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7}


def normalize_text(text: str) -> str:
    """统一换行、全角标点，去掉表情与行尾空白，保留换行结构。"""
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = text.translate(FULLWIDTH)
    text = NAMED_EMOJI_RE.sub(" ", text)
    text = EMOJI_RE.sub(" ", text)
    lines = []
    for raw in text.split("\n"):
        line = re.sub(r"[ \t\u00a0]+", " ", raw).strip()
        lines.append(line)
    return "\n".join(lines).strip()


def strip_qq_prefix(line: str) -> tuple[str, dict]:
    """识别「昵称: 11-21 22:42:22」这类 QQ 复制前缀，返回 (剩余内容, 元信息)。"""
    match = QQ_PREFIX_RE.match(line.strip())
    if not match:
        return line, {}
    meta = {
        "poster": match.group("poster").strip(" :："),
        "month": int(match.group("month")),
        "day": int(match.group("day")),
        "hour": int(match.group("hour")),
        "minute": int(match.group("minute")),
        "second": int(match.group("second") or 0),
    }
    return "", meta


def split_tags(line: str) -> list[str]:
    """抽出 #话题 形式的标签（#加急、#南大女老师、#机构单…）。"""
    return [value.strip() for value in TAG_RE.findall(line) if value.strip()]


def mask(text: str, pattern: str | re.Pattern, flags: int = 0) -> str:
    """把命中片段替换为等长空格，用于「先遮掉再找」的消歧。"""
    compiled = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern, flags)
    return compiled.sub(lambda match: " " * len(match.group(0)), text)


def to_int(value: str) -> int | None:
    """把「2 / 两 / 三 / 十」这类数字转成 int。"""
    value = (value or "").strip()
    if not value:
        return None
    if value.isdigit():
        return int(value)
    if value in CN_DIGITS:
        return CN_DIGITS[value]
    return None


def cn_number(value: str) -> float | None:
    """支持 半、两岁半、一点五 这类写法的最小数字解析。"""
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    if value in CN_DIGITS:
        return float(CN_DIGITS[value])
    return None


def clip(text: str, length: int = 120) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:length]


def first_group(pattern: str, text: str, flags: int = 0) -> str:
    match = re.search(pattern, text, flags)
    return match.group(1).strip() if match else ""


def unique(values) -> list[str]:
    seen: set[str] = set()
    result = []
    for value in values:
        value = str(value or "").strip()
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result
