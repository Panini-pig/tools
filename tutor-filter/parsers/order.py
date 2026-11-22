"""把一条家教单文本解析成结构化字段（纯规则，不调用任何模型）。"""
from __future__ import annotations

import re

from .fields import (
    parse_city,
    parse_district,
    parse_genders,
    parse_grade,
    parse_mode,
    parse_published,
    parse_subjects,
    subjects_in,
)
from .labels import address_value, order_no_value, parse_segments
from .rates import parse_rates
from .schedule import parse_schedule
from .text import clip, first_group, normalize_text, unique

REQUIREMENT_WORDS = (
    "有经验", "家教经验", "经验丰富", "师范", "耐心", "负责", "研究生", "985", "211", "92",
    "江苏考生", "江苏籍", "本地", "大一大二", "在职", "专职", "全职", "住家", "英语专业",
    "数学专业", "专业对口", "奥数", "口音", "简历", "身份证", "一对二", "全英",
)
TAG_WORDS = (
    "加急", "长期", "机构单", "外教", "住家", "一对二", "全职", "考研", "艺术特长生",
    "报销车费", "只要92", "陪读",
)
CORE_FIELDS = (
    "grade_code", "subjects", "district", "hourly_min", "frequency_per_week",
    "weekdays", "teaching_mode", "order_no",
)
FIELD_NAMES = {
    "grade_code": "年级", "subjects": "科目", "district": "区县", "hourly_min": "时薪",
    "frequency_per_week": "每周次数", "weekdays": "上课星期", "teaching_mode": "授课方式",
    "order_no": "单号",
}


