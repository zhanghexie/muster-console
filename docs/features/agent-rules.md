# 全局行为规约（Agent Rules）

在设置 → 调度 Agent →「全局行为规约」维护工作台启动的 Agent 所用规则。

## 数据模型

`AppConfig.agentRules: Array<{ id, text, enabled }>`（config.json）。

- 字段缺失（老配置首启）→ 由 `normalizeAgentRules` 填充种子规则「异常上报」（列典型情形 + 分级通道：needs_you / 对话说明 / ui.notify）。种子是普通条目，可改可删可停用。
- 显式 `[]` = 用户删空 = 关闭机制：所有注入面整体不出现规约节，无残留。
- 空文本条目在归一时丢弃；渲染时 `enabled=false` 跳过。
- 默认异常上报规则不再要求修改契约文件前确认。已保存的 `report-anomalies` 规则在加载时仅移除原有的对应条文，保留启用状态和其他自定义内容；其他规则原样保留。

## 渲染（唯一出口 `src/shared/agentConduct.ts`）

| 函数 | 用途 |
|------|------|
| `renderAgentRulesSection(rules)` | 标题与编号条文；无启用规则返回空串 |
| `normalizeAgentRules(raw)` | config 归一（种子、清洗、空数组语义） |

## 投递路径

| 面 | 投递方式 |
|---|---|
| 调度 Pi | `src/main/agent/systemPrompt.ts` 渲染规约节。保存后重建调度连接时生效 |
| GUI Worker（含子代理） | `src/main/agentSession/host/connection.ts` 读取当前设置，附到会话首条适用输入。投递确认后续聊沿用该状态 |
| 传统 CLI Worker | 打开新会话、派活和定时任务的首条简报直接渲染当前启用规约 |

设置保存后，下次首条简报读取当前配置。项目指令由项目维护。

## 设置 UI

设置 → 调度 Agent（CapabilitiesPane）「全局行为规约」折叠节：规则卡片**默认只读**（一行摘要 + 启停勾选 + 编辑/删除按钮），点「编辑」才展开 textarea 进入编辑态（完成确认 / 取消回退）；「添加规则」直接落入新卡的编辑态。调度提示词同款交互（只读首行摘要 + 编辑按钮）。改动计入底部未保存条，随「保存」一起提交。

## 已知边界

- 规则只约束模型行为，宿主不做强制校验。
- 测试：`test/agent-rules.mjs`（规则归一、渲染及三类投递）。
