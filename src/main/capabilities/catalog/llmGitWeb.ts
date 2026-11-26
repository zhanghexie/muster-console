/** llm / git / web 组（保持原目录序：llm → git.refreshRepos → web.fetch）（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';
import { llmSetActiveConfirmSummary, llmUpsertProviderConfirmSummary } from '../../../shared/confirmDialog';

export const LLM_GIT_WEB_TOOL_DEFS: ToolDef[] = [
  // ---------- llm（模型服务商配置） ----------
  {
    name: 'llm.listProviders',
    summary: 'List configured model providers and the current default (apiKey masked); call this first when debugging connectivity/thinking issues',
    description:
      'List model providers configured in the app (baseUrl/API protocol/model list/thinking mapping and per-field thinkingEffect validity; apiKey is always masked, never plaintext) and the current default provider/model. Call this first when debugging model connectivity or thinking levels not taking effect',
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'llm.upsertProvider',
    description:
      'Add or update a model provider config (shows a user confirmation). An existing id updates, unspecified fields keep their values; an empty or masked apiKey keeps the old key. Does not change the default provider (switch with llm.setDefault). Verify thinking-parameter spellings first via llm.testConnection with thinkingProbe differential tests before persisting; a thinking model must be marked reasoning:true for thinking parameters to be sent (persist warnings will remind you)',
    dangerous: true,
    confirmAction: '保存',
    confirmSummary: (args) => llmUpsertProviderConfirmSummary(args),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Provider id, e.g. zhipu; updates when it exists' },
        name: { type: 'string', description: 'Display name (optional)' },
        baseUrl: { type: 'string', description: 'API base URL (required for new entries), e.g. https://open.bigmodel.cn/api/paas/v4' },
        apiKey: { type: 'string', description: 'API key; empty or masked = keep the existing value' },
        api: {
          type: 'string',
          description:
            'API protocol, default openai-completions. Options: openai-completions / openai-responses / anthropic-messages / google-generative-ai / mistral-conversations / azure-openai-responses'
        },
        models: {
          type: 'array',
          description: 'Model list (replaced wholesale when provided)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              reasoning: { type: 'boolean', description: 'Whether it is a reasoning (thinking) model — the master switch for sending thinking parameters; must be true for thinking models' },
              multimodal: { type: 'boolean', description: 'Whether image input is supported' },
              attachments: {
                type: 'object', additionalProperties: false,
                description: 'Native model input capabilities only, merged per field; unprovided ones are kept. Use multimodal for images; local-conversion budgets, size caps, and tool paths belong to model & input settings and must not be written here. Declare only capabilities the API actually supports.',
                properties: {
                  nativeAudio: { type: 'boolean', description: 'Native audio input' },
                  nativeVideo: { type: 'boolean', description: 'Native video input' },
                  nativeFiles: { type: 'boolean', description: 'Native document input' },
                  allowMixedMedia: { type: 'boolean', description: 'Allow mixed media types' },
                  videoTransport: { type: 'string', enum: ['url-only', 'data-url'] },
                  mimeTypes: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Native MIME allowlist; an empty array restores the protocol default' }
                }
              },
              contextWindow: { type: 'number' },
              maxTokens: { type: 'number' }
            },
            required: ['id']
          }
        },
        enabled: { type: 'boolean' },
        compat: {
          type: 'object', additionalProperties: false,
          description: 'OpenAI completions capabilities. Unspecified fields are preserved; null clears an override. Custom endpoints default to system instructions; catalog models keep their declared capabilities.',
          properties: { supportsDeveloperRole: { type: ['boolean', 'null'], description: 'Whether reasoning models may send developer instructions. false uses system; true explicitly enables developer.' } }
        },
        thinking: {
          type: 'object',
          description: 'Thinking config (optional). levels: five-level mapping object; reasoningEffortField: boolean; thinkingFormat: thinking dialect string (openai/openrouter/deepseek/together/zai/qwen/qwen-chat-template/chat-template/string-thinking/ant-ling) or null=auto; disableAtOff: boolean, truly disables at off (DeepSeek-style completions only)',
          properties: {
            levels: { type: 'object', description: '{off/low/medium/high/max: payload value strings}' },
            reasoningEffortField: { type: 'boolean' },
            thinkingFormat: { type: 'string' },
            disableAtOff: { type: 'boolean' }
          }
        }
      },
      required: ['id']
    }
  },
  {
    name: 'llm.setDefault',
    description:
      'Switch the app\'s default model provider/model (shows a user confirmation; affects the model used by all later conversations and tasks). The model id must be in that provider\'s model list',
    dangerous: true,
    confirmAction: '切换',
    confirmSummary: (args) => llmSetActiveConfirmSummary(args),
    parameters: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'Provider id' },
        modelId: { type: 'string', description: 'Model id; defaults to the provider\'s first model' }
      },
      required: ['providerId']
    }
  },
  {
    name: 'llm.testConnection',
    description:
      'Test model-provider connectivity (sends one tiny request). Test a stored config (pass providerId; the key resolves internally and is never returned) or a draft config (pass baseUrl/apiKey/api/model) before deciding to upsertProvider. With thinkingProbe:{effort,thinking} the thinking parameters are attached per protocol and reasoningTokens returned — to judge whether a level or spelling is truly honored server-side, call once each with effort=low and max and compare (a magnitude gap in reasoningTokens = genuinely effective); docs may be outdated, probe results are the final verdict',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'Test against a stored config (mutually exclusive with baseUrl)' },
        baseUrl: { type: 'string', description: 'API base URL (draft test)' },
        apiKey: { type: 'string', description: 'API key (draft test; may be empty)' },
        api: { type: 'string', description: 'API protocol, default openai-completions' },
        model: { type: 'string', description: 'Model id; defaults to the current default model' },
        thinkingProbe: {
          type: 'object',
          description: 'Thinking probe (optional): {effort: level value, thinking: enabled/disabled, prompt: custom prompt}',
          properties: {
            effort: { type: 'string', description: 'Thinking level value, e.g. low/max' },
            thinking: { type: 'string', description: 'Toggle thinking: enabled / disabled' },
            prompt: { type: 'string', description: 'Probe prompt (defaults to a small reasoning puzzle)' }
          }
        }
      }
    }
  },
  {
    name: 'llm.quota',
    summary: "Inspect local provider failure rates",
    description:
      "Read local provider failures (401/429) over quotaWindowMs, default 15 minutes. remaining is always null; no vendor billing lookup.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: "Default: current provider." }
      }
    }
  },
  {
    name: 'git.refreshRepos',
    summary: "Refresh repository discovery",
    description:
      "Rescan source roots/manual extras for repositories; does not grant path access. Needed after adding/removing/repairing repos, not routine status checks. Nonzero issueCount means partial scan: fix reported issues and retry.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: "Omit to scan all open workspaces." }
      }
    }
  },
  {
    name: 'web.fetch',
    description:
      "Fetch public HTTP(S) content: HTML -> plain text; text/JSON unchanged. Long output truncates. Intranet/loopback blocked.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: "Public HTTP(S) URL." },
        maxChars: { type: 'number', description: "Default 8000, cap 20000." }
      },
      required: ['url']
    }
  }
];
