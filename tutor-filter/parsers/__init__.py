"""家教单解析（纯规则）。

对外只需要三个入口：

>>> from parsers import split_orders, parse_order
>>> chunks = split_orders(raw_text)
>>> item = parse_order(chunks[0])
"""
from __future__ import annotations

from .fields import (
    NANJING_DISTRICTS,
    parse_district,
    parse_grade,
    parse_mode,
    parse_published,
    parse_subjects,
    subjects_in as _subjects_in,
)
from .labels import parse_segments
from .order import CORE_FIELDS, extract_location_text, parse_order
from .rates import parse_rates
from .schedule import parse_schedule
from .split import split_orders

__all__ = [
    "split_orders",
    "parse_order",
    "parse_segments",
    "parse_rates",
    "parse_schedule",
    "parse_grade",
    "parse_subjects",
    "parse_mode",
    "parse_district",
    "parse_published",
    "extract_location_text",
    "CORE_FIELDS",
    "NANJING_DISTRICTS",
    "_subjects_in",
]


def parse_orders(text: str) -> list[dict]:
    """拆分 + 解析，一次到位。"""
    return [parse_order(chunk) for chunk in split_orders(text)]
