"""把一条家教单拆成「标签 → 值」，并归入三个说话人槽位。

家教单几乎都是模板化的，字段前面都带标签（`【地址】`、`科目：`、`老师薪水：`）。
旧解析器直接在全文上跑正则，于是「女大学生」被当成年级、「线上授课」被当成授课方式、
「学员情况里的弱科」被当成辅导科目。这里先把标签认出来，再按「这条信息在说谁」分槽：

- ``order``   订单本身：单号、地址、时间、价格、科目
- ``student`` 学员：年级、性别、水平、弱科
- ``teacher`` 对老师的要求：学校、学历、性别、经验、能教什么

后面每个字段只在自己的槽位里取值，跨槽污染就从结构上消失了。
"""
from __future__ import annotations

import re

from .text import LIST_PREFIX_RE, clip, first_group, unique

# 标签别名 → 槽位键。顺序很重要：长的别名必须排在短的前面。
LABEL_ALIASES: list[tuple[tuple[str, ...], str]] = [
    (("家教编号", "订单编号", "订单号", "老师编号", "南京家教", "单号", "编号"), "order_no"),
    (("联系地址", "家庭地址", "上课地址", "学员地址", "辅导地点", "家教地址", "地址", "地点", "位置"), "address"),
    (("年级科目", "年级学科", "年级与科目"), "grade_subject"),
    (("年级性别", "学员年级", "年级"), "grade"),
    (("辅导科目", "科目年级", "科目", "辅导内容", "教学内容"), "subject"),
    (("课次及时间", "时间次数", "补习时间", "上课时间", "时间安排", "时长次数", "每周次数", "每次时长",
      "上课频次", "时间", "次数", "频次", "课时"), "schedule"),
    (("薪资待遇", "课费报酬", "老师薪酬", "提供时薪", "老师薪水", "课时费", "薪资", "薪酬", "课酬", "酬薪",
      "报酬", "薪水", "时薪", "价格", "费用", "工资"), "price"),
    (("老师的要求", "老师要求", "教员要求", "教师要求", "教员", "老师", "要求"), "teacher"),
    (("学员情况", "学生情况", "学员", "学生", "孩子", "信息"), "student"),
    (("成绩", "分数", "考试"), "score"),
    (("性别",), "gender"),
    (("联系方式", "微信", "电话", "手机", "联系"), "contact"),
    (("备注", "说明", "补充"), "note"),
]

BRACKET_LINE_RE = re.compile(r"^[【\[]\s*(?P<inner>[^】\]]{0,40})\s*[】\]]\s*(?P<rest>.*)$")
COLON_LINE_RE = re.compile(r"^(?P<label>[^\s:：]{1,10})\s*[:：]\s*(?P<value>.*)$")
# 没有标签、但本身就是一个单号/模板号的行
BARE_ORDER_NO_RE = re.compile(
    r"^(?:[A-Za-z]{0,4}\s*南京\s*[A-Za-z]{0,3}\d{5,}[A-Za-z]?"
    r"|南京\s*[A-Za-z]{0,2}\d{5,}[A-Za-z]?"
    r"|N\d{5,}|S\d{5,}|[A-Z]{1,4}\d{6,}[A-Za-z]?)$"
)
TEMPLATE_ORDER_NO_RE = re.compile(
    r"[A-Za-z]{0,4}\s*南京[\u4e00-\u9fa5]{0,6}\d{5,}[A-Za-z]?"
    r"|[A-Za-z]{0,4}\s*南京\s*[A-Za-z]{0,3}\d{5,}[A-Za-z]?"
    r"|南京\s*[A-Za-z]{0,2}\d{5,}[A-Za-z]?"
    r"|N\d{5,}|S\d{5,}|【\d{8}】|[A-Z]{2,4}\d{7,}"
)
BARE_ORDER_NO_TOKEN_RE = re.compile(r"^(?:[A-Za-z]{0,4}\d{5,}[A-Za-z]{0,3})$")
ORDER_NO_LABEL_RE = re.compile(
    r"(?:家教编号|订单编号|订单号|老师编号|南京家教|单号|编号)\s*】?\s*[:：]?\s*(.+)"
)
ORDER_NO_VALUE_RE = re.compile(
    r"[A-Za-z]{0,4}\s*南京\s*[A-Za-z]{0,3}\d{5,}[A-Za-z]?|[A-Za-z]{0,3}\d{3,12}[A-Za-z]{0,3}"
)


