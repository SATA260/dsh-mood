# 模块 C：表情包管理

**版本：v1.0 · 日期：2026-10-26**

[总文档](功能文档.md) · [模块 A](模块A-提示词管理.md) · [模块 B](模块B-性格与情绪.md) · [模块 C](模块C-表情包管理.md)

## 功能职责

维护内置 DeepSeek 表情素材目录，在模型回复给出表情 ID 时提供对应图片。

- 管理稳定 ID、标签、简短说明及图片资源的可用状态。
- 提供轻量目录供 A 注入，让模型知道可选表情。
- 按选出的 ID 校验并取图，交给宿主随文字显示。

## 边界

- 已确定由主模型在回复中选择 ID，不自动根据 B 的情绪配图，也不新增发表情工具。
- C 不计算情绪，不改写模型回复，不将发表情或夸张措辞写回 B。
- 表情允许反讽与调侃，不因它与当前情绪不一致而拒绝。
- 每条回复最多一张；无 ID 则无图，非法 ID 或资源失败时保留完整文字。
- 首版是聊天图片；动作形象和语音动画留待后续。

## 内部拆分

**素材目录**维护稳定 ID、标签和说明，只输出元数据，不预先读取全部图片。

**按需取图**校验回复中的 ID 和资源可用性，输出一张可显示图片或明确的降级结果。

## 流程

每轮用户消息开始时，宿主从 C 取得目录交给 A。主模型交流时按需在回复中附上一个 ID；宿主提取 ID 后请求 C，取得图片并显示。整个过程不改变 B 的数值。

## 技术附录

### 数据与接口伪代码

以下为业务接口规划，不约束实际开发语言。

```go
type StickerMetadata struct {
    ID          string
    Tags        []string
    Description string
}

type StickerResult struct {
    Available bool
    ID        string
    ImageRef  string // 供宿主显示的内部图片引用
}

func (StickerManager) Catalog() ([]StickerMetadata, error) // 提供可选表情的 ID、标签和说明，不预先加载所有图片。
func (StickerManager) Resolve(stickerID string) (StickerResult, error) // 校验模型选出的 ID 并按需提供一张图片，无效或缺失时返回降级结果。
```

元数据记录还应在 C 内部关联图片资源与可用状态；Catalog 仅向外给出 ID、标签和说明。ID 是稳定标识，不依赖图片文件名的临时变化。

### 回复与解析约定

模型在最终回复末尾另起一行，使用已有目录中的稳定 ID：

```text
这次总算跑通了。

[dsh-mood-sticker]: smile
```

这是 Markdown 引用定义，宿主不会把它显示为最终正文。C 只解析已结算回复的根级定义，忽略代码块、缩进代码和引用块；多个合法 ID 只取第一个。未知 ID、缺图或图片加载失败均保留正常文字。目录沿用现有 32 个 ID。

客户端通过 Conversation 扩展生成图片节点，历史重放沿用相同解析规则。图片使用宿主 WebServer 的插件资源路径 `/plugins/dsh-mood/assets/<file>`，仅允许目录内文件，支持 GET／HEAD 和 ETag；不启动额外 HTTP 服务。固定版本 SDK 不自动把 package exports 中的图片变成 HTTP 资源，因此 C 显式注册这条宿主资源路由。宿主卸载插件时一并撤销。

### 调用顺序

```go
catalog := StickerManager.Catalog()
blocks := PromptManager.Build(rules, map[string]any{"state": state, "stickers": catalog})
image := StickerManager.Resolve(reply.StickerID)
Host.RenderReply(reply.Text, image)
```

### 素材与降级核对

标签覆盖悲伤/喜悦、厌恶/喜欢、愤怒、恐惧/焦虑、惊讶；标签可以复用，不要求情绪分类与图片张数一一对应。标签用于帮助模型表达，不是自动配图规则。

核对目录 ID 唯一且可稳定解析；不在开场读取全部图片；未知 ID、缺图和读取失败均降级为纯文本；每条回复最多一图；反讽选择可用；C 的查询、取图和显示均不触发 B 的状态写入。

### 桌面 App 资源读取（0.1.1）

桌面界面使用 `dsh-app://`，由 C 提供独立的只读 `moodStickers/getImage` Remote 接口，经宿主 IPC 返回目录内 JPEG 的 data URL。未知 ID 或缺图返回空结果，正常文字继续显示。C 不访问 B 的数据库，不新增 LLM 工具。客户端只在桌面选择该通道；Web 继续使用资源路由。
