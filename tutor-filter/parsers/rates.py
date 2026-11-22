"""价格解析：把「120-130/h」「200-240/2h」「3000-3200元/月」统一折算成元/小时。

旧解析器只会抓「数字 + /h」，于是：
- ``120-130/h`` 只抓到 130（区间丢了）
- ``200-240/2h`` 抓到 240（还当成时薪，高了一倍）
- ``60-80元/2h`` 和 ``110-120/h`` 混在一起排序，完全没法比较

现在统一输出三层：
- ``rate_min/rate_max/rate_unit``  原文口径
- ``hourly_min/hourly_max``        折算后的元/小时（用于筛选和排序）
- ``hourly_estimated``             是否由「元/次、元/天、元/月」估算而来
"""
from __future__ import annotations

import re

from .text import clip

NUM = r"\d+(?:\.\d+)?"

RATE_RE = re.compile(
    rf"(?P<lo>{NUM})\s*(?:元|块)?\s*"
    rf"(?:[-~—–至到]\s*(?P<hi>{NUM})\s*(?:元|块)?\s*)?"
    r"(?:"
    r"/\s*(?P<per>\d+(?:\.\d+)?)?\s*(?P<unit>h|小时|时|节|次|天|月|周)"
    r"|(?:一|每)\s*(?P<unit2>小时|时|天|周|月|次)"
    r"|(?P<unit3>小时|时|h)(?![刻间])"
    r")",
    re.I,
)
# 「1.5小时150」这类先写时长、再写价格的写法
DURATION_PRICE_RE = re.compile(
    r"(?P<per>\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h)\s*(?:收费|价格|费用)?\s*(?P<price>\d{2,4})(?!\d)",
    re.I,
)

UNIT_KIND = {
    "h": "hour", "小时": "hour", "时": "hour",
    "节": "lesson", "次": "lesson",
    "天": "day", "周": "week", "月": "month",
}
UNIT_LABEL = {
    ("hour", 1): "元/小时", ("day", 1): "元/天", ("lesson", 1): "元/次",
    ("week", 1): "元/周", ("month", 1): "元/月",
}
# 这些词后面跟着的「时」是课时/时长，不是价格
DURATION_PREFIX = ("课时", "小时", "个时")
QUOTE_WORDS = ("带简历报价", "简历报价", "自报价", "面议", "报价", "待定", "另算", "详谈")


def _kind(unit: str) -> str:
    return UNIT_KIND.get(unit, "")


def _label(kind: str, per: float) -> str:
    if kind == "hour" and per and per != 1:
        per_text = ("%g" % per)
        return f"元/{per_text}h"
    return UNIT_LABEL.get((kind, 1), "元/小时")


