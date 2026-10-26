# 维度拆分图

> 以下为早期讨论图，保留作历史参考。其中的心境、层次与参数拆分不代表当前规范。当前方案为情绪与性格两层状态、A/B/C 三个模块，以 [功能文档](../功能文档.md) 和 [模块设计](../模块设计.md) 为准，完整数学定义见 [模块 B 的技术附录](../模块B-性格与情绪.md#技术附录)。

两张图对应早期的同一套拆分：

- `overview.png` — 一套引擎、四类变量：慢变量如何接到情绪链的各个环节，心境如何反馈。
- `fold.png` — 上次那六层性格因素分别折叠到了哪里。

源文件在 `src/`，改完后用 Chrome headless 重新渲染：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --user-data-dir=/tmp/chrome-diagram \
  --screenshot=overview.png --window-size=1680,1190 \
  "file://$PWD/src/overview.html"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --user-data-dir=/tmp/chrome-diagram \
  --screenshot=fold.png --window-size=1680,1040 \
  "file://$PWD/src/fold.html"
```

核心一句话：性格不是情绪流程里的第六步，它是流程上每一步的参数。
