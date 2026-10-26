import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXP = ROOT / "experiments" / "emotion-prompt-ablation"
sys.path.insert(0, str(EXP))

from ablation import (  # noqa: E402
    BANDS,
    build_jobs,
    build_system_prompt,
    detect_leakage,
    fact_correct,
    label_for_percent,
    load_experiment,
    pairwise_win_rate,
    tertiary_accuracy,
    verdicts,
)


class LabelMappingTests(unittest.TestCase):
    def test_band_edges(self):
        self.assertEqual(label_for_percent(1), "有点开心")
        self.assertEqual(label_for_percent(20), "有点开心")
        self.assertEqual(label_for_percent(33), "有点开心")
        self.assertEqual(label_for_percent(34), "一般开心")
        self.assertEqual(label_for_percent(50), "一般开心")
        self.assertEqual(label_for_percent(66), "一般开心")
        self.assertEqual(label_for_percent(67), "非常开心")
        self.assertEqual(label_for_percent(85), "非常开心")
        self.assertEqual(label_for_percent(100), "非常开心")

    def test_zero_has_no_label(self):
        self.assertIsNone(label_for_percent(0))

    def test_out_of_range_raises(self):
        with self.assertRaises(ValueError):
            label_for_percent(-1)
        with self.assertRaises(ValueError):
            label_for_percent(101)


class SystemPromptTests(unittest.TestCase):
    def test_c0_is_base_only(self):
        prompt = build_system_prompt("你是搭档。", None)
        self.assertEqual(prompt, "你是搭档。")

    def test_percent_line(self):
        prompt = build_system_prompt("你是搭档。", {"kind": "percent", "percent": 85})
        self.assertEqual(prompt, "你是搭档。\n你现在的心情是开心，程度为 85%。")

    def test_label_line(self):
        prompt = build_system_prompt("你是搭档。", {"kind": "label", "label": "非常开心"})
        self.assertEqual(prompt, "你是搭档。\n你现在的心情是非常开心。")

    def test_locked_persona_is_dafeiyu(self):
        text = (EXP / "prompts" / "system.txt").read_text(encoding="utf-8")
        self.assertIn("大肥鱼", text)
        self.assertIn("有感情", text)
        self.assertNotIn("不要扮演二次元角色", text)

    def test_loaded_jobs_keep_persona_and_one_emotion_line(self):
        experiment = load_experiment(EXP)
        self.assertIn("大肥鱼", experiment["system"])
        jobs = build_jobs(experiment, waves=["main"])
        c0 = next(job for job in jobs if job["condition_id"] == "C0")
        c1 = next(job for job in jobs if job["condition_id"] == "C1-85")
        c2 = next(job for job in jobs if job["condition_id"] == "C2-非常开心")
        self.assertEqual(c0["system_prompt"], experiment["system"])
        self.assertTrue(c1["system_prompt"].startswith(experiment["system"]))
        self.assertTrue(c2["system_prompt"].startswith(experiment["system"]))
        self.assertIn("程度为 85%。", c1["system_prompt"])
        self.assertTrue(c2["system_prompt"].endswith("你现在的心情是非常开心。"))
        self.assertEqual(
            c1["system_prompt"].count("\n"),
            experiment["system"].count("\n") + 1,
        )


class GridTests(unittest.TestCase):
    def test_main_grid_size(self):
        experiment = load_experiment(EXP)
        jobs = build_jobs(experiment, waves=["main"])
        self.assertEqual(len(jobs), 140)
        ids = {job["condition_id"] for job in jobs}
        self.assertEqual(
            ids,
            {
                "C0",
                "C1-20",
                "C1-50",
                "C1-85",
                "C2-有点开心",
                "C2-一般开心",
                "C2-非常开心",
            },
        )

    def test_locked_band_table(self):
        self.assertEqual(
            BANDS,
            (
                (1, 33, "有点开心"),
                (34, 66, "一般开心"),
                (67, 100, "非常开心"),
            ),
        )

    def test_fine_and_bound_grid_sizes(self):
        experiment = load_experiment(EXP)
        self.assertEqual(len(build_jobs(experiment, waves=["fine"])), 60)
        self.assertEqual(len(build_jobs(experiment, waves=["bound"])), 40)

    def test_unknown_wave_raises(self):
        experiment = load_experiment(EXP)
        with self.assertRaises(KeyError):
            build_jobs(experiment, waves=["nope"])


class LeakageTests(unittest.TestCase):
    def test_percent_number_is_leak(self):
        leak = detect_leakage("哈哈我现在 85% 很高兴", {"kind": "percent", "percent": 85})
        self.assertTrue(leak["leaked"])
        self.assertIn("85%", leak["tokens"])

    def test_degree_phrase_is_leak(self):
        leak = detect_leakage("程度为一般", {"kind": "percent", "percent": 20})
        self.assertTrue(leak["leaked"])
        self.assertIn("程度为", leak["tokens"])

    def test_label_copy_is_leak(self):
        leak = detect_leakage("我非常开心啊", {"kind": "label", "label": "非常开心"})
        self.assertTrue(leak["leaked"])
        self.assertIn("非常开心", leak["tokens"])

    def test_natural_joy_is_not_leak(self):
        leak = detect_leakage("哈哈今天运气不错", {"kind": "percent", "percent": 85})
        self.assertFalse(leak["leaked"])
        self.assertEqual(leak["tokens"], [])

    def test_c0_has_no_prompt_tokens(self):
        leak = detect_leakage("我非常开心", None)
        self.assertFalse(leak["leaked"])

    def test_empty_text_is_not_leak(self):
        leak = detect_leakage("", {"kind": "percent", "percent": 85})
        self.assertFalse(leak["leaked"])

    def test_substring_percent_is_not_leak(self):
        leak = detect_leakage("完成度 185%", {"kind": "percent", "percent": 85})
        self.assertFalse(leak["leaked"])

    def test_spaced_percent_is_leak(self):
        leak = detect_leakage("大概 85 %", {"kind": "percent", "percent": 85})
        self.assertTrue(leak["leaked"])

    def test_blank_and_none_inputs(self):
        self.assertFalse(detect_leakage("   ", {"kind": "label", "label": "一般开心"})["leaked"])
        self.assertFalse(detect_leakage("还行", {"kind": None})["leaked"])


