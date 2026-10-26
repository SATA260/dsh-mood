#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ablation import ROOT, pairwise_win_rate, read_raws, tertiary_accuracy, verdicts
from analyze import (
    RAW_DIR,
    _gap,
    _index,
    fact_rate,
    leak_rate,
    pair_rows,
)
from run import pi_print

JUDGE_SYSTEM = """你是盲评员。只根据回复文本判断语气，不要猜测实验条件，不要复述设定。
只输出一个 JSON 对象，不要解释。"""


def _parse_json(text: str) -> dict:
    text = text.strip()
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"no json: {text[:200]}")
    return json.loads(match.group(0))


def judge_pair(left: str, right: str, timeout: int) -> dict:
    prompt = (
        "比较 A 和 B，哪一条读起来更开心、更轻快？\n"
        "只输出 JSON：{\"winner\":\"A\"或\"B\"或\"tie\",\"joy_A\":1到5的整数,\"joy_B\":1到5的整数}\n\n"
        f"A：\n{left}\n\nB：\n{right}\n"
    )
    result = pi_print(JUDGE_SYSTEM, prompt, timeout)
    parsed = _parse_json(result["stdout"])
    winner = parsed.get("winner")
    mapping = {"A": "left", "B": "right", "tie": "tie", "left": "left", "right": "right"}
    return {
        "winner": mapping.get(winner, "tie"),
        "joy_A": parsed.get("joy_A"),
        "joy_B": parsed.get("joy_B"),
        "raw": result["stdout"],
        "source": "llm",
    }


def judge_band(text: str, timeout: int) -> dict:
    prompt = (
        "把这条回复的开心程度分成三档之一：有点开心、一般开心、非常开心。\n"
        "只输出 JSON：{\"band\":\"有点开心或一般开心或非常开心\",\"joy\":1到5的整数,\"acting\":1到5的整数}\n\n"
        f"回复：\n{text}\n"
    )
    result = pi_print(JUDGE_SYSTEM, prompt, timeout)
    parsed = _parse_json(result["stdout"])
    return {
        "pred_band": parsed.get("band"),
        "joy": parsed.get("joy"),
        "acting": parsed.get("acting"),
        "raw": result["stdout"],
        "source": "llm",
    }


def _retry(fn, retries: int = 2):
    last = None
    for attempt in range(1, retries + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(min(attempt, 4))
    raise last


def overlay_pairs(lexicon_rows: list[dict], index: dict, timeout: int, workers: int) -> list[dict]:
    def one(row: dict) -> dict:
        left = index[(row["left_id"], row["probe_id"], row["repeat"])]
        right = index[(row["right_id"], row["probe_id"], row["repeat"])]
        judged = _retry(lambda: judge_pair(left["text"], right["text"], timeout))
        merged = dict(row)
        merged.update(judged)
        return merged

    out = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, row): row for row in lexicon_rows}
        for future in as_completed(futures):
            row = futures[future]
            merged = future.result()
            out.append(merged)
            print(f"PAIR {row['left_id']} vs {row['right_id']} {row['probe_id']}#{row['repeat']} -> {merged['winner']}")
    return out


def overlay_cls(records: list[dict], condition_ids: list[str], timeout: int, workers: int) -> list[dict]:
    targets = [
        rec
        for rec in records
        if rec.get("condition_id") in condition_ids
        and rec.get("probe_id") in {"chat", "vent"}
        and rec.get("text")
    ]

    def one(rec: dict) -> dict:
        judged = _retry(lambda: judge_band(rec["text"], timeout))
        return {
            "id": rec["id"],
            "true_band": (rec.get("condition") or {}).get("label"),
            "pred_band": judged["pred_band"],
            "joy": judged.get("joy"),
            "acting": judged.get("acting"),
            "source": "llm",
        }

    rows = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, rec): rec for rec in targets}
        for future in as_completed(futures):
            rec = futures[future]
            item = future.result()
            rows.append(item)
            print(f"BAND {rec['id']} true={item['true_band']} pred={item['pred_band']}")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--pairs-only", action="store_true")
    args = parser.parse_args()
    records = [r for r in read_raws(RAW_DIR) if r.get("text")]
    if not records:
        print("no raw records", file=sys.stderr)
        return 1
    index = _index(records)
    affect = ["chat", "vent"]
    pair_sources = {
        "c1_85_vs_c0": pair_rows(index, "C1-85", "C0", affect),
        "c2_high_vs_c0": pair_rows(index, "C2-非常开心", "C0", affect),
        "cross_20_vs_85": pair_rows(index, "C1-85", "C1-20", affect),
        "within_70_80": pair_rows(index, "C1-80", "C1-70", affect),
        "within_80_90": pair_rows(index, "C1-90", "C1-80", affect),
        "within_70_90": pair_rows(index, "C1-90", "C1-70", affect),
        "bound_66_vs_67": pair_rows(index, "C1-67", "C1-66", affect),
    }
    judged_pairs = {
        key: overlay_pairs(rows, index, args.timeout, args.workers)
        for key, rows in pair_sources.items()
        if rows
    }
    if not args.pairs_only:
        c1_cls = overlay_cls(records, ["C1-20", "C1-50", "C1-85"], args.timeout, args.workers)
        c2_cls = overlay_cls(records, ["C2-有点开心", "C2-一般开心", "C2-非常开心"], args.timeout, args.workers)
    else:
        c1_cls, c2_cls = [], []
    within = judged_pairs.get("within_70_80", []) + judged_pairs.get("within_80_90", []) + judged_pairs.get("within_70_90", [])
    pair_rates = {key: pairwise_win_rate(rows) for key, rows in judged_pairs.items()}
    pair_rates["within_708090"] = pairwise_win_rate(within)
    empty = {"left_rate": None, "n": 0, "left_wins": 0, "right_wins": 0, "ties": 0}
    c1_acc = tertiary_accuracy(c1_cls)
    c2_acc = tertiary_accuracy(c2_cls)
    fact_c0 = fact_rate(records, "C0")
    fact_c1 = fact_rate(records, "C1-85")
    fact_c2 = fact_rate(records, "C2-非常开心")
    metrics = {
        "c1_85_vs_c0": pair_rates.get("c1_85_vs_c0", empty),
        "c2_high_vs_c0": pair_rates.get("c2_high_vs_c0", empty),
        "c1_leak_rate": leak_rate(records, {"C1-20", "C1-50", "C1-85"}),
        "c2_leak_rate": leak_rate(records, {"C2-有点开心", "C2-一般开心", "C2-非常开心"}),
        "within_708090": pair_rates.get("within_708090", empty),
        "cross_20_vs_85": pair_rates.get("cross_20_vs_85", empty),
        "bound_66_vs_67": pair_rates.get("bound_66_vs_67", empty),
        "c2_accuracy": c2_acc["accuracy"] or 0.0,
        "c1_accuracy": c1_acc["accuracy"] or 0.0,
        "fact_gap": max(_gap(fact_c0, fact_c1), _gap(fact_c0, fact_c2), _gap(fact_c1, fact_c2)),
    }
    out = {
        "pair_rates": pair_rates,
        "c1_accuracy": c1_acc,
        "c2_accuracy": c2_acc,
        "verdicts": verdicts(metrics),
        "source": "llm",
        "pairs": judged_pairs,
        "classifications": {"c1": c1_cls, "c2": c2_cls},
    }
    path = ROOT / "results" / "judge.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"verdicts": out["verdicts"], "pair_rates": pair_rates, "c1": c1_acc, "c2": c2_acc}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
