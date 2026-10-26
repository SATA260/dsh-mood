# 情绪提示词对照实验

用本地 `pi`（`deepseek-flash`）比较三种系统提示词注入。公共底座是人格 **大肥鱼**：有感情的鲜活 AI，会按当下心情说话。只测悲喜轴正向（开心）。

C0 是「有人格、未标明当前情绪」，不是「毫无情绪许可」。C1 / C2 只在底座后追加一行百分比或字段。

## 三个问题

1. 直接写「开心 + N%」会不会改变输出？
2. 百分比细调（70 / 80 / 90）明不明显？
3. 映射成「有点开心 / 一般开心 / 非常开心」是否更清楚？

判定标准写在 [score/rubric.md](score/rubric.md)，跑完再看结果。

## 锁定映射

| 百分比 | 字段 | 锚点 |
|---|---|---|
| 1–33 | 有点开心 | 20% |
| 34–66 | 一般开心 | 50% |
| 67–100 | 非常开心 | 85% |

## 复现

每一发都关掉编码人设、工具、扩展（含 jev-reply）和会话：

```bash
cd experiments/emotion-prompt-ablation
python3 run.py --wave main
python3 analyze.py
python3 judge.py
```

主网格是 C0 + 跨档 C1/C2，共 140 次。信号够再跑同档和边界：

```bash
python3 run.py --wave fine
python3 run.py --wave bound
python3 analyze.py
```

`--dry-run` 只打印任务；`--limit N` 冒烟；已有 `results/raw/*.json` 会跳过，`--force` 才重跑。

## 文件

- `prompts/system.txt`：锁定人格「大肥鱼」
- `prompts/`：情绪追加行
- `results/raw-v1-no-persona/`：上一轮无人格底座的归档，不参与本轮统计
- `fixtures/`：探针与条件表
- `run.py`：隔离调用 pi
- `analyze.py`：泄漏、词典分、盲评表、预先登记结论
- `judge.py`：同一套标准的 flash 副评
- `results/summary.json`：汇总
- `score/blind_sheet.csv`：打乱后的人工表（`hidden_*` 评完再看）
- `results/findings.md`：大肥鱼底座本轮结论

本轮结论：百分比能改输出；70/80/90 仍能分出高低，字段三档并不更清楚。详见 findings。
