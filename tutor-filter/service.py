"""浏览器端（Pyodide）解析服务。

和桌面版 app.py 的 import_text / prepare_item 保持同一口径：
规则来自 parsers/ 包，这里只负责切分、补 fingerprint、补默认值，
最后统一序列化成 JSON 字符串交给 JS。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime

from parsers import extract_location_text, parse_order, split_orders


def _prepare(chunk: str, source: str) -> dict:
    item = parse_order(chunk)
    item["fingerprint"] = hashlib.sha256(re.sub(r"\s+", "", chunk).encode("utf-8")).hexdigest()
    item["source"] = source
    item["source_text"] = chunk.strip()
    item["created_at"] = datetime.now().isoformat(timespec="seconds")
    item["location_text"] = (
        item.get("address") or extract_location_text(chunk) or item.get("district", "")
    )
    item.setdefault("location_name", "")
    item.setdefault("longitude", None)
    item.setdefault("latitude", None)
    item.setdefault("amap_poi_id", "")
    item.setdefault("location_status", "未识别")
    item.setdefault("location_confidence", 0)
    return item


def prepare_items(text: str, source: str) -> str:
    """整段粘贴文本 → 一条条结构化记录（JSON 字符串）。"""
    chunks = split_orders(text)
    return json.dumps(
        {"found": len(chunks), "items": [_prepare(chunk, source) for chunk in chunks]},
        ensure_ascii=False,
    )


def parse_one(text: str) -> str:
    """重解析单条原文（保留状态与坐标由 JS 侧处理）。"""
    return json.dumps(_prepare(text, "重解析"), ensure_ascii=False)


def extract_location(text: str) -> str:
    return extract_location_text(text or "")


def ping() -> str:
    return "ok"
