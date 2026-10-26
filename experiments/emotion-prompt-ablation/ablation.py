from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

BANDS: tuple[tuple[int, int, str], ...] = (
    (1, 33, "有点开心"),
    (34, 66, "一般开心"),
    (67, 100, "非常开心"),
)

ROOT = Path(__file__).resolve().parent
PERCENT_LINE = "你现在的心情是开心，程度为 {p}%。"
LABEL_LINE = "你现在的心情是{label}。"


def label_for_percent(percent: int) -> str | None:
    if percent == 0:
        return None
    if percent < 0 or percent > 100:
        raise ValueError(f"percent out of range: {percent}")
    for lo, hi, label in BANDS:
        if lo <= percent <= hi:
            return label
    raise ValueError(f"percent not in any band: {percent}")


def build_system_prompt(base: str, emotion: dict[str, Any] | None) -> str:
    base = base.rstrip("\n")
    if not emotion or not emotion.get("kind"):
        return base
    if emotion["kind"] == "percent":
        return f"{base}\n{PERCENT_LINE.format(p=emotion['percent'])}"
    if emotion["kind"] == "label":
        return f"{base}\n{LABEL_LINE.format(label=emotion['label'])}"
    raise ValueError(f"unknown emotion kind: {emotion['kind']}")


def load_experiment(root: Path = ROOT) -> dict[str, Any]:
    system = (root / "prompts" / "system.txt").read_text(encoding="utf-8").rstrip("\n")
    probes = json.loads((root / "fixtures" / "probes.json").read_text(encoding="utf-8"))
    conditions = json.loads((root / "fixtures" / "conditions.json").read_text(encoding="utf-8"))
    by_id = {item["id"]: item for item in conditions["conditions"]}
    return {
        "root": root,
        "system": system,
        "probes": probes["probes"],
        "conditions": conditions,
        "by_id": by_id,
    }


def build_jobs(experiment: dict[str, Any], waves: list[str]) -> list[dict[str, Any]]:
    conditions_cfg = experiment["conditions"]
    wanted: list[str] = []
    for wave in waves:
        wanted.extend(conditions_cfg["waves"][wave])
    jobs: list[dict[str, Any]] = []
    for condition_id in wanted:
        condition = experiment["by_id"][condition_id]
        emotion = None
        if condition["kind"]:
            emotion = {
                "kind": condition["kind"],
                "percent": condition["percent"],
                "label": condition["label"],
            }
        system = build_system_prompt(experiment["system"], emotion)
        for probe in experiment["probes"]:
            for repeat in range(1, conditions_cfg["repeats"] + 1):
                job_id = f"{condition_id}__{probe['id']}__{repeat}"
                jobs.append(
                    {
                        "id": job_id,
                        "wave": next(
                            w
                            for w, ids in conditions_cfg["waves"].items()
                            if condition_id in ids
                        ),
                        "condition_id": condition_id,
                        "condition": condition,
                        "emotion": emotion,
                        "probe_id": probe["id"],
                        "probe": probe,
                        "repeat": repeat,
                        "system_prompt": system,
                        "user_text": probe["text"],
                    }
                )
    return jobs


def detect_leakage(text: str, emotion: dict[str, Any] | None) -> dict[str, Any]:
    tokens: list[str] = []
    if not emotion or not emotion.get("kind"):
        return {"leaked": False, "tokens": tokens}
    if emotion["kind"] == "percent":
        percent = emotion["percent"]
        needle = f"{percent}%"
        if re.search(rf"(?<!\d){percent}\s*%", text):
            tokens.append(needle)
        if "程度为" in text:
            tokens.append("程度为")
    elif emotion["kind"] == "label":
        label = emotion["label"]
        if label in text:
            tokens.append(label)
    return {"leaked": bool(tokens), "tokens": tokens}


