# 文本工具（划词 AI 功能）

划词浮条上的可自定义 AI 功能：内置「翻译」，用户可在设置里增删改任意功能（整理成表格、去掉语气词等），全部通过"名称 + 提示词"定义，点击后由大模型对选中文本做一次非流式处理，结果在浮层卡片中展示。

设置中每项文本功能使用统一 224px 列表与详情布局，列表行复用 SettingsResourceItem，详情标题和操作层级复用 SettingsDetailHeader；字段标签与其他设置项同为三级标题，说明另行展示。窄容器仍在列表下方编辑，切换保留草稿。

## 职责

- 划词浮条动态渲染用户启用的文本工具按钮（终端/Agent 聊天/文件区/Diff 等所有划词区域生效）
- 主进程代调 LLM（OpenAI 兼容 `chat/completions` 与 `responses` 两种协议），apiKey 只在主进程使用
- 模型逐级回落：功能自带 `providerId/modelId` → 功能组默认 → 全局 active（复用 `resolveLlmConfig`）
- 设置页「文本工具」分区：功能列表管理、每功能选模型、功能组默认模型、「AI 帮写提示词」

## 关键文件与入口

| 文件 | 职责 |
|---|---|
| `src/shared/textTools.ts` | 内置翻译定义、AI 帮写元提示词、`normalizeTextTools` 校验 |
| `src/shared/types.ts` | `TextToolFunction` / `TextToolsConfig` / `TextToolRunRequest` / `TextToolRunResult`，挂在 `AppConfig.textTools?` |
| `src/main/config.ts` | `DEFAULT_CONFIG.textTools`（含内置翻译）、normalize 调用、save 白名单 |
| `src/main/textTools/runTextTool.ts` | 执行器：模型回落解析 + 非流式请求（60s 超时、输入截断 24k 字、max_tokens 4096） |
| `src/main/ipc/textTools.ts` | `textTools:run` IPC（入参收紧 + 长度钳制） |
| `src/preload/index.ts` | `window.api.textTools.run(req)` |
| `src/renderer/src/components/textToolsClient.ts` | 配置缓存（浮条打开时刷新） |
| `src/renderer/src/components/textToolRunner.ts` | 运行状态单例（单一在途请求，新请求/关闭即放弃旧结果） |
| `src/renderer/src/components/selectionMenuAreas.ts` | `contentItems` 末尾追加工具按钮（`textTools` 由宿主传入，builder 保持纯函数） |
| `src/renderer/src/components/SelectionMenuHost.tsx` | 持有启用工具快照、挂载结果卡 |
| `src/renderer/src/components/TextToolResultCard.tsx` | 结果卡：markdown 渲染、复制/重新生成/关闭、贴浮条原位 |
| `src/renderer/src/components/settings/TextToolsPane.tsx` | 设置页分区（`{cfg, set}` 草稿模式，随底部「保存」生效） |
| `src/shared/commandPalette.ts` | `SETTINGS_TABS` 的 `textTools` 分区与「功能默认模型」可搜条目 |

## 数据流 / IPC

```
浮条按钮点击
  → renderer textToolRunner.startTextToolRun(fn, text, barRect)（生成 runId）
  → ipc textTools:run {name, prompt, providerId?, modelId?, text, runId}
  → runTextTool: resolveTextToolLlm（功能 → 功能组默认 → 全局 active）
      ├ openai-completions → {base(/v1 自动补)}/chat/completions  [system=prompt, user=text]
      │   带 runId 时 stream:true；onStart 先推 modelLabel，SSE 解析
      │   delta.content（正文）与 delta.reasoning_content（思考段，只报一次标志）；
      │   流中途 data:{"error":…}（OpenAI 兼容网关常见）立即中断并抛出真实错误，
      │   不再以「模型返回空内容」掩盖配额/审查/网关故障
      └ openai-responses   → {base}/responses                     [instructions=prompt, input=text]
  → 事件 textTools:chunk {runId, delta, modelLabel?, reasoning?}
  → 结果卡即时弹出：统一 IconSpinner（与左栏工作中同一套 `--spinner-*`）+ 实际模型名 + 秒数计时 → 思考中/流式 markdown → 完成/错误
  → invoke 返回 {text, modelLabel} 为权威全文
```