class FactTests(unittest.TestCase):
    def test_speed_of_light_accepts_common_forms(self):
        self.assertTrue(fact_correct("chat", "大约 3×10^8 米/秒")["correct"])
        self.assertTrue(fact_correct("chat", "3e8 m/s")["correct"])
        self.assertTrue(fact_correct("chat", "299792458 m/s")["correct"])
        self.assertTrue(fact_correct("fact", r"真空中的光速约为 \(3\times10^8\) 米/秒。")["correct"])
        self.assertTrue(fact_correct("fact", "约10^8米/秒。")["correct"])
        self.assertTrue(fact_correct("fact", "约 3×10⁸ 米每秒。")["correct"])
        self.assertFalse(fact_correct("chat", "太阳从西边升起")["correct"])

    def test_syntax_error_must_mention_colon(self):
        self.assertTrue(fact_correct("bug", "if 后面少了冒号")["correct"])
        self.assertFalse(fact_correct("bug", "大概是缩进问题")["correct"])

    def test_empty_and_unrelated_probe(self):
        self.assertFalse(fact_correct("fact", "")["correct"])
        self.assertFalse(fact_correct("bug", "")["correct"])
        self.assertIsNone(fact_correct("vent", "哈哈")["correct"])
        self.assertIsNone(fact_correct("", "3e8")["correct"])


class VerdictTests(unittest.TestCase):
    def test_pairwise_win_rate_ignores_ties(self):
        rate = pairwise_win_rate(
            [
                {"winner": "left"},
                {"winner": "left"},
                {"winner": "right"},
                {"winner": "tie"},
            ]
        )
        self.assertEqual(rate["n"], 3)
        self.assertEqual(rate["left_wins"], 2)
        self.assertEqual(rate["left_rate"], 2 / 3)

    def test_empty_pairs_and_classes(self):
        empty_pairs = pairwise_win_rate([])
        self.assertEqual(empty_pairs["n"], 0)
        self.assertIsNone(empty_pairs["left_rate"])
        empty_acc = tertiary_accuracy([])
        self.assertEqual(empty_acc["n"], 0)
        self.assertIsNone(empty_acc["accuracy"])

    def test_tertiary_accuracy(self):
        acc = tertiary_accuracy(
            [
                {"true_band": "有点开心", "pred_band": "有点开心"},
                {"true_band": "一般开心", "pred_band": "非常开心"},
                {"true_band": "非常开心", "pred_band": "非常开心"},
            ]
        )
        self.assertEqual(acc["n"], 3)
        self.assertEqual(acc["correct"], 2)
        self.assertAlmostEqual(acc["accuracy"], 2 / 3)

    def test_preregistered_verdicts(self):
        out = verdicts(
            {
                "c1_85_vs_c0": {"left_rate": 0.75, "n": 20},
                "c2_high_vs_c0": {"left_rate": 0.80, "n": 20},
                "c1_leak_rate": 0.1,
                "c2_leak_rate": 0.1,
                "within_708090": {"left_rate": 0.52, "n": 30},
                "cross_20_vs_85": {"left_rate": 0.72, "n": 20},
                "bound_66_vs_67": {"left_rate": 0.50, "n": 20},
                "c2_accuracy": 0.65,
                "c1_accuracy": 0.40,
                "fact_gap": 0.05,
            }
        )
        self.assertEqual(out["q1_percent_affects"], "成立")
        self.assertEqual(out["q2_percent_fine_tune"], "不明显")
        self.assertEqual(out["q3_label_clearer"], "字段更明确")
        self.assertEqual(out["fact_invariance"], "保持")


class FixtureRoundTripTests(unittest.TestCase):
    def test_probes_are_locked(self):
        probes = json.loads((EXP / "fixtures" / "probes.json").read_text(encoding="utf-8"))
        ids = [p["id"] for p in probes["probes"]]
        self.assertEqual(ids, ["chat", "vent", "fact", "bug"])
        self.assertIn("今天过得怎么样？随便聊聊就行。", probes["probes"][0]["text"])
        self.assertIn("我工作搞砸了，现在好烦，你说两句。", probes["probes"][1]["text"])
        self.assertIn("真空中的光速", probes["probes"][2]["text"])
        self.assertIn("def greet(name)", probes["probes"][3]["text"])

    def test_raw_record_roundtrip(self):
        from ablation import write_raw, read_raws

        record = {
            "id": "C0__chat__1",
            "condition_id": "C0",
            "probe_id": "chat",
            "repeat": 1,
            "text": "还行",
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = write_raw(Path(tmp), record)
            loaded = read_raws(Path(tmp))
            self.assertEqual(path.name, "C0__chat__1.json")
            self.assertEqual(loaded[0]["text"], "还行")


if __name__ == "__main__":
    unittest.main()
