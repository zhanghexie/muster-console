import { CLI_LAUNCH_OPTIONS_SCHEMA } from '../../../shared/cliLaunchOptions';
/** 自动任务：时间计划、会话参数与启停。 */
import type { ToolDef } from './types';
import { CONFIRM_NOTE_PARAM_PROPS, scheduledServiceConfirmSummary } from '../../../shared/confirmDialog';
import { NATIVE_CONFIG_INTENT_SCHEMA } from '../../../shared/nativeSessionConfig';

const scheduleSchema = {
  type: 'object',
  description: 'Time schedule; mutually exclusive with delayMinutes. Use once for one-shot, daily/weekly/interval only for explicit recurrence.',
  oneOf: [
    { properties: { kind: { const: 'once' }, at: { type: 'string', description: 'ISO date-time; timezone recommended' } }, required: ['kind', 'at'], additionalProperties: false },
    { properties: { kind: { const: 'daily' }, time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Local-timezone HH:mm' } }, required: ['kind', 'time'], additionalProperties: false },
    { properties: { kind: { const: 'weekly' }, time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }, weekdays: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0=Sunday, 1=Monday, and so on' } }, required: ['kind', 'time', 'weekdays'], additionalProperties: false },
    { properties: { kind: { const: 'interval' }, intervalMinutes: { type: 'integer', minimum: 1, maximum: 43200 } }, required: ['kind', 'intervalMinutes'], additionalProperties: false }
  ]
};

export const SERVICES_TOOL_DEFS: ToolDef[] = [
  // ---------- prompt tasks ----------
  {
    name: 'automations.list',
    description: 'List time-scheduled prompt tasks with their runtime, execution policy, and status',
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'automations.create',
    summary: 'Register a time-scheduled task (launches a visible Worker; runtime required)',
    description:
      'Register a time-scheduled prompt task after business approval (enabled at creation). When due it launches a visible Worker to execute the prompt; runtime is required (run runtimes.list first). For event notifications use events.subscribe. Set configurePermissions to true to use explicit guiMode, nativeConfig, or CLI permission options.\n' +
      'Schedule phrasing:\n' +
      '- "do X in N minutes/hours" must use delayMinutes (relative delay in minutes) — never encode it as interval/daily; the host converts the trigger point from the real clock and lands it as a one-shot (once) task.\n' +
      '- "run once at a given time" (e.g. tomorrow 9am) uses schedule {"kind":"once","at":"<ISODateTime>"} or an equivalent delayMinutes; once auto-disables after one successful firing.\n' +
      '- Only recurring tasks use daily/weekly/interval; optionally maxRuns caps successful firings and auto-disables on reach.\n' +
      '- delayMinutes and schedule are mutually exclusive.\n' +
      'Keep name as the user\'s verbatim phrase (e.g. "remind me to drink water in 8 minutes"); do not generalize it into titles like "daily task".',
    dangerous: true,
    confirmAction: '创建',
    confirmSummary: (args) => scheduledServiceConfirmSummary('create', args),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONFIRM_NOTE_PARAM_PROPS,
        name: {
          type: 'string',
          description: 'Task name; keep the user\'s verbatim phrase'
        },
        workspaceId: {
          type: 'string',
          description: 'Workspace ID; optional, defaults to the current workspace'
        },
        rootId: { type: 'string', description: 'Source folder ID; omitted = the default root is fixed at creation and later default changes do not redirect it' },
        rootsRevision: { type: 'integer', minimum: 0, description: 'Workspace source-root revision; a stale value rejects creation' },
        runtime: {
          type: 'string',
          description: 'Enabled runtime id (run runtimes.list first)'
        },
        prompt: {
          type: 'string',
          description: 'Prompt to execute when the task is triggered'
        },
        schedule: scheduleSchema,
        delayMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: 43200,
          description: 'Relative delay (minutes). Use it for "in N minutes/hours" — never encode as interval/daily; mutually exclusive with schedule; the host converts it to once from the real clock'
        },
        maxRuns: {
          type: 'number',
          description: 'Cap on successful firings (interval/daily/weekly): auto-disables on reach; once is inherently one-shot'
        },
        missedPolicy: {
          type: 'string',
          enum: ['skip', 'catch-up', 'confirm'],
          description: 'Missed policy: skip (default, record and skip) / catch-up (run once late) / confirm (wait for confirmation to run late)'
        },
        configurePermissions: { type: 'boolean', description: 'Enable explicit permission configuration and review. Defaults to false (automatic maximum permissions).' },
        guiMode: {
          type: 'string',
          description: 'Muster Core session permission.'
        },
        cliLaunchOptions: { ...CLI_LAUNCH_OPTIONS_SCHEMA, description: 'Native CLI launch options for terminal tasks.' },
        nativeConfig: { ...NATIVE_CONFIG_INTENT_SCHEMA, description: 'External GUI Harness settings from host.workers.options (mode: native-settings).' },
        piModeId: {
          type: 'string',
          description: 'Pi custom mode or ACP engine id'
        },
        thinking: {
          type: 'string',
          description: 'Thinking level: off / low / medium / high / max (Pi only)'
        },
        model: {
          type: 'object',
          properties: {
            providerId: {
              type: 'string',
              minLength: 1
            },
            modelId: {
              type: 'string',
              minLength: 1
            }
          },
          required: ['providerId', 'modelId'],
          description: 'Session model override; omit to follow the global default'
        }
      },
      required: ['name', 'prompt', 'runtime']
    }
  },
  {
    name: 'automations.update',
    description:
      'Modify a time-scheduled task\'s name, runtime, prompt, session model/thinking level, schedule, or missed policy. Material changes require business approval; a name-only update reuses existing authorization. Use delayMinutes for "in N minutes/hours" (never encode as interval/daily), once or delayMinutes for "run once at a time", and delayMinutes/schedule are mutually exclusive.',
    dangerous: true,
    confirmAction: '修改',
    confirmSummary: (args) => scheduledServiceConfirmSummary('update', args),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONFIRM_NOTE_PARAM_PROPS,
        rootId: { type: 'string', description: 'Explicitly reselect the source folder; omit keeps the original source, and the root must not change while a launch is in flight' },
        rootsRevision: { type: 'integer', minimum: 0, description: 'Source-root revision; a stale value rejects the save' },
        name: {
          type: 'string',
          description: 'Task name; keep the user\'s verbatim phrase'
        },
        runtime: {
          type: 'string',
          description: 'Enabled runtime id; run runtimes.list first'
        },
        prompt: { type: 'string' },
        schedule: scheduleSchema,
        delayMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: 43200,
          description: 'Relative delay (minutes). Mutually exclusive with schedule; the host converts it to once from the real clock'
        },
        maxRuns: {
          type: 'number',
          description: 'Cap on successful firings (interval/daily/weekly): auto-disables on reach'
        },
        missedPolicy: {
          type: 'string',
          enum: ['skip', 'catch-up', 'confirm'],
          description: 'Missed policy'
        },
        configurePermissions: { type: 'boolean', description: 'Enable explicit permission configuration and review. Defaults to false (automatic maximum permissions).' },
        guiMode: { type: 'string', description: 'Muster Core session permission.' },
        cliLaunchOptions: { anyOf: [CLI_LAUNCH_OPTIONS_SCHEMA, { type: 'null' }], description: 'Native CLI launch options. null clears the stored options.' },
        nativeConfig: { anyOf: [NATIVE_CONFIG_INTENT_SCHEMA, { type: 'null' }], description: 'External GUI Harness settings. null clears the stored selection.' },
        piModeId: { type: 'string' },
        thinking: { type: 'string' },
        automationId: { type: 'string' },
        model: {
          type: 'object',
          properties: {
            providerId: {
              type: 'string',
              minLength: 1
            },
            modelId: {
              type: 'string',
              minLength: 1
            }
          },
          required: ['providerId', 'modelId'],
          description: 'Session model override; omit to follow the global default'
        }
      },
      required: ['automationId']
    }
  },
  {
    name: 'automations.setEnabled',
    description: 'Set whether a prompt task is enabled; enabled=true enables, false disables, and the task content is unchanged.',
    dangerous: true,
    confirmAction: '启用',
    confirmSummary: (args) => scheduledServiceConfirmSummary(args.enabled === false ? 'disable' : 'enable', args),
    parameters: {
      type: 'object',
      properties: {
        automationId: { type: 'string' },
        enabled: {
          type: 'boolean'
        }
      },
      required: ['automationId', 'enabled']
    }
  },
  {
    name: 'automations.delete',
    description: 'Delete a prompt task',
    dangerous: true,
    confirmAction: '删除',
    confirmSummary: (args) => scheduledServiceConfirmSummary('delete', args),
    parameters: {
      type: 'object',
      properties: {
        automationId: { type: 'string' }
      },
      required: ['automationId']
    }
  },
  {
    name: 'automations.runNow',
    description:
      'Run a prompt task once immediately (launches a visible Worker) without affecting later schedules',
    dangerous: true,
    confirmAction: '执行',
    confirmSummary: (args) => scheduledServiceConfirmSummary('runNow', args),
    parameters: {
      type: 'object',
      properties: {
        automationId: { type: 'string' }
      },
      required: ['automationId']
    }
  },
];
