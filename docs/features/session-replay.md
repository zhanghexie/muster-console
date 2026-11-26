# 用真实会话回放聊天

桌面工作台可以把一次真实 GUI 会话当作假模型的素材。在左栏选中会话后，开发者工具或窗口自动化只需调用一个函数。

```js
const take = await window.replaySession()
```

提问先出现在会话里，回答随后流式出现。工具卡依次展示原有输入、工作状态和结果。拍摄者可以自行滚动、展开工具详情、切会话或分屏。播放完会保留最后一帧，`take.stop()` 可以随时还原可操作的原会话。`await take.finished` 返回 `'finished'` 或 `'stopped'`。再调用一次即可从头拍。

在 macOS 录宣传片时，将工作台置于前台，用系统录屏框选窗口四边。自动化拍摄也可用 ScreenCaptureKit 采集显示器上对应的窗口区域，并排除通知。左栏和顶栏的毛玻璃由 macOS 与窗口背后的画面合成。用 Chromium 的 `Page.startScreencast` 采集会漏掉这层材质和红黄绿按钮。单独采集原生窗口也可能留下均匀灰色的侧栏。先从试录的成片里抽一帧，与同位置的工作台对照，再开始正式录制。[原生窗口材质](frame-backdrop.md)

## 复用一段素材

```js
const material = await window.api.agentSession.replayMaterial(sourceSessionId)
const take = await window.replaySession(material, targetSessionId, { speed: 1.5 })
```

来源可传会话 ID、导出的素材对象，或 `GuiChatMessage[]`。传来源 ID 并省略目标时在来源会话中播放；传素材对象并省略目标时使用当前会话。目标须是桌面工作台中已有的 GUI 聊天会话。普通工作台、开发沙箱、演示搭建和交互运行均可调用。

素材可用 `JSON.stringify(material)` 序列化到自己的本地文件，下次传入解析后的对象即可。拍某一轮时，可以挑出那条提问和回复。在原会话播放时，之前的问答从第一帧起就能向上翻阅，只有选中的消息会重新出字。

```js
const shot = { ...material, messages: material.messages.slice(start, end) }
const take = await window.replaySession(shot, sourceSessionId)
```

如果片段里的消息已经出现在目标会话中，工作台会保留第一条匹配消息之前的问答，再播放这段素材。来自另一段对话、消息 ID 全部不同的素材会接在目标会话末尾。每次重拍都从已保存的会话重新取历史。录完最后一帧后，调用 `take.stop()` 即可返回可编辑的完整会话，包括选段之后的轮次。

## 数据与边界

- `agentSession:replayMaterial` 验证来源后，经 `GuiSessionStore` 读取 GUI 投影和同一版本的本地事件日志。导出内容包括消息、附件、正文或思考分片的位置，以及当时的工具卡。构建选段前的历史时，第二个参数接收选段消息 ID，直接从目标投影取之前的消息，跳过分片日志。文件引用仍依赖原文件可访问。来源的审批请求、运行句柄和系统提示不会进入素材。
- `src/main/runtimeKernel/guiReplayMaterial.ts` 分页读取已有事件，把分片和最终消息逐一匹配。完整记录沿用实际分块和等待时间；旧会话、分叉或编辑导致某条回复缺少完整记录时，按最终正文分块，工具依次显示执行中和保存的结果。两轮之间的拍摄停顿固定为 600 毫秒，默认速度为 1。
- `src/shared/sessionReplay.ts` 的 `sessionReplayFrames(material)` 是可单独调用的生成器，输出延时、消息和忙碌状态。脚本和测试可把它当作假模型的消息源。
- `src/renderer/src/chatSurface/sessionReplay.ts` 在当前窗口为目标会话提供临时聊天内容。普通聊天组件负责 Markdown、流式显示和工具卡。源会话和目标会话的持久历史均保持原样。切走时播放继续，切回来可以接着看。同一目标再次播放会替换上一条，不同目标可以各自播放。
- 录制中出现的命令及创建 Worker、子代理等工具会展示其调用记录。回放本身不会发出模型请求、执行这些工具或创建子进程。CLI 终端画面和调度浮窗使用各自的数据格式。切屏、分屏和鼠标由拍摄者控制。

回归入口为 `test/unit/session-replay.spec.tsx` 和 `test/e2e/session-replay.spec.ts`。
