#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path

from ablation import (
    ROOT,
    detect_leakage,
    fact_correct,
    joy_lexicon_score,
    load_experiment,
    pairwise_win_rate,
    read_raws,
    tertiary_accuracy,
    verdicts,
)

RAW_DIR = ROOT / "results" / "raw"
OUT_DIR = ROOT / "results"
SCORE_DIR = ROOT / "score"


def _index(records: list[dict]) -> dict[tuple, dict]:
    return {(r["condition_id"], r["probe_id"], r["repeat"]): r for r in records if r.get("text")}


def pair_rows(index: dict, left_id: str, right_id: str, probe_ids: list[str]) -> list[dict]:
    rows = []
    for probe_id in probe_ids:
        for repeat in range(1, 6):
            left = index.get((left_id, probe_id, repeat))
            right = index.get((right_id, probe_id, repeat))
            if not left or not right:
                continue
            left_score = joy_lexicon_score(left["text"])
            right_score = joy_lexicon_score(right["text"])
            if left_score > right_score:
                winner = "left"
            elif right_score > left_score:
                winner = "right"
            else:
                winner = "tie"
            rows.append(
                {
                    "probe_id": probe_id,
                    "repeat": repeat,
                    "left_id": left_id,
                    "right_id": right_id,
                    "left_score": left_score,
                    "right_score": right_score,
                    "winner": winner,
                    "source": "lexicon",
                }
            )
    return rows


def leak_rate(records: list[dict], condition_ids: set[str]) -> float:
    subset = [r for r in records if r.get("condition_id") in condition_ids and r.get("text")]
    if not subset:
        return 0.0
    leaked = 0
    for rec in subset:
        leak = rec.get("leakage") or detect_leakage(rec["text"], rec.get("emotion"))
        leaked += int(bool(leak.get("leaked")))
    return leaked / len(subset)


def fact_rate(records: list[dict], condition_id: str) -> float | None:
    subset = [
        r
        for r in records
        if r.get("condition_id") == condition_id and r.get("probe_id") in {"fact", "bug"} and r.get("text")
    ]
    if not subset:
        return None
    correct = 0
    for rec in subset:
        fact = fact_correct(rec["probe_id"], rec["text"])
        correct += int(bool(fact.get("correct")))
    return correct / len(subset)


def classify_by_lexicon(records: list[dict], condition_ids: list[str]) -> list[dict]:
    rows = []
    for rec in records:
        if rec.get("condition_id") not in condition_ids:
            continue
        if rec.get("probe_id") not in {"chat", "vent"}:
            continue
        if not rec.get("text"):
            continue
        score = joy_lexicon_score(rec["text"])
        if score <= 1:
            pred = "有点开心"
        elif score <= 3:
            pred = "一般开心"
        else:
            pred = "非常开心"
        true_band = (rec.get("condition") or {}).get("label")
        rows.append(
            {
                "id": rec["id"],
                "true_band": true_band,
                "pred_band": pred,
                "score": score,
                "source": "lexicon",
            }
        )
    return rows


def write_blind_sheet(records: list[dict], path: Path) -> None:
    rng = random.Random(42)
    rows = []
    for rec in records:
        if not rec.get("text"):
            continue
        rows.append(
            {
                "blind_id": "",
                "text": rec["text"],
                "probe_id": rec["probe_id"],
                "joy_1to5": "",
                "empathy_1to5": "",
                "acting_1to5": "",
                "fact_ok": "",
                "leak_mark": "",
                "band_guess": "",
                "hidden_id": rec["id"],
                "hidden_condition": rec["condition_id"],
            }
        )
    rng.shuffle(rows)
    for i, row in enumerate(rows, start=1):
        row["blind_id"] = f"B{i:03d}"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else ["blind_id"])
        writer.writeheader()
        writer.writerows(rows)


def _gap(a: float | None, b: float | None) -> float:
    if a is None or b is None:
        return 0.0
    return abs(a - b)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wave", action="append", dest="waves", default=[])
    args = parser.parse_args()
    waves = set(args.waves or ["main", "fine", "bound"])
    experiment = load_experiment(ROOT)
    records = [r for r in read_raws(RAW_DIR) if r.get("wave") in waves or not args.waves]
    if not records:
        records = read_raws(RAW_DIR)
    index = _index(records)
    affect = ["chat", "vent"]

    pairs = {
        "c1_85_vs_c0": pair_rows(index, "C1-85", "C0", affect),
        "c2_high_vs_c0": pair_rows(index, "C2-非常开心", "C0", affect),
        "cross_20_vs_85": pair_rows(index, "C1-85", "C1-20", affect),
        "within_70_80": pair_rows(index, "C1-80", "C1-70", affect),
        "within_80_90": pair_rows(index, "C1-90", "C1-80", affect),
        "within_70_90": pair_rows(index, "C1-90", "C1-70", affect),
        "bound_66_vs_67": pair_rows(index, "C1-67", "C1-66", affect),
    }
    within_rows = pairs["within_70_80"] + pairs["within_80_90"] + pairs["within_70_90"]
    pair_rates = {key: pairwise_win_rate(rows) for key, rows in pairs.items()}
    pair_rates["within_708090"] = pairwise_win_rate(within_rows)

    c1_cls = classify_by_lexicon(records, ["C1-20", "C1-50", "C1-85"])
    c2_cls = classify_by_lexicon(records, ["C2-有点开心", "C2-一般开心", "C2-非常开心"])
    c1_acc = tertiary_accuracy(c1_cls)
    c2_acc = tertiary_accuracy(c2_cls)

    fact_c0 = fact_rate(records, "C0")
    fact_c1 = fact_rate(records, "C1-85")
    fact_c2 = fact_rate(records, "C2-非常开心")
    fact_gap = max(_gap(fact_c0, fact_c1), _gap(fact_c0, fact_c2), _gap(fact_c1, fact_c2))

    metrics = {
        "c1_85_vs_c0": pair_rates["c1_85_vs_c0"],
        "c2_high_vs_c0": pair_rates["c2_high_vs_c0"],
        "c1_leak_rate": leak_rate(records, {"C1-20", "C1-50", "C1-85"}),
        "c2_leak_rate": leak_rate(records, {"C2-有点开心", "C2-一般开心", "C2-非常开心"}),
        "within_708090": pair_rates["within_708090"],
        "cross_20_vs_85": pair_rates["cross_20_vs_85"],
        "bound_66_vs_67": pair_rates["bound_66_vs_67"],
        "c2_accuracy": c2_acc["accuracy"] if c2_acc["accuracy"] is not None else 0.0,
        "c1_accuracy": c1_acc["accuracy"] if c1_acc["accuracy"] is not None else 0.0,
        "fact_gap": fact_gap,
    }
    out = {
        "n_records": len(records),
        "pair_rates": pair_rates,
        "c1_accuracy": c1_acc,
        "c2_accuracy": c2_acc,
        "leak": {
            "c1": metrics["c1_leak_rate"],
            "c2": metrics["c2_leak_rate"],
        },
        "fact": {"C0": fact_c0, "C1-85": fact_c1, "C2-非常开心": fact_c2, "gap": fact_gap},
        "verdicts": verdicts(metrics),
        "source": "lexicon",
        "bands": experiment["conditions"]["bands"],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "summary.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_blind_sheet(records, SCORE_DIR / "blind_sheet.csv")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
