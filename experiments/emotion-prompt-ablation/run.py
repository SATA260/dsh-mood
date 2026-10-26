#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ablation import ROOT, build_jobs, detect_leakage, fact_correct, load_experiment, write_raw

PI = os.environ.get("PI_BIN", "pi")
RAW_DIR = ROOT / "results" / "raw"
SCRATCH = Path("/tmp/plain-chat")


def pi_print(system_prompt: str, user_text: str, timeout: int) -> dict:
    cmd = [
        PI,
        "--print",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-flash",
        "--thinking",
        "low",
        "--system-prompt",
        system_prompt,
        "--",
        user_text,
    ]
    started = time.time()
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(SCRATCH),
    )
    return {
        "returncode": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
        "latency_s": round(time.time() - started, 3),
        "cmd": cmd[:16] + ["<system>", "--", user_text],
    }


def run_job(job: dict, timeout: int, retries: int) -> dict:
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            result = pi_print(job["system_prompt"], job["user_text"], timeout)
        except subprocess.TimeoutExpired as exc:
            last_error = f"timeout after {timeout}s"
            result = {
                "returncode": 124,
                "stdout": "",
                "stderr": str(exc),
                "latency_s": timeout,
            }
        text = result["stdout"]
        if result["returncode"] == 0 and text:
            leak = detect_leakage(text, job["emotion"])
            fact = (
                fact_correct(job["probe_id"], text)
                if job["probe_id"] in {"fact", "bug"}
                else {"correct": None, "reason": "not_fact"}
            )
            record = {
                "id": job["id"],
                "wave": job["wave"],
                "condition_id": job["condition_id"],
                "condition": job["condition"],
                "emotion": job["emotion"],
                "probe_id": job["probe_id"],
                "repeat": job["repeat"],
                "system_prompt": job["system_prompt"],
                "user_text": job["user_text"],
                "text": text,
                "leakage": leak,
                "fact": fact,
                "latency_s": result["latency_s"],
                "attempt": attempt,
            }
            write_raw(RAW_DIR, record)
            return record
        last_error = result["stderr"] or f"empty stdout rc={result['returncode']}"
        time.sleep(min(2 * attempt, 8))
    record = {
        "id": job["id"],
        "wave": job["wave"],
        "condition_id": job["condition_id"],
        "error": last_error,
        "text": "",
    }
    write_raw(RAW_DIR, record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wave", action="append", dest="waves", default=[])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    waves = args.waves or ["main"]
    experiment = load_experiment(ROOT)
    jobs = build_jobs(experiment, waves)
    if not args.force:
        jobs = [job for job in jobs if not (RAW_DIR / f"{job['id']}.json").exists()]
    if args.limit:
        jobs = jobs[: args.limit]
    if args.dry_run:
        print(json.dumps({"count": len(jobs), "ids": [j["id"] for j in jobs]}, ensure_ascii=False, indent=2))
        return 0
    SCRATCH.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    ok = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_job, job, args.timeout, args.retries): job for job in jobs}
        for future in as_completed(futures):
            job = futures[future]
            try:
                record = future.result()
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"FAIL {job['id']}: {exc}", file=sys.stderr)
                continue
            if record.get("error"):
                failed += 1
                print(f"FAIL {record['id']}: {record['error']}", file=sys.stderr)
            else:
                ok += 1
                print(f"OK {record['id']} ({record['latency_s']}s)")
    print(json.dumps({"ok": ok, "failed": failed, "queued": len(jobs)}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
