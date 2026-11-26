/** ui / app / extensions 组（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';
import { SUGGESTED_REPLY_GUIDANCE } from '../../../shared/suggestedReplyGuidance';
import { EXTENSION_EXTENSION_TOOL_DEFS } from '../../extensions/extensionCapabilityCatalog';
import { CURSOR_ASK_QUESTION_NAME, CURSOR_ASK_QUESTION_SCHEMA } from '../../../shared/cursorAskQuestion';

export const UI_APP_EXTENSIONS_TOOL_DEFS: ToolDef[] = [
  // ---------- ui ----------
  {
    name: 'ui.suggestReplies',
    summary: 'Suggest replies for the current conversation',
    description: `${SUGGESTED_REPLY_GUIDANCE} Use only for the current interactive conversation.`,
    dangerous: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        replies: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 300 } }
      },
      required: ['replies']
    }
  },
  {
    name: 'ui.notify',
    description:
      "Add a history/desktop notification. Provide text or label/lifecycle; target via sessionId or workspaceId+sessionName. Bound Workers may send text only. update=true replaces the prior entry with the same updateKey.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: "Target workspace; inferred for bound Workers."
        },
        sessionId: {
          type: 'string',
          description: "Target session; inferred from bound identity/sessionName."
        },
        sessionName: {
          type: 'string',
          description: "Display name; inferred for bound Workers."
        },
        text: { type: 'string', description: "Body; omit to compose from sessionName + lifecycle/label." },
        lifecycle: {
          type: 'string',
          enum: ['starting', 'working', 'idle', 'blocked', 'exited'],
          description: "Lifecycle used to compose missing text."
        },
        label: { type: 'string', description: "Short summary used when text is absent." },
        update: {
          type: 'boolean',
          description: "Replace matching updateKey rather than append."
        },
        updateKey: {
          type: 'string',
          description: "Update identity; defaults from lifecycle/live/session + sessionId."
        }
      }
    }
  },
  {
    name: 'ui.confirm',
    description:
      "Request an explicit user decision. Registered low-frequency business operations use their shared approval gate; dangerous metadata alone does not trigger confirmation. Returns confirmed/cancelledBy: backdrop/timeout may retry; explicit button/close/esc cancellation must not be retried.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, detail: { type: 'string' } },
      required: ['title']
    }
  },
  {
    name: 'ui.prompt',
    description:
      "Ask for text input. Returns cancelled/value; cancellation or timeout gives value=null.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        message: { type: 'string' },
        defaultValue: { type: 'string' },
        placeholder: { type: 'string' },
        multiline: { type: 'boolean' }
      },
      required: ['title']
    }
  },
  {
    name: CURSOR_ASK_QUESTION_NAME,
    summary: 'Ask the user a structured question',
    description:
      'Use for user choices, plan confirmation and trade-offs instead of prose questions. Supports single/multi-select and custom input. Returns {answers:[{id,selected,custom?}]}; cancellation fails. Scheduler waits; Workers use their own question channel.',
    dangerous: false,
    parameters: CURSOR_ASK_QUESTION_SCHEMA as ToolDef['parameters']
  },
  {
    name: 'ui.render',
    summary: "Create or update interactive content",
    description:
      "Create/update interactive HTML. GUI: embed returned markdown verbatim. CLI: host opens a shared UI-only page in the right browser; follow returned usage/presentation and tell the user where. Injected: ma-* controls, maUi state/actions, offline D3/Three; read ui-widget-design for the contract. No business networking. Updates retain selections/collapse state. ui.inspect reads public state/render receipts.",
    dangerous: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['inline', 'browser'], description: "inline=in-session (default); browser=standalone web pane." },
        update: { type: 'string', description: "Existing session artifact link; update in place, preserving mode/state." },
        title: { type: 'string', description: "Card/tab title." },
        html: { type: 'string', description: "HTML fragment using host tokens and injected ma-* / maUi; no business network requests." },
        note: { type: 'string', description: "Footnote/conclusion/source; newlines allowed." }
      },
      required: ['title', 'html']
    }
  },
  {
    name: 'ui.inspect', summary: "Inspect widget state and receipts",
    description: "Read public widget state, capacity and render receipts. No link: paginated summaries. With link: use pointer (JSON Pointer rooted in modelContent), offset and limit for nested/large values; follow content.nextOffset. Private state is never returned.",
    dangerous: false,
    parameters: { type: 'object', additionalProperties: false, properties: {
      link: { type: 'string', description: "Link returned by ui.render in this session." },
      pointer: { type: 'string', description: "JSON Pointer within public modelContent, e.g. /selected/name. Requires link; empty selects root." },
      offset: { type: 'integer', minimum: 0, description: "Widget/entry offset; with string content, character offset." },
      limit: { type: 'integer', minimum: 1, maximum: 4096, description: "Requested page length; host bounds widgets/entries and text separately." }
    } }
  },
  {
    name: 'app.getConfig',
    summary: "Read app configuration",
    description: "Read app configuration, with apiKey redacted.",
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'app.instances',
    summary: "List local workbench instances",
    description:
      "List local workbench instances, including sandboxes: id/pid/aumid/userData/API ports. Check identity before using ports or stopping processes.",
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  ...EXTENSION_EXTENSION_TOOL_DEFS
];
