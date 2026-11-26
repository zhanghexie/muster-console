/** runtimes / terminal / chat / pipeline 组（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';
import { SHELL_PROFILE_IDS } from '../../../shared/types';
import { sessionIdProp } from './types';
import { runtimeConfirmSummary } from '../../../shared/confirmDialog';

export const RUNTIMES_TERMINAL_CHAT_TOOL_DEFS: ToolDef[] = [
  {
    name: 'terminal.create',
    description: 'Create a plain Shell terminal, not an AI harness. Uses the selected source directory without creating isolated worktrees. Unavailable shell profiles fail with an installation/platform error.',
    dangerous: false,
    parameters: { type: 'object', properties: {
      shellProfileId: { type: 'string', enum: [...SHELL_PROFILE_IDS], description: 'Shell profile available on the host OS.' },
      name: { type: 'string' }, workspaceId: { type: 'string', description: 'Default: caller workspace.' },
      rootId: { type: 'string', description: 'Source folder; default root if omitted.' },
      cwd: { type: 'string', description: 'Absolute cwd within the source folder.' },
      rootsRevision: { type: 'integer', description: 'Reject stale source selections.' },
      select: { type: 'boolean', description: 'Default true; cross-workspace focus remains pending.' }
    }, required: ['shellProfileId'] }
  },
  // ---------- runtimes ----------
  {
    name: 'runtimes.list',
    description: 'List registered agent CLI runtimes (id/label/builtin/enabled)',
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'runtimes.register',
    description: 'Register a declarative Runtime Manifest. Supports a terminal command and/or ACP chat command; desktop confirmation is required before activation.',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: { manifest: { type: 'object', description: 'Runtime Manifest JSON described in the runtimes skill' } },
      required: ['manifest']
    }
  },
  {
    name: 'runtimes.get',
    description: 'Get one runtime declaration and its launcher script when present',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'runtimes.update',
    description:
      'Change a runtime label or enabled state. Built-in script runtimes also accept scriptSource and extraArgs. Material code or permission changes require business approval. A changed script must export allocate and resolveLaunch; optional hooks must use agentHookCommand from _helpers.mjs',
    dangerous: true,
    confirmAction: '更新',
    confirmSummary: (args) => runtimeConfirmSummary('update', args),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        enabled: { type: 'boolean' },
        scriptSource: { type: 'string' },
        extraArgs: { type: 'array', items: { type: 'string' } }
      },
      required: ['id']
    }
  },
  {
    name: 'runtimes.remove',
    description: 'Delete the entry and its script files',
    dangerous: true,
    confirmAction: '删除',
    confirmSummary: (args) => runtimeConfirmSummary('remove', args),
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'runtimes.restoreBuiltins',
    description: 'Restore out-of-box seeds (optional ids; defaults to all builtins)',
    dangerous: true,
    confirmAction: '恢复',
    confirmSummary: (args) => runtimeConfirmSummary('restore', args),
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'runtimes.preflight',
    description:
      'Diagnose runtime availability without spawning the engine. Returns per-runtime status and problems with install guidance. Creation already checks its target. Omit id to diagnose all registered runtimes.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Runtime id; omit = all' } }
    }
  },
  {
    name: 'terminal.write',
    description:
      "Write terminal text/keys without focusing. Returns pre-write outputCursor; pass it as terminal.capture.after to include intervening output. Supply sessionId or name, and text or key.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        ...sessionIdProp,
        name: { type: 'string', description: "Display-name substring instead of sessionId." },
        text: { type: 'string', description: "Text to write; optional with key." },
        submit: {
          type: 'boolean',
          description: "Override Enter submission: typed/submit default true, raw false."
        },
        mode: {
          type: 'string',
          description: "raw=block paste; typed=character typing; submit=typed alias."
        },
        enterCount: {
          type: 'number',
          description: "Enter count, default 3 for ConPTY; use 1 if already submitted."
        },
        key: { type: 'string', description: "ctrl-c=interrupt; enter=submit existing input." }
      }
    }
  },
  {
    name: 'terminal.capture',
    description:
      "Capture the terminal viewport as a local PNG and read textTail without focus. Screenshot failure returns captureError with text. waitFor waits for text or silence; silence is not completion. wait.reason=text/quiet/timeout/exit. See ~/.muster/skills/sessions/SKILL.md.",
    dangerous: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...sessionIdProp,
        name: { type: 'string', description: "Display-name substring instead of sessionId." },
        after: { type: 'string', description: "Prior write/capture outputCursor; requires waitFor. Omit to wait for new output only. Restart/buffer eviction invalidates it." },
        waitFor: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 2000, description: "Literal ANSI-stripped text across chunks; not regex." },
            quietMs: { type: 'integer', minimum: 50, maximum: 5000, description: "Continuous output silence; not proof of completion." },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, description: "Default 15000ms; timeout still returns current frame/text." }
          },
          oneOf: [{ required: ['text'] }, { required: ['quietMs'] }]
        }
      }
    }
  },
];
