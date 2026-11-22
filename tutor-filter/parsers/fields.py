"""年级、科目、性别、授课方式、区县、发布时间的规则识别。

这里的共同原则是「只看该看的槽位」：
- 年级只看 学员 / 年级标签 / 标题，`女大学生`、`南大东大`、`大一大二` 一律不算年级；
- 科目只看 科目标签 / 学员情况 / 标题，`生命科学学院` 不算「科学」，
  「对历史方面精通」不算「历史」；
- 对老师的性别要求只从 要求 / 教员 槽位读，学员性别只从 学员 槽位读。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

NANJING_DISTRICTS = ["玄武", "秦淮", "建邺", "鼓楼", "浦口", "栖霞", "雨花台", "江宁", "六合", "溧水", "高淳"]
# 常见片区 → 所属区（单里经常只写片区，不写区名）
AREA_ALIASES = {
    "仙林": "栖霞区", "仙林湖": "栖霞区", "尧化门": "栖霞区", "迈皋桥": "栖霞区",
    "桥北": "浦口区", "江浦": "浦口区",
    "龙江": "鼓楼区", "清凉山": "鼓楼区", "湖南路": "鼓楼区",
    "河西": "建邺区", "奥体": "建邺区",
    "大光路": "秦淮区", "夫子庙": "秦淮区", "新街口": "秦淮区",
    "东山": "江宁区", "百家湖": "江宁区", "麒麟门": "江宁区", "麒麟街道": "江宁区",
    "铁心桥": "雨花台区", "板桥": "雨花台区",
}
DISTRICT_BLOCKLIST = ("小区", "社区", "园区", "学区", "市区", "城区", "校区", "辖区", "片区", "街区", "地区")

# (正则, 类型)。类型 p/j/s 的数字会被规范化成「五年级 / 初二 / 高三」。
GRADE_RULES: list[tuple[str, str]] = [
    (r"幼(?:儿园|小衔接)|学前|托班", "kg"),
    (r"[小中大]\s*班", "kg"),
    (r"小学\s*([一二三四五六1-6])\s*年级", "p"),
    (r"([七八九])\s*年级", "j_map"),
    (r"([一二三四五六1-6])\s*年级", "p"),
    (r"初\s*([一二三1-3])", "j"),
    (r"新?\s*高\s*([一二三1-3])", "s"),
    (r"小\s*([一二三四五六1-6])(?![学])", "p"),
    (r"([一二两三四五六1-6])\s*岁", "kg"),
    (r"考研|研究生|硕士|成人|专升本|大专|大[一二三四]|大学", "adult"),
    (r"高中", "senior"),
    (r"初中", "junior"),
    (r"小学", "primary"),
]
CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
GRADE_LABELS = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六"}

SUBJECT_VOCAB = [
    "语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "道法", "科学", "奥数",
    "编程", "Scratch", "Python", "C++", "音乐", "声乐", "钢琴", "古筝", "吉他", "舞蹈", "书法", "绘画", "美术",
    "体育", "篮球", "足球", "游泳", "全科", "主科", "理科", "作业辅导", "作业监督", "陪读", "陪学", "陪伴", "接送",
]
SUBJECT_ALIASES = {
    "辅导作业": "作业辅导", "作辅": "作业辅导", "陪写作业": "作业监督", "监督作业": "作业监督",
    "陪伴学习": "陪学", "陪玩": "陪伴", "作业辅助": "作业辅导", "伴学": "陪学",
}
# 教材名等价于英语
TEXTBOOK_ENGLISH_RE = re.compile(
    r"power\s*up|think\s*\d|新概念|剑桥|自然拼读|牛津|ket|pet|unlock|wonders|raz", re.I
)
COMPOUND_SUBJECTS = {
    "语数英": ["语文", "数学", "英语"],
    "数英": ["数学", "英语"],
    "英数": ["数学", "英语"],
    "语数": ["语文", "数学"],
    "数理化": ["数学", "物理", "化学"],
    "理化": ["物理", "化学"],
    "政史": ["政治", "历史"],
    "生地": ["生物", "地理"],
}
WEAK_MARKERS = ("薄弱", "较差", "不好", "不及格", "偏低", "漏洞", "基础差", "中下", "丢分", "不稳定", "偏科", "拖后腿")
SUBJECT_BLOCK_PREFIX = ("生命", "社会", "信息", "计算", "材料")

FEMALE_TEACHER_RE = r"女(?:老师|大学生|同学|生|教员|教师|硕士|研究生)"
MALE_TEACHER_RE = r"男(?:老师|大学生|同学|生|教员|教师|硕士|研究生)"
ANY_GENDER_RE = r"(?:男女不限|性别不限|不限男女|男女均可)"


def _normalize_grade(token: str, kind: str) -> tuple[str, str, str]:
    if kind == "kg":
        return "幼儿园", "kg", "幼儿园"
    if kind == "adult":
        return "成人", "adult", "成人"
    if kind in ("senior", "junior", "primary"):
        stage = {"senior": "高中", "junior": "初中", "primary": "小学"}[kind]
        return stage, kind, stage

    token = (token or "").strip()
    if not token:
        return "", "", ""
    number = int(token) if token.isdigit() else CN_NUM.get(token)
    if number is None:
        return "", "", ""
    if kind == "p" and 1 <= number <= 6:
        return f"{GRADE_LABELS[number]}年级", f"p{number}", "小学"
    if kind == "j" and 1 <= number <= 3:
        return f"初{GRADE_LABELS[number]}", f"j{number}", "初中"
    if kind == "s" and 1 <= number <= 3:
        return f"高{GRADE_LABELS[number]}", f"s{number}", "高中"
    return "", "", ""


def parse_grade(texts: list[str]) -> tuple[str, str, str, str]:
    """按优先级依次尝试；返回 (年级, 代码, 学段, 证据片段)。"""
    for text in texts:
        if not text:
            continue
        for pattern, kind in GRADE_RULES:
            for match in re.finditer(pattern, text):
                literal = match.group(0)
                token = match.group(1) if match.groups() else ""
                if kind == "j_map":
                    token = {"七": "1", "八": "2", "九": "3"}.get(literal[:1], "")
                    kind_used = "j"
                else:
                    kind_used = kind
                context = text[max(0, match.start() - 4):match.end()]
                if kind_used in ("p", "j", "s", "kg") and re.search(r"[南东河]大|大[一二三四]|大学|学院|专业", context):
                    continue
                # 「女大学生」「男研究生」是在说老师，不是在说学员年级
                if kind_used == "adult" and re.search(r"[男女]$", text[:match.start()]) and literal.startswith("大"):
                    continue
                # 「大一大二擅长数理化」是老师能教的年级，不是学员年级
                if kind_used == "adult" and re.match(r"大[一二三四]", literal):
                    window = text[max(0, match.start() - 6):match.end() + 8]
                    if re.search(r"擅长|优先|院校|专业|在读|毕业|以上", window):
                        continue
                    if re.match(r"大[一二三四]大[一二三四]", text[match.start():]):
                        continue
                grade, code, stage = _normalize_grade(token, kind_used)
                if grade:
                    return grade, code, stage, literal
    return "", "", "", ""


def subjects_in(text: str) -> list[str]:
    """从一段文本里找出学科词（含「语数英」这类缩写展开）。"""
    found: list[str] = []
    if not text:
        return found
    lowered = text.lower()
    for alias, subjects in COMPOUND_SUBJECTS.items():
        if alias in text:
            found.extend(subjects)
    for alias, canonical in SUBJECT_ALIASES.items():
        if alias in text:
            found.append(canonical)
    if TEXTBOOK_ENGLISH_RE.search(text):
        found.append("英语")
    for subject in SUBJECT_VOCAB:
        if subject.lower() not in lowered:
            continue
        if subject == "科学":
            index = lowered.find("科学")
            if any(word in text[max(0, index - 4):index] for word in SUBJECT_BLOCK_PREFIX):
                continue
        found.append(subject)
    return found


def parse_subjects(subject_text: str, student_text: str, header_text: str, free_text: str = "") -> tuple[list[str], list[str], dict]:
    """返回 (辅导科目, 学员弱科, 证据)。科目槽优先；学员情况只补非弱科。"""
    evidence: dict[str, str] = {}
    subjects = subjects_in(subject_text)
    if subjects:
        evidence["subjects"] = _snippet(subject_text, subjects[0])
    if not subjects:
        subjects = subjects_in(header_text)
    if not subjects:
        subjects = subjects_in(free_text)

    weak: list[str] = []
    for sentence in re.split(r"[，,。；;\s]+", student_text or ""):
        found = subjects_in(sentence)
        if not found:
            continue
        if any(marker in sentence for marker in WEAK_MARKERS):
            weak.extend(found)
        else:
            subjects.extend(found)

    subjects = _dedupe(subjects)
    weak = _dedupe(weak)
    if weak:
        evidence["weak_subjects"] = _snippet(student_text, weak[0])
    return subjects, weak, evidence


def parse_genders(teacher_text: str, student_text: str, tags: list[str], free_text: str = "") -> dict:
    teacher_blob = (teacher_text or "") + " " + " ".join(tags or [])
    teacher_female = bool(re.search(FEMALE_TEACHER_RE, teacher_blob))
    teacher_male = bool(re.search(MALE_TEACHER_RE, teacher_blob))
    if not teacher_female and not teacher_male and free_text:
        # 没有标签的一段话（比如一行一条的群消息）：「要求女老师」仍要能认出来
        for match in re.finditer(r"(?:要求|限|需要?|最好|优先|只考虑|只要)[^，,。\n]{0,8}?([女男])(?:老师|生|大学生|同学)", free_text):
            if match.group(1) == "女":
                teacher_female = True
            else:
                teacher_male = True
    if re.search(ANY_GENDER_RE, teacher_blob):
        required = ""
    elif teacher_female and teacher_male:
        required = ""          # 一条单里两个岗位，不硬判
    elif teacher_female:
        required = "女"
    elif teacher_male:
        required = "男"
    else:
        required = ""

    student_female = bool(re.search(r"女(?:孩|生|儿|宝|同学)|[，,]\s*女\s*[，,]|^女$", (student_text or "").strip()))
    student_male = bool(re.search(r"男(?:孩|生|儿|宝|同学)|[，,]\s*男\s*[，,]|^男$", (student_text or "").strip()))
    if student_female and not student_male:
        student = "女"
    elif student_male and not student_female:
        student = "男"
    else:
        student = ""

    return {
        "teacher_gender_required": required,
        "student_gender": student,
        "gender_conflict": teacher_female and teacher_male,
    }


def parse_district(*texts: str) -> tuple[str, str]:
    """返回 (区县, 证据)。优先认南京的区名（高淳、鼓楼这种常省略「区」），其次认「XX区」。"""
    blob = "\n".join(text for text in texts if text)
    # 按传入顺序逐个文本找（地址 > 正文 > 标题）；同一文本内先认区名，再认片区别名
    for text in texts:
        if not text:
            continue
        for name in sorted(NANJING_DISTRICTS, key=len, reverse=True):
            if name in text:
                return name + "区", name
        if "江北新区" in text:
            return "江北新区", "江北新区"
        for name in sorted(AREA_ALIASES, key=len, reverse=True):
            if name in text:
                return AREA_ALIASES[name], name
    for match in re.finditer(r"([\u4e00-\u9fa5]{2,3}区)", blob):
        value = match.group(1)
        if value.endswith(DISTRICT_BLOCKLIST):
            continue
        return value, value
    return "", ""


def parse_city(district: str, *texts: str) -> str:
    if district or "南京" in "\n".join(texts):
        return "南京市"
    return ""


PHYSICAL_RE = re.compile(r"(?:小区|公寓|大厦|广场|地铁站|花园|苑|城|园|号|楼|路|街|区|附近|对面|里|村|镇|公交站)")


def parse_mode(address: str, district: str, order_text: str, note_text: str) -> tuple[str, str]:
    if re.search(r"线上|网课|远程|视频", address or ""):
        return "线上", "地址写明线上"
    if district or PHYSICAL_RE.search(address or ""):
        return "线下", address or district

    cleaned = (order_text or "") + "\n" + (note_text or "")
    cleaned = re.sub(r"(?:一本|分数线|分数)[^\s，,。]{0,4}线上", " ", cleaned)
    cleaned = re.sub(r"线上(?:授课|答疑|沟通|联系|陪学|交流|教学)", " ", cleaned)
    if re.search(r"线上|网课|远程|视频", cleaned):
        return "线上", "正文提到线上"
    if re.search(r"上门|线下", cleaned):
        return "线下", "正文提到线下"
    return "", ""


QQ_LINE_RE = re.compile(
    r"^(?P<poster>.{1,24}?)\s*[:：]\s*(?P<month>\d{1,2})-(?P<day>\d{1,2})\s+"
    r"(?P<hour>\d{1,2}):(?P<minute>\d{2})(?::(?P<second>\d{2}))?\s*$"
)
EMBEDDED_DATE_RE = re.compile(
    r"(?:南京)?(?:[A-Z]{2})?(?P<year>\d{2})(?P<month>1[0-2]|0[1-9])(?P<day>0[1-9]|[12]\d|3[01])"
)


def parse_published(chunk: str, order_no: str = "") -> tuple[str, str]:
    """返回 (发布时间 ISO, 发布人)。优先 QQ 前缀，其次单号里内嵌的日期。"""
    poster = ""
    for line in (chunk or "").split("\n"):
        match = QQ_LINE_RE.match(line.strip())
        if not match:
            continue
        poster = match.group("poster").strip()
        year = datetime.now().year
        try:
            moment = datetime(
                year, int(match.group("month")), int(match.group("day")),
                int(match.group("hour")), int(match.group("minute")), int(match.group("second") or 0),
            )
        except ValueError:
            continue
        if (moment - datetime.now()).days > 31:
            moment = moment.replace(year=year - 1)
        return moment.isoformat(timespec="seconds"), poster

    if order_no:
        for match in EMBEDDED_DATE_RE.finditer(order_no):
            try:
                moment = datetime(2000 + int(match.group("year")), int(match.group("month")), int(match.group("day")))
            except ValueError:
                continue
            # 单号里的数字不一定是日期（也可能是流水号），未来日期一律不认
            if moment.year <= datetime.now().year + 1 and moment <= datetime.now() + timedelta(days=1):
                return moment.isoformat(timespec="seconds"), poster
    return "", poster


def _snippet(text: str, needle: str) -> str:
    if not text:
        return ""
    index = text.find(needle)
    if index < 0:
        return text[:40].strip()
    start = max(0, index - 12)
    return text[start:index + len(needle) + 12].strip()


def _dedupe(values) -> list[str]:
    seen: set[str] = set()
    result = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result