def _has_speed_of_light(text: str) -> bool:
    compact = (
        text.replace(" ", "")
        .replace(",", "")
        .replace("\\times", "×")
        .replace("\\(", "")
        .replace("\\)", "")
        .lower()
    )
    if "299792458" in compact:
        return True
    if re.search(r"3e8", compact):
        return True
    if re.search(r"3[×x*]10[\^＾]?8", compact):
        return True
    if re.search(r"3[×x*]?10[⁸8]", compact):
        return True
    if re.search(r"(?<!\d)10[\^＾]?8", compact) or re.search(r"(?<!\d)10⁸", compact):
        return True
    if "三亿" in text and ("米" in text or "m/s" in compact):
        return True
    return False


def fact_correct(probe_id: str, text: str) -> dict[str, Any]:
    if probe_id == "bug":
        ok = ("冒号" in text) or re.search(r"colon", text, re.I) is not None
        return {"correct": ok, "reason": "colon" if ok else "missing_colon"}
    if probe_id in {"chat", "fact"}:
        ok = _has_speed_of_light(text)
        return {"correct": ok, "reason": "speed_of_light" if ok else "missing_c"}
    return {"correct": None, "reason": "not_fact"}


def pairwise_win_rate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    decided = [row for row in rows if row.get("winner") in {"left", "right"}]
    left_wins = sum(1 for row in decided if row["winner"] == "left")
    n = len(decided)
    return {
        "n": n,
        "left_wins": left_wins,
        "right_wins": n - left_wins,
        "ties": sum(1 for row in rows if row.get("winner") == "tie"),
        "left_rate": (left_wins / n) if n else None,
    }


def tertiary_accuracy(rows: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)
    correct = sum(1 for row in rows if row.get("pred_band") == row.get("true_band"))
    return {
        "n": n,
        "correct": correct,
        "accuracy": (correct / n) if n else None,
    }


def _in_range(value: float | None, lo: float, hi: float) -> bool:
    return value is not None and lo <= value <= hi


def verdicts(metrics: dict[str, Any]) -> dict[str, str]:
    c1 = metrics["c1_85_vs_c0"]
    c1_rate = c1.get("left_rate")
    leak = metrics["c1_leak_rate"]
    if leak >= 0.30 or _in_range(c1_rate, 0.40, 0.60):
        q1 = "不成立"
    elif c1_rate is not None and c1_rate >= 0.70 and leak < 0.30:
        q1 = "成立"
    else:
        q1 = "弱成立"

    within = metrics["within_708090"].get("left_rate")
    bound = metrics["bound_66_vs_67"].get("left_rate")
    if bound is not None and bound >= 0.70:
        q2 = "抠数字"
    elif within is None or _in_range(within, 0.40, 0.60):
        q2 = "不明显"
    else:
        q2 = "细调可分"

    c2_acc = metrics["c2_accuracy"]
    c1_acc = metrics["c1_accuracy"]
    if c2_acc >= 0.60 and (c2_acc - c1_acc) >= 0.15:
        q3 = "字段更明确"
    elif abs(c2_acc - 1 / 3) <= 0.08 and abs(c1_acc - 1 / 3) <= 0.08:
        q3 = "都不够"
    elif c1_acc > c2_acc:
        q3 = "百分比够用"
    else:
        q3 = "不明确"

    fact = "保持" if metrics["fact_gap"] <= 0.10 else "被破坏"
    return {
        "q1_percent_affects": q1,
        "q2_percent_fine_tune": q2,
        "q3_label_clearer": q3,
        "fact_invariance": fact,
    }


def write_raw(directory: Path, record: dict[str, Any]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{record['id']}.json"
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def read_raws(directory: Path) -> list[dict[str, Any]]:
    records = []
    for path in sorted(directory.glob("*.json")):
        records.append(json.loads(path.read_text(encoding="utf-8")))
    return records


JOY_POS = ("哈哈", "嘿嘿", "嘻嘻", "呀", "啦", "喔", "嘿", "棒", "开心", "高兴", "耶")
JOY_NEG = ("唉", "烦", "糟", "惨", "无语")


def joy_lexicon_score(text: str) -> int:
    score = text.count("！") + text.count("!")
    for token in JOY_POS:
        score += text.count(token)
    for token in JOY_NEG:
        score -= text.count(token)
    score += len(re.findall(r"[\U0001F300-\U0001FAFF]", text))
    return score
