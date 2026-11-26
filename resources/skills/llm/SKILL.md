---
x-muster-version: 0.1.33
name: llm
description: Parameter reference for host.llm.run — model provider configurations (list providers, upsert, set default, test connection with thinking probes). Read this before passing params to any host.llm.run action.
---

# host.llm.run — model provider configuration

`host.llm.run` manages the app's model provider configs and provides the `quota` action for failure-rate preflight. Workers can use the `quota` action only.

## Actions

Required params are marked `*`.

| Action | params | Purpose |
|---|---|---|
| quota | providerId? | Read local provider 401/429 failures for the configured quota window. `remaining` is always null; this does not query vendor billing. |
| listProviders | {} | List configured providers (baseUrl / API protocol / model list / thinking mapping) and the current default provider+model. `apiKey` is always masked, never plaintext. Call this first when debugging connectivity or thinking levels. |
| upsertProvider | id*, name?, baseUrl?, apiKey?, api?, models?, enabled?, thinking?, compat? | Add or update a provider config (user confirmation shown). Existing id updates; unspecified fields keep values; empty or masked `apiKey` keeps the old key. Does NOT change the default provider. `api`: openai-completions (default) / openai-responses / anthropic-messages / google-generative-ai / mistral-conversations / azure-openai-responses. `models[]`: `{id*, name?, reasoning?, multimodal?, attachments?, contextWindow?, maxTokens}` (replaced wholesale when provided). `thinking`: `{levels, reasoningEffortField, thinkingFormat, disableAtOff}`. `compat`: `{supportsDeveloperRole?: boolean \| null}`; omitted preserves, null clears the override. |
| setDefault | providerId*, modelId? (defaults to the provider's first model) | Switch the app's default provider/model (user confirmation; affects all later conversations and tasks). The model id must be in that provider's model list. |
| testConnection | providerId? \| baseUrl?+apiKey?+api?, model?, thinkingProbe? | One tiny request. Test a stored config (`providerId`) or a draft config before upserting. `thinkingProbe: {effort, thinking: enabled\|disabled, prompt?}` attaches thinking parameters per protocol and returns `reasoningTokens`. |

## Calling pattern

```
host.llm.run({ action, params })
```
`params` follows the chosen action's original schema; pass `{}` for no-arg actions.

- Inspect first: `host.llm.run({ action: "listProviders", params: {} })`
- Draft-test then persist:
  `host.llm.run({ action: "testConnection", params: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "sk-...", model: "glm-4.7" } })`
  `host.llm.run({ action: "upsertProvider", params: { id: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" } })`
- Differential thinking probe (judge whether a level is truly honored): call `testConnection` twice with `thinkingProbe.effort` `low` and `max` and compare `reasoningTokens` — a magnitude gap means genuinely effective.

## Notes

- **Scheduler-side domain.**
- `upsertProvider` / `setDefault` are dangerous (confirm dialog); `listProviders` / `testConnection` are read-only probes.
- `reasoning: true` on a model is the master switch for sending thinking parameters — a thinking model must be marked or no thinking params go out.
- Connection probes test basic reachability, not the complete conversation payload. Thinking probes test only their supplied fields; use a real conversation to verify instruction roles and tools.
- For openai-completions, `compat.supportsDeveloperRole: false` keeps system instructions; `true` allows developer instructions for reasoning models. Custom endpoints, unknown endpoint metadata and unlisted models default to system; verified catalog models keep their declared capabilities. No vendor-specific gateway detection is used. Other protocols ignore this field. The non-sensitive override is returned by `listProviders`.
- `thinking.thinkingFormat` / `reasoningEffortField` only take effect on the openai-completions protocol; other protocols handle thinking natively.
- `upsertProvider` never makes the provider active by itself — switch with `setDefault`.