def parse_order(chunk: str) -> dict:
    chunk = normalize_text(chunk)
    segments = parse_segments(chunk)
    address = address_value(segments) or _address_from_text(segments["header"] + "\n" + segments["free"])
    order_no = order_no_value(segments)
    published_at, poster = parse_published(chunk, order_no)

    district, district_evidence = parse_district(
        address, segments["free"], segments["header"], segments["order_no"]
    )
    city = parse_city(district, address, segments["free"], segments["header"])

    grade, grade_code, stage, grade_evidence = parse_grade([
        segments["grade"], segments["header"], segments["student"], segments["subject"], segments["free"],
    ])
    subjects, weak_subjects, subject_evidence = parse_subjects(
        segments["subject"], segments["student"], segments["header"], segments["free"]
    )
    teacher_can_teach = [
        subject for subject in subjects_in(segments["teacher"]) if subject not in subjects
    ]

    schedule = parse_schedule(segments["schedule"], segments["free"])
    hours = schedule["hours_per_lesson"]
    # 全职/坐班的「时间」是上班时间，不是单次课长
    if hours and re.search(r"上班|坐班", chunk) and not re.search(
        r"(?:每次|单次|一次)\s*(?:课)?\s*[0-9一二两三四五六]", chunk
    ):
        hours = None
    rates = parse_rates(segments["price"], hours)
    if rates["hourly_min"] is None and rates["rate_min"] is None and not rates["price_note"]:
        rates = parse_rates(chunk, hours)
    if hours is None:
        match = re.search(r"元/(\d+(?:\.\d+)?)h", rates.get("rate_unit", ""))
        if match:
            hours = float(match.group(1))
    # 月薪单：用「每周次数 × 单次时长」折算时薪，并标注为估算
    if (
        rates.get("rate_unit") == "元/月"
        and rates["hourly_min"] is None
        and rates["rate_min"] is not None
        and schedule["frequency_per_week"]
        and hours
    ):
        weekly = schedule["frequency_per_week"] * hours * 4.33
        rates = {
            **rates,
            "hourly_min": round(rates["rate_min"] / weekly, 1),
            "hourly_max": round((rates["rate_max"] or rates["rate_min"]) / weekly, 1),
            "hourly_estimated": 1,
            "price_note": "按月薪折算，含估算",
        }

    mode, mode_evidence = parse_mode(
        address, district, segments["free"] + "\n" + segments["subject"], segments["note"]
    )
    genders = parse_genders(segments["teacher"], segments["student"], segments["tags"], segments["free"])

    requirements = [word for word in REQUIREMENT_WORDS if word in chunk]
    tags = unique(_clean_tags(segments["tags"]) + [word for word in TAG_WORDS if word in chunk])

    evidence = {
        "address": address,
        "order_no": order_no,
        "district": district_evidence,
        "grade": grade_evidence,
        "poster": poster,
        "mode": mode_evidence,
        **subject_evidence,
    }
    if rates["rate_min"] is not None:
        evidence["rates"] = f"{rates['rate_min']:g}-{rates['rate_max']:g} {rates['rate_unit']}"
    if schedule["frequency_text"]:
        evidence["frequency"] = schedule["frequency_text"]
    if schedule["weekdays"]:
        evidence["weekdays"] = "、".join(schedule["weekdays"])
    evidence = {key: clip(value, 60) for key, value in evidence.items() if value}

    values = {
        "grade_code": grade_code,
        "subjects": subjects,
        "district": district,
        "hourly_min": rates["hourly_min"],
        "frequency_per_week": schedule["frequency_per_week"],
        "weekdays": schedule["weekdays"] or schedule["time_text"],
        "teaching_mode": mode,
        "order_no": order_no,
    }
    flags: dict[str, str] = {}
    for key in CORE_FIELDS:
        flags[key] = "ok" if values[key] else "missing"
    if rates["hourly_min"] is not None and not (15 <= rates["hourly_min"] <= 500):
        flags["hourly_min"] = "check"
    if rates.get("hourly_estimated"):
        flags["hourly_min"] = "estimated"

    collected = sum(1 for key in CORE_FIELDS if values[key])
    confidence = round(0.35 + 0.65 * collected / len(CORE_FIELDS), 2)
    missing = [FIELD_NAMES[key] for key in CORE_FIELDS if not values[key]]

    weekdays = schedule["weekdays"]
    schedule_summary = list(weekdays)
    if schedule["time_slot"]:
        schedule_summary.append(schedule["time_slot"])
    if schedule["frequency_per_week"]:
        schedule_summary.append(f"每周{schedule['frequency_per_week']:g}次")
    if not schedule_summary and schedule["time_text"]:
        schedule_summary = [schedule["time_text"]]

    return {
        "status": "新单",
        "order_no": order_no,
        "poster": poster,
        "published_at": published_at,
        "city": city,
        "district": district,
        "address": address,
        "location_text": address or district,
        "grade": grade,
        "grade_code": grade_code,
        "stage": stage,
        "subjects": subjects,
        "weak_subjects": weak_subjects,
        "teacher_can_teach": teacher_can_teach,
        "student_gender": genders["student_gender"],
        "teacher_gender_required": genders["teacher_gender_required"],
        "gender_conflict": genders["gender_conflict"],
        "english_required": bool(re.search(r"英语|四六级|六级|雅思|托福|KET|PET", chunk, re.I)),
        "teaching_mode": mode,
        "schedule": unique(schedule_summary),
        "weekdays": weekdays,
        "time_slot": schedule["time_slot"],
        "time_text": schedule["time_text"],
        "excluded_weekdays": schedule["excluded_weekdays"],
        "frequency_per_week": schedule["frequency_per_week"],
        "frequency_min": schedule["frequency_min"],
        "freq_derived": schedule["freq_derived"],
        "duration_hours": hours,
        "rate_min": rates["rate_min"],
        "rate_max": rates["rate_max"],
        "rate_unit": rates["rate_unit"],
        "hourly_min": rates["hourly_min"],
        "hourly_max": rates["hourly_max"],
        "hourly_estimated": rates["hourly_estimated"],
        "price_min": rates["hourly_min"] if rates["hourly_min"] is not None else rates["rate_min"],
        "price_max": rates["hourly_max"] if rates["hourly_max"] is not None else rates["rate_max"],
        "price_unit": "元/小时" if rates["hourly_min"] is not None else rates["rate_unit"],
        "price_note": rates["price_note"],
        "requirements": requirements,
        "tags": tags,
        "contact": first_group(r"(?:联系|微信|QQ|电话)[方式人]?\s*[:：]?\s*([\w-]{5,})", chunk),
        "confidence": confidence,
        "missing_fields": missing,
        "field_flags": flags,
        "evidence": evidence,
    }


def _address_from_text(text: str) -> str:
    """没有【地址】标签时，从标题行/正文里挑一行像地址的。"""
    for line in (text or "").split("\n"):
        line = line.strip().lstrip("#").strip()
        if not line or len(line) > 40:
            continue
        if re.match(r"^[\u4e00-\u9fa5]{2,4}区", line) or re.match(r"^[\u4e00-\u9fa5]{2,8}(?:路|街|大道)", line):
            return clip(line, 40)
        if "附近" in line and len(line) <= 24:
            return clip(line, 40)
    return ""


def _clean_tags(tags: list[str]) -> list[str]:
    cleaned = []
    for tag in tags:
        tag = tag.strip(" #")
        if not tag or len(tag) > 10:
            continue
        if re.search(r"[，,。；;：:]", tag):
            continue
        cleaned.append(tag)
    return cleaned


def extract_location_text(text: str) -> str:
    text = re.sub(r"^.*?(?:地点\s*(?:在|为|是|[:：])|地址\s*(?:在|为|是|[:：])|位于|靠近)", "", text.strip())
    patterns = [
        r"([\u4e00-\u9fa5A-Za-z0-9]{2,18}(?:地铁站|站))",
        r"([\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:大学|中学|小学|学校|校区))",
        r"([\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:小区|花园|广场|大厦|中心|商场))",
        r"([\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:路|街|大道|镇))",
    ]
    for pattern in patterns:
        value = first_group(pattern, text)
        if value:
            return value
    return ""
