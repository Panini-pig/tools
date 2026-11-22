"""把一整段群消息切成一条条独立的家教单。

家教群里的模板五花八门，空行并不可靠。这里的策略是「先认订单起点」：

1. 显式起点：单号/编号/家教编号，以及「南京XXHH#新单」「WY南京261121003F」这类模板号；
2. 标题起点：``#加急``、``#机构单``、``南京XXHH#新单`` 这类标题行。它们出现在下一条单号
   **之前**，语义上属于下一条。旧版把它们粘在上一条末尾，导致「加急 / 长期 / 机构单」
   标签错配到邻单；
3. 兜底起点：空行后面紧跟「地址 / ＃某区」且上一块已经攒够了字段行（无编号模板）。

切口只在「当前块已经有内容」时才生效，避免把一条单切成两半。
"""
from __future__ import annotations

import re

from .text import QQ_PREFIX_RE, normalize_text

QQ_LINE_RE = QQ_PREFIX_RE

SEPARATOR_RE = re.compile(r"^[\s\-=—–_~·、*★☆•]{3,}$")

# 显式单号/编号行
EXPLICIT_START_RE = re.compile(
    r"^\s*[^\w\u4e00-\u9fff]{0,8}(?:"
    r"(?:【(?:南京)?家教(?:单)?[^\n]{0,12}\d{3,}】|南京家教[^\n]{0,12}\d{3,})|"
    r"(?:家教编号|【?编号】?|单号|订单号)\s*】?\s*[:：]?\s*[^\n]{0,12}\d{3,}|"
    r"【?\d{5,}】?(?:\s*(?:号信息|长期|老家长))?|"
    r".{0,6}(?:南京|NJ|Nj|nj)[A-Za-z\u4e00-\u9fff]{0,10}\s*[A-Za-z]{0,4}\s*\d{3,}[^\n]{0,30}|"
    r"[A-Z]\d{5,}(?:\s*[:：【])?|"
    r"#\s*[^\n]{0,12}(?:NJ|Nj|nj)[A-Za-z]*\d{4,}"
    r")",
    re.I,
)
# 标题行：以 # 开头，或「南京XXHH#新单」「某某#新单」这类机构模板头
HEADER_START_RE = re.compile(
    r"^\s*(?:"
    r"#{1,2}\s*[^\d\s#]|"
    r"南京[\u4e00-\u9fffA-Za-z]{0,8}#|"
    r"[^\d\s#]{1,8}#\s*新单|"
    r".{0,10}#\s*(?:加急|长期|重新找|改要求|新单|急招|急单)"
    r")"
)
LOCATION_START_RE = re.compile(
    r"^\s*(?:[#＃]\s*(?:南京)?(?:线上|[\u4e00-\u9fff]{2,8}区)|"
    r"(?:【?(?:学员|家教|上课|联系)?地址】?|地点)\s*(?:[:：]|//))"
)
FIELD_PATTERNS = (
    r"(?:年级|学员情况|学生)",
    r"(?:科目|辅导|作辅|陪读)",
    r"(?:时间|次数|频次)",
    r"(?:薪资|薪酬|课酬|报酬|薪水)",
    r"(?:要求|教员|老师)",
)


def _has_body(lines: list[str]) -> bool:
    """当前块里是否已经有「正文」，而不只是标题行、单号行和 QQ 昵称。"""
    for line in lines:
        line = line.strip()
        if len(line) < 12:
            continue
        if line.startswith("#") or HEADER_START_RE.match(line):
            continue
        if QQ_LINE_RE.match(line):
            continue
        if re.match(r"^(?:家教编号|订单编号|订单号|老师编号|南京家教|单号|编号)\s*[:：]", line):
            continue
        return True
    return False


def field_score(value: str) -> int:
    return sum(bool(re.search(pattern, value)) for pattern in FIELD_PATTERNS)


def _looks_like_order(text: str, start: int) -> bool:
    """标题行之后两三行内是否出现单号或地址，用来确认「这是下一条的开头」。"""
    tail = text[start:start + 220]
    return bool(
        re.search(r"(?:单号|编号|家教编号)\s*[:：]?\s*[^\n]{0,12}\d{3,}", tail)
        or re.search(r"^\s*(?:地址|联系地址|上课地址|【地址】)\s*[:：】]", tail, re.M)
        or LOCATION_START_RE.search(tail)
    )


def split_orders(raw: str) -> list[str]:
    # 复制时列宽可能被压成超长空格，把下一单的单号挤到上一行末尾；
    # 这一步必须在 normalize_text 折叠空格之前做。
    prepared = str(raw or "").replace("\r\n", "\n").replace("\r", "\n")
    prepared = re.sub(r"[ \t]{4,}(?=(?:家教编号|编号)\s*[:：])", "\n", prepared)
    text = normalize_text(prepared)
    if not text:
        return []

    chunks: list[str] = []
    current: list[str] = []
    blank_before = True

    def flush() -> None:
        chunk = "\n".join(current).strip()
        if len(chunk) >= 12:
            chunks.append(chunk)
        current.clear()

    lines = text.split("\n")
    offsets: list[int] = []
    cursor = 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line) + 1

    for index, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            if current and current[-1] != "":
                current.append("")
            blank_before = True
            continue
        if SEPARATOR_RE.match(line):
            flush()
            blank_before = True
            continue

        current_text = "\n".join(current)
        score = field_score(current_text)
        body = _has_body(current)
        is_explicit = bool(EXPLICIT_START_RE.match(line))
        is_header = (
            bool(HEADER_START_RE.match(line))
            and _looks_like_order(text, offsets[index] + len(raw_line))
        )
        is_location = blank_before and bool(LOCATION_START_RE.match(line)) and (score >= 3 or body)

        if current and (score >= 2 or body):
            if is_explicit or is_header or is_location:
                flush()

        current.append(line)
        blank_before = False

    flush()
    return chunks or [text]