def _label_key(label: str) -> str:
    label = re.sub(r"\s+", "", label)
    for aliases, key in LABEL_ALIASES:
        for alias in aliases:
            if label == alias:
                return key
    # 允许「地址2」「备注1」这类带序号的写法，也允许标签里带少量修饰
    for aliases, key in LABEL_ALIASES:
        for alias in aliases:
            if label.startswith(alias) and len(label) <= len(alias) + 4:
                return key
    return ""


def _route(buckets: dict[str, list[str]], key: str, value: str) -> None:
    """把「标签值」放进对应槽位；年级和性别同时属于学员信息。"""
    if key == "grade_subject":
        buckets["grade"].append(value)
        buckets["subject"].append(value)
        return
    if key == "grade":
        buckets["grade"].append(value)
        buckets["student"].append(value)
        return
    if key == "gender":
        buckets["student"].append(value)
        buckets["gender"].append(value)
        return
    buckets[key].append(value)


def parse_segments(chunk: str) -> dict:
    """返回 {槽位: 文本}，另附 header / tags / free / published 等元信息。"""
    buckets: dict[str, list[str]] = {
        "order_no": [], "address": [], "grade": [], "subject": [], "schedule": [],
        "price": [], "teacher": [], "student": [], "note": [], "contact": [],
        "score": [], "gender": [], "header": [], "free": [],
    }
    tags: list[str] = []
    published: dict = {}

    for raw_line in chunk.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            buckets["header"].append(line)
            for tag in re.findall(r"#\s*([^\s#]{1,24})", line):
                tags.append(tag)
            continue
        if "#" in line:
            for tag in re.findall(r"#\s*([^\s#]{1,24})", line):
                tags.append(tag)
        stripped = LIST_PREFIX_RE.sub("", line)

        match = BRACKET_LINE_RE.match(stripped)
        if match:
            inner = match.group("inner").strip()
            rest = match.group("rest").strip().lstrip(":：").strip()
            parts = re.split(r"[\s:：]+", inner, maxsplit=1)
            label = parts[0] if parts else ""
            value = " ".join(part for part in [parts[1] if len(parts) > 1 else "", rest] if part).strip()
            key = _label_key(label)
            if key:
                _route(buckets, key, value)
                continue
            # 方括号里就是一个单号，例如【南京家教 77836549】
            found = re.search(r"[A-Za-z]{0,3}\d{4,12}[A-Za-z]?", inner)
            if found:
                buckets["order_no"].append(found.group(0))
                if rest:
                    buckets["free"].append(rest)
                continue
            buckets["free"].append(stripped)
            continue

        match = COLON_LINE_RE.match(stripped)
        if match:
            key = _label_key(match.group("label"))
            if key:
                _route(buckets, key, match.group("value").strip())
                continue

        if BARE_ORDER_NO_RE.match(stripped) or TEMPLATE_ORDER_NO_RE.fullmatch(stripped):
            buckets["order_no"].append(stripped)
            continue
        buckets["free"].append(stripped)

    def joined(key: str) -> str:
        return "\n".join(buckets[key])

    result = {key: joined(key) for key, values in buckets.items()}
    result["tags"] = unique(tags)
    result["published"] = published
    return result


def first_nonempty(*values: str) -> str:
    for value in values:
        if value and value.strip():
            return value.strip()
    return ""


def address_value(segments: dict) -> str:
    """地址取第一条标签值（换行合并），并去掉尾部解释性文字。"""
    raw = segments.get("address", "")
    if not raw:
        return ""
    value = clip(raw.split("\n")[0], 60)
    value = re.sub(r"^[：:#\s]+", "", value)
    value = re.sub(r"找个.{0,6}$", "", value).strip()
    return value


def order_no_value(segments: dict) -> str:
    """order_no 桶里已经是「标签后面的值」，直接在里面找号，不必再匹配标签。"""
    blob = segments.get("order_no", "")
    for line in blob.splitlines():
        line = line.strip()
        if not line:
            continue
        found = ORDER_NO_VALUE_RE.search(line)
        if found:
            return re.sub(r"\s+", "", found.group(0))
    for line in (blob + "\n" + segments.get("free", "")).splitlines():
        found = TEMPLATE_ORDER_NO_RE.search(line)
        if found:
            return re.sub(r"\s+", "", found.group(0)).strip("【】")
    # 只剩一串数字/数字+尾巴时（039255、26111902XH、77836549）也当单号
    for line in blob.splitlines():
        token = line.strip().strip("【】")
        if BARE_ORDER_NO_TOKEN_RE.match(token):
            return token
    return ""