def parse_rates(text: str, hours_hint: float | None = None) -> dict:
    """hours_hint 是「一次课多少小时」，用于把元/次、元/天折算成时薪。"""
    text = text or ""
    buckets: dict[str, list[tuple[float, float, float]]] = {}
    for match in RATE_RE.finditer(text):
        lo = float(match.group("lo"))
        hi = float(match.group("hi") or lo)
        per = float(match.group("per") or 1)
        unit = match.group("unit") or match.group("unit2") or match.group("unit3") or ""
        unit = unit.lower()
        kind = _kind(unit)
        if not kind:
            continue
        # 「每周5次」「一次2小时」「共30课时」这类不是价格
        before = text[max(0, match.start() - 6):match.start()]
        if re.search(r"(?:一次|每次|共|一共|约|大概|每周|一周|每)\s*$", before):
            if kind != "hour" or lo < 20:
                continue
        if text[match.start():match.end()].startswith("课时"):
            continue
        if lo < 15 or lo > 5000:
            continue
        if hi < 15 or hi > 5000:
            hi = lo
        if kind == "hour" and unit in ("小时", "时") and not match.group("per"):
            # 裸的「110-120小时」要像时薪；「2小时」已经在上面的边界里被滤掉了
            if lo < 15:
                continue
        buckets.setdefault(kind, []).append((lo, hi, per))

    for match in DURATION_PRICE_RE.finditer(text):
        per = float(match.group("per"))
        price = float(match.group("price"))
        if not (0.5 <= per <= 8) or price < 15:
            continue
        buckets.setdefault("hour", []).append((price, price, per))

    note = ""
    if not buckets:
        if any(word in text for word in QUOTE_WORDS):
            note = "带简历报价"
        return {
            "rate_min": None, "rate_max": None, "rate_unit": "",
            "hourly_min": None, "hourly_max": None, "hourly_estimated": 0,
            "price_note": note,
        }

    for kind in ("hour", "lesson", "day", "week", "month"):
        if kind not in buckets:
            continue
        values = buckets[kind]
        rate_min = min(value[0] / value[2] for value in values)
        rate_max = max(value[1] / value[2] for value in values)
        per = values[0][2]
        estimated = 0

        if kind == "hour":
            hourly_min, hourly_max = rate_min, rate_max
        elif kind in ("lesson", "day") and hours_hint:
            hourly_min = rate_min / hours_hint
            hourly_max = rate_max / hours_hint
            estimated = 1
        elif kind == "week" and hours_hint:
            hourly_min = rate_min / (hours_hint * max(1, len(values)))
            hourly_max = rate_max / (hours_hint * max(1, len(values)))
            estimated = 1
        elif kind == "month" and hours_hint:
            weekly = _monthly_denominator(text) or 0
            if weekly:
                hourly_min = rate_min / (weekly * hours_hint)
                hourly_max = rate_max / (weekly * hours_hint)
                estimated = 1
            else:
                return {
                    "rate_min": round(rate_min, 1), "rate_max": round(rate_max, 1),
                    "rate_unit": _label(kind, per),
                    "hourly_min": None, "hourly_max": None, "hourly_estimated": 0,
                    "price_note": "月薪单，缺次数与时长，未折算时薪",
                }
        else:
            return {
                "rate_min": round(rate_min, 1), "rate_max": round(rate_max, 1),
                "rate_unit": _label(kind, per),
                "hourly_min": None, "hourly_max": None, "hourly_estimated": 0,
                "price_note": "价格单位不是小时，且缺单次时长",
            }

        return {
            "rate_min": round(rate_min, 1), "rate_max": round(rate_max, 1),
            "rate_unit": _label(kind, per),
            "hourly_min": round(hourly_min, 1),
            "hourly_max": round(hourly_max, 1),
            "hourly_estimated": estimated,
            "price_note": note,
        }

    return {
        "rate_min": None, "rate_max": None, "rate_unit": "",
        "hourly_min": None, "hourly_max": None, "hourly_estimated": 0,
        "price_note": note,
    }


def _monthly_denominator(text: str) -> float:
    """月薪折算时薪用：每周次数（从「一周6次」这类文本里读）。"""
    from .schedule import parse_schedule

    schedule = parse_schedule(text)
    return float(schedule.get("frequency_per_week") or 0)


def describe_rate(item: dict) -> str:
    """给卡片用的一行价格描述。"""
    hourly_min, hourly_max = item.get("hourly_min"), item.get("hourly_max")
    if hourly_min is not None:
        if hourly_max is not None and hourly_max != hourly_min:
            return f"¥{hourly_min:g}–{hourly_max:g}/h"
        return f"¥{hourly_min:g}/h"
    if item.get("rate_min") is not None:
        unit = item.get("rate_unit") or "元"
        if item.get("rate_max") is not None and item["rate_max"] != item["rate_min"]:
            return f"¥{item['rate_min']:g}–{item['rate_max']:g} {unit}"
        return f"¥{item['rate_min']:g} {unit}"
    return item.get("price_note") or "价格待确认"


def rate_evidence(text: str) -> str:
    match = RATE_RE.search(text or "")
    return clip(match.group(0), 40) if match else ""
