# dsh-mood

DeepSeek Harness 情绪、性格与表情包插件。插件 **0.1.5**，兼容 **DSH 0.2.1-rc.2 / 0.2.1-rc.3**，Node.js **22.19+（22.x）或 24+**。

状态面板以两个雷达图展示情绪和性格。点击各自的“编辑”打开数值调整弹窗，支持保存、取消和并发冲突检查。

聊天只自然表达感受，内部数值与更新过程留在面板。单个真实事件即可微量塑造性格；“变化规则”可分别配置情绪、性格的单事件上限、滚动时间与每项累计额度，保存后立即生效。

每轮注入数值，由模型自主调用两个状态工具，代码计算并限速。一个 profile 共用一个搭档，内置 32 张表情和“搭档状态”面板。

在已初始化的 Web profile 中安装预构建包，无须编译：

```sh
dsh plugin --profile web add ./dsh-mood-0.1.5.tgz
dsh web
```

桌面 App 使用其附带的 `dsh` 命令，将上述安装命令中的 `--profile web` 改为 `--profile desktop`，安装后重新打开 App。桌面表情通过 IPC 读取，Web 表情使用宿主资源路由。

[安装与配置](docs/安装指南.md) · [配置示例](docs/配置示例.yml) · [验收记录](docs/验收记录.md)

开发验证：`pnpm install`、`pnpm run typecheck`、`pnpm test`、`pnpm run build`、`pnpm run pack:check`。完整 Web 验收运行 `pnpm run test:web`，会在临时 profile 中安装 tarball 并使用无密钥模型，需已安装 Playwright Chromium。

正式设计文档版本为 **v1.0**，每份文档末尾附技术说明。

| 文档 | 本地内容 | GitHub issue |
| :--- | :--- | :--- |
| 总文档 | [文档](docs/功能文档.md) | [#1](https://github.com/SATA260/dsh-mood/issues/1) |
| 模块 A：系统提示词管理与注入 | [文档](docs/模块A-提示词管理.md) | [#2](https://github.com/SATA260/dsh-mood/issues/2) |
| 模块 B：性格与情绪 | [文档](docs/模块B-性格与情绪.md) | [#3](https://github.com/SATA260/dsh-mood/issues/3) |
| 模块 C：表情包管理 | [文档](docs/模块C-表情包管理.md) | [#4](https://github.com/SATA260/dsh-mood/issues/4) |