配置读写复用既有 `config:get/update`，无新增配置通道。anthropic-messages 等其他协议返回明确报错「暂不支持，请换 OpenAI 兼容模型」；错误文案统一走 `t()`（缺凭证报「「{{name}}」未配置 baseUrl/apiKey（设置 → 模型服务商）」，LLM 上游返回体等诊断细节保留原文）。

结果卡宿主挂在 `App.tsx` 根部（**不随浮条卸载**——浮条点击即收起，卡片要独立存活展示进行中/结果）。

## 交互与已知边界

设置页使用共享平铺模板，默认模型与功能管理分段。功能管理的 AI 创建入口下方为功能列表与独立编辑区，选中功能后编辑名称、模型、显示开关和提示词；切换保留草稿。窄布局将功能列表放在编辑区上方，不再使用每个功能一层手风琴。

- 点击工具按钮：收起浮条、清选区、**立即弹结果卡**——统一 IconSpinner + 实际「服务商·模型」+ 秒数计时；模型思考段显示"模型思考中…"，正文首个 token 起流式渲染（尾部闪烁光标、自动贴底）；**关闭结果卡只是界面不再消费——不取消主进程的模型请求**，该请求仍跑到 60s 超时兜底后结束（渲染层按 runId 对齐丢弃过期结果）；「重新生成」复用原功能快照与原文
- 流式仅 openai-completions 协议支持；responses 协议与「AI 帮写提示词」为非流式（一次性返回）
- **关闭思考（默认开）**：按模型/网关尽力附加关闭深度思考参数——Qwen 系 `enable_thinking:false`(+chat_template_kwargs)、GLM/豆包 `thinking:{type:'disabled'}`、GPT-5 `reasoning_effort:'minimal'`、o 系/grok/gemini `'low'`、OpenRouter `reasoning:{enabled:false}`；未识别的模型不附加（防严格网关 400）。**DeepSeek reasoner 官方无关闭参数**，要快请选 `deepseek-chat` 非思考版。设置页每功能有「关闭思考」开关
- **慢的常见原因**：解析到的模型是推理类——思考段会显示"模型思考中…"+计时；关闭思考对支持的模型能直接省掉等待
- 设置保存后浮条**下次打开**即拿到新列表，无需重启；「在浮条显示」开关只影响展示，配置保留
- 空提示词的功能可以保存（草稿不丢），点击时报「提示词为空」；删除全部功能后浮条不再显示工具按钮，可在设置页「恢复内置翻译」
- 「AI 帮写提示词」用功能默认模型执行 `TEXT_TOOL_AI_META_PROMPT`，产出严格 JSON（容错剥代码围栏），生成后填入表单可再手改
- 输入超过 24k 字符截断；结果卡为单例，同时只保留一个任务（新请求顶掉旧的，chunk 按 runId 对齐丢弃过期流）
- 测试：`test/text-tools.mjs`（归一化 / 回落链 / 两种协议请求构造 / SSE 流式 / 防御性报错），运行 `node test/text-tools.mjs`

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：划词浮条自定义 AI 功能（内置翻译+用户自建「名称+提示词」），点击后主进程代调 LLM 对选中文本做一次处理，结果卡展示。
- 为什么这样设计：模型逐级回落（功能自带→功能组默认→全局 active）；apiKey 只在主进程；结果卡挂 App 根独立存活不随浮条卸载；关闭思考按模型尽力附加、未识别模型不附加（防严格网关 400）；单例结果卡新请求顶旧、chunk 按 runId 对齐丢弃过期流。
- 明确不做：仅 openai-completions/responses 双协议；输入 24k 截断；不做并行多任务；DeepSeek reasoner 官方无关闭参数（明示边界）。
- 歧义点：协议面——A=长期双协议（划词为低频轻工具，维护第三协议成本大于收益；报错文案引导换模型）／B=补 anthropic-messages（文档措辞「暂不支持」隐含可扩展）。推荐 A；若用户实际主用 anthropic 协议则升 B。
