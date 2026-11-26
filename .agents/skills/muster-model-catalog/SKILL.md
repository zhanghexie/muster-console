---
name: muster-model-catalog
description: 维护 Muster Core 的模型目录。按供应商实际端点、协议和模型核对上下文窗口、输入模态及思考档位，生成并校验 JSON，再通过独立 Git 仓库发布到 Cloudflare Pages。用于周更、补缺项和修正规格。
---

# 维护 Muster 模型目录

此技能以包含 `.agents/skills/` 的 Muster 源码检出为起点。先读 [Core 模型供应商文档](../../../docs/features/model-providers.md#core-官方端点思考档位目录)，实现和测试均以当前检出版本为准。实际发布命令见 [发布与验证](references/publish.md)。

## 找数据

1. 从 `src/shared/piCatalog.ts`、`src/main/agent/piConfigSync.ts` 和已发布 JSON 核对内置供应商与当前覆盖。条目按 `providerId`、规范化 `baseUrl`、请求协议和精确 `modelId` 匹配。比较每个供应商的覆盖与变化，包括区域、按量、Token Plan、Coding Plan、托管网关及账号端点。供应商目录中的模型 ID 不一定都有可设置的思考档位。
2. 优先读取目标端点的官方模型页、更新日志和能力字段。DeepSeek 的 `/models` 有 `context_window`、`input_modalities` 和 `effort`。核对上下文总窗口、输入模态、思考开关、档位、默认值及预算。总窗口与单次最大输入或最大输出分别记录；图片生成等输出能力也有独立含义。普通百炼与 Token Plan 需要各自的证据。 [DeepSeek 列表](https://api-docs.deepseek.com/api/list-models/) · [百炼正式版](https://help.aliyun.com/zh/model-studio/qwen4-max) · [百炼端点](https://help.aliyun.com/zh/model-studio/base-url) · [Anthropic 列表](https://platform.claude.com/docs/en/api/models/list)
3. 用 Pi 公开分片和 OpenCode 的 Models.dev v2 数据发现新型号和差异。Pi 提供 `contextWindow`、`input` 和原生思考映射。Models.dev 按实际路由提供 `limit.context`、`modalities.input` 和 `capabilities.reasoning`。对上游变化确认适用的端点及协议，保留上游出处。 [Pi 公开分片](https://pi.dev/api/models/providers/deepseek?types=chat) · [Models.dev v2 数据](https://models.opencode.ai/experimental/v2.0/api.json?type=chat) · [公开 schema](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema-v2.ts)
4. 对新增和变化先核对实际端点规格。原生思考档保留厂商的值和顺序。已知纯文本用 `input: ["text"]` 表达，未知字段留空。上游缺项或变动无法核实则保留已发布的有效值，并报告待核对项。默认保底由客户端提供，目录存放有来源的数据。

## 选更新位置

- `public/v1/reasoning.json` 是高优先级逐模型覆盖，存放有来源的已核验枚举。实际请求格式由 `parseCoreReasoningCatalog` 限定。`defaultEffort` 只能从原生枚举中选。`canDisable` 单独声明。仅更新有变化的条目，保留各项证据链接。
- `data/model-capabilities.json` 存放逐端点官方核验规格。可填 `contextWindow` 与 `input`，附 `sources`。发布时用生成器的 `--official-capabilities` 参数读取它。后续周更继续以该文件为准，避免覆盖经核验的修正。
- `public/reasoning-v2.json` 由 `scripts/build-core-reasoning-catalog.mjs` 生成。`pi` 来自 Muster 锁定的 Pi SDK，`models` 存思考覆盖，`capabilities` 存模型规格。官方字段覆盖相同身份的上游字段。v1 能表达的思考核验覆盖优先写 v1。
- 本地 Ollama 的思考控制由客户端按实际回环端点 `/api/show` 发现。账号级部署和自建代理只有在实际协议能确认时才沿用相应规则。新增序列化格式、未知协议或需修改客户端语义的变更，先记录证据和所需代码，等客户端支持后再发对应条目。

## 每次更新的交付

比较当前发布与候选的有效条目，核对新增、修改、删除及上游异常。有效内容相同就记录「无变更」。有可验证的改动时，按发布参考校验，提交到目录仓库并验证生产 URL。报告变动端点、来源、版本及生产验证结果，遇到发布权限或上游故障时给出具体失败步骤。
