# 子代理职业角色与头像

> 状态：已实现（2026-10-20）。关联：[会话树](sessions-dock.md#10-会话树子代理缩进挂父下子代理通用化) · [消息头像](chat-message-avatar.md)。

新通信统一为 [宿主邮箱](session-mailbox.md)，不再自动注入子代理汇报气泡；职业头像继续用于会话身份和旧 sourceAgent 历史。

## 职责与行为

子代理创建时从 24 个内置职业角色中选择身份。角色提供固定名字、职业和头像；会话名形如「像素 · 按钮布局」。名字后半段是任务短名，允许正常重命名；角色不改变 runtime、模型、权限、工具能力或系统人格。

`sessions.create(asSubagent=true)` 的头像由宿主按内置目录轮流分配，用于外观和区分，不按任务职业选择。模型面不再提供 characterId；任务短名仍由 name 提供，宿主组合显示名。轮选游标在宿主进程内递增并循环，重启从头开始；旧会话头像不变。排队输入保存已分配 ID，同一 creationKey 重试沿用已创建会话的头像，避免重放换脸。旧调用显式 characterId 仍接受白名单校验，不推进轮选游标；出队重放不重复添加名字前缀。

| ID | 名字 | 职业 | ID | 名字 | 职业 |
|---|---|---|---|---|---|
| pixel | 像素 | 设计师 | rivet | 铆钉 | 工程师 |
| quantum | 量子 | 科学家 | welder | 小焊 | 蓝领技师 |
| scout | 星探 | 探索者 | sentinel | 哨兵 | 安全员 |
| compass | 罗盘 | 产品经理 | joinery | 榫卯 | 架构师 |
| atlas | 星图 | 数据分析师 | pi | 小派 | 数学家 |
| bubble | 泡泡 | 测试员 | wrench | 扳手 | 运维师 |
| bookmark | 书签 | 图书管理员 | ink | 墨墨 | 作家 |
| bridge | 语桥 | 翻译家 | bean | 智豆 | 教师 |
| healer | 小愈 | 医生 | sprout | 萌芽 | 园丁 |
| stew | 小炖 | 厨师 | note | 音符 | 音乐家 |
| palette | 彩彩 | 艺术家 | shutter | 快门 | 摄影师 |
| scales | 法尺 | 法律顾问 | courier | 信使 | 协调员 |

## 关键文件与数据流

- `src/shared/subagentCharacters.ts`：目录、关键词、类型、名字组合及消息身份白名单归一；主进程与渲染层同源。
- `src/main/capabilities/catalog/sessionsCore.ts`（工具枚举）→ `src/main/capabilities/hosts/sessions.ts` + `hosts/creation.ts`（asSubagent 注入父身份；模型传入 characterId 出现即拒，F-04）→ `main/tasks/delegate.ts`：宿主绑定父身份、按内置目录轮选解析角色；`sessions/createTerminal.ts` 将角色写到子会话 `SessionMeta.subagentCharacterId`，普通顶层会话不带此字段；显式角色仅剩内部可信路径（重试复用/队列重入直调 delegateTask）。
- `src/main/agent/injection-registry.ts`：沿用并更新 `worker.tool-schema.host-tools` 注入注册项；角色选择没有新增独立提示词注入或整段人格模板。
- `src/main/messages/deliver.ts`：从发送者会话读取身份，形成 `sourceAgent={sessionId,name,characterId?}` 快照，经内部 `sessions.message` 进入 `AgentSessionHost.send`；模型不能通过消息正文指定头像。
- `src/main/agentSession/host/messaging.ts` → `shared/guiWorker.ts` → `main/agentSession/persist.ts`：消息依然按 user 角色送引擎，`source=agent` 区分来源；排队、出队、V2 历史、旧记录迁移和分叉复制保留身份快照。
- `renderer/src/chatSurface/guiMessageView.tsx` → `components/ChatMessageView.tsx` → `shared/userAvatar.ts` / `components/ChatMessageAvatar.tsx`：使用发送者快照解析内置图片和悬浮名字（会话名 + 职业），右侧沿用 28px 头像槽。`styles/chat.css` 对 agent 图片去掉圆形底盘/描边和裁角，显示透明符号；用户、调度和宿主身份各自独立。

主动 `sessions.message({to: "parent",text})` 的进度/提问/决策请求、自动首次回音和终态通知均走同一个投递核，所以使用同一角色头像。历史中保存发送时的名字与角色，发送者随后改名或删除不会更改旧报告的头像。缺少角色的旧 agent 消息回落工程师头像，不从正文猜身份；缺少具体发送者的旧记录仍不合并连续头像。终端接收方继续收到文本，不新增终端图片协议。

头像选择器中的内置名字与职业、消息头像的职业标签在展示时随语言切换；已保存的会话名与发送者身份快照保持原值，不会被翻译或改写。

## 图片资源

采用用户最终确认的简约扁平几何符号，完全去除人物形象与复杂材质；每个角色用少量色块与留白暗示职业职责。来源、精确裁切坐标与重建脚本见 [设计来源](../prototypes/subagent-avatars/README.md)。每张为 256×256 透明 WebP，符号等比居中放入 208px 区域，四边各留 24px；24 张合计 239542 字节。预览原图的深色背景经颜色分离去掉，保留内部原色，并恢复边缘 alpha，兼容深浅背景。原卡通图仅留作历史设计来源，不再作为运行时资源。

`src/renderer/src/subagentAvatars.ts` 静态导入 `assets/subagents/*.webp`，构建器把它们发到本地资源包；无需网络、用户上传或运行时生图。角色 ID、名字、选角与消息身份接线保持一致，因此已有角色记录也自动显示新图。`assets.d.ts` 声明图片模块，测试编译入口也显式引用该声明。Windows/macOS/Linux 共用元数据与静态资源实现，没有新增平台分支。

用户也可在「设置 → 外观 → 你的头像」中手动选择这 24 个符号，配置仅保存内置 id；不会改变用户显示名或把用户消息标为代理。其设置、即时更新与持久化见 [会话消息头像](chat-message-avatar.md)。工作区另有 [软件/游戏分类图标](workspace-icons.md)，不混用职业目录。

## 验证与边界

- `test/subagent-characters.mjs`：24 张资源及名字唯一性、256px 尺寸与透明 WebP 标志、选择/兜底、校验、命名前缀、消息相等性、JSON/迁移/历史文件重载、分叉、会话构造与工具目录。
- `test/subagent-role-delegation.mjs`：实际 tools host → delegate → session builder，覆盖显式选择、缺省选择和无效角色的建立前拒绝。
- `test/sessions-message.mjs`、`test/gui-host-lifecycle.mjs`：主动与自动汇报传递身份，真实宿主忙时排队及出队保留快照。
- `test/unit/chat-message-avatar.spec.tsx`：全部 24 角色经过 GUI 消息转换后显示对应本地图片，历史身份不依赖接收方会话名称；用户/调度/宿主原行为保留。
- `test/e2e/subagent-role-avatar.spec.ts`：独立沙箱和本地模型桩，真实 Electron/Pi 工具派活、角色名/元数据、主动汇报、渲染资源与历史落盘。旧调用固定角色的兼容用例仍保留；宿主轮选与排队/创建重试稳定性由离线派活测试覆盖。
- 生产组件 Chromium 截图检查深/浅主题、780/390px 画布；实际报告头像仍为 28px，另用 64px 画廊检查裁切，并断言 agent 图片槽背景/边框透明、无圆角裁切。简约版截图在本机 `.tmp/ui-captures/subagent-flat-avatars/`，独立 88/28px 深浅底资源对照在 `.tmp/subagent-flat-avatars/`，不入正式资源。

类型检查、应用构建与定向回归按变更范围运行；macOS/Linux 真机仍需目标环境验收；头像分配为跨平台共享逻辑。

## 设计初衷（2026-10-25 与用户确认）

- 为谁/什么场景：多子代理并行时，人需要在会话树/看板/聊天里一眼区分「谁在说话、谁完成了什么」。
- 为什么这样设计：纯外观身份——24 个扁平几何角色（去人物形象），宿主轮选分配（刻意不按任务匹配职业），只影响显示名与头像；历史快照不随改名/删除漂移；与用户头像、工作区图标体系互不混用。
- 明确不做：不改 runtime/模型/权限/工具能力/系统人格，不注入人格提示词，不按任务智能选角。
- 已确认取舍（2026-10-25 问答卡片）：**锁定纯外观**——永不向人格/分工语义演化；keywords/SUBAGENT_CHARACTER_CHOICES 死数据随 D02 修复批删除（已授权）。
