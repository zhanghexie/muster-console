/** sessions 组·验收编排与跨会话协作（review…integrate）（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';
import { sessionIdProp } from './types';
import { integrateConfirmSummary, reviewConfirmSummary } from '../../../shared/confirmDialog';
import { ESCALATE_BUDGET_LIMIT } from '../../../shared/escalateBudget';
import { SESSION_PHASE_GUIDANCE, SESSION_PHASE_LABELS } from '../../../shared/workerGuidance';
import { MODEL_STATUS_PHASES } from '../../../shared/setStatus';

export const SESSIONS_OPS_TOOL_DEFS: ToolDef[] = [
  {
    name: 'sessions.review',
    summary: "Accept, send back, defer or process",
    description:
      "Review acceptance. passed/processed require confirmation (no approval=auto); rejected/deferred do not. processed clears dimension gates. A red dimension gate blocks passed: send back first; override only a verified false positive. Overrides are recorded.",
    dangerous: true,
    confirmSummary: (args) => reviewConfirmSummary(args),
    parameters: {
      type: 'object',
      properties: {
        ...sessionIdProp,
        decision: {
          type: 'string',
          enum: ['passed', 'rejected', 'deferred', 'processed'],
          description: "passed=merge isolated tree, else complete+archive; rejected=mail send-back note; deferred=park in needs-you list; processed=complete+archive without merging."
        },
        note: { type: 'string', description: "Send-back body or review note." },
        skipDimensionGate: {
          type: 'boolean',
          description:
            "For passed only: override a red gate ONLY for a verified false positive; recorded in acceptance history."
        }
      },
      required: ['sessionId', 'decision']
    }
  },
  {
    name: 'sessions.setStatus',
    summary: "Report phase or update status capsule",
    description:
      `${SESSION_PHASE_GUIDANCE} Supply phase or note. Omit sessionId for your own session. Budget: ${ESCALATE_BUDGET_LIMIT} attention notifications per session. If refused, do not retry.`,
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description:
            "Host UUID, >=8-char prefix or worktree path; bound Workers may omit. Scheduler omission targets itself."
        },
        externalSessionId: {
          type: 'string',
          description: "Runtime session id fallback when sessionId is absent."
        },
        phase: {
          type: 'string',
          description: SESSION_PHASE_LABELS,
          enum: MODEL_STATUS_PHASES
        },
        note: {
          type: 'string',
          maxLength: 10,
          description:
            "Choose any status text up to 10 Unicode characters; no preset vocabulary. Does not change phase; defaults by phase. Longer text is rejected."
        },
        reason: {
          type: 'string',
          description:
            "Required for needs_you within 60s of turn start. For a blocker, give one focused question with attempts/blocker/evidence."
        },
        kind: {
          type: 'string',
          description:
            "Capsule color only; defaults from phase.",
          enum: ['info', 'active', 'waiting', 'done', 'error']
        }
      }
    }
  },
  {
    name: 'sessions.setModel',
    summary: "Set or clear a session model override",
    description:
      "Set or clear a GUI session model override. Support and model availability depend on the selected engine. Idle connections are replaced; busy sessions use the new setting on the next turn. ACP applies a selected model only after the agent confirms it.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        ...sessionIdProp,
        providerId: { type: 'string', description: "Provider id; both IDs empty resets to global." },
        modelId: { type: 'string' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'sessions.setThinking',
    summary: "Set or reset Pi thinking level",
    description:
      "Set Pi thinking now/next turn; omit level to reset. Cursor rejects: use model parameters instead.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        ...sessionIdProp,
        level: {
          type: 'string',
          enum: ['off', 'low', 'medium', 'high', 'max'],
          description: "Omit to reset the session override."
        }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'sessions.requestIntegrate',
    schedulerHidden: true,
    description:
      'Called by the Worker after the user accepts: notifies the scheduler to integrate this session\'s isolated worktree into the main branch. Do not git merge / git worktree remove yourself. The scheduler will call sessions.integrate (confirmation per the approval policy, shown by default).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        ...sessionIdProp,
        note: { type: 'string', description: 'Optional short note, goes into the scheduler coordination message' }
      }
    }
  },
  {
    name: 'sessions.message',
    summary: "Send mail or interrupt an authorized session",
    description: "Send mail across harnesses. stored means persisted, not read/handled. Normal mail wakes idle recipients; busy recipients are retried while unread. Archived/deleted recipients are not woken. Query sent for the read receipt or current wake status. Final replies are not forwarded: send delivery mail when needed.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Host session id; scheduler=current workspace scheduler, parent=host-bound parent." },
        interrupt: { type: 'boolean', description: "Default false; scheduler may interrupt any available managed session; other sessions only their direct children. Store first, prefer native interjection; otherwise stop then wake. Receipts distinguish interject/queued/stopped; history retained." },
        text: { type: 'string', description: "Full body, max 262144 chars; excess rejected, not truncated." },
        subject: { type: 'string' },
        idempotencyKey: { type: 'string', description: "Reuse for retries of the same mail; changed content with the same key is rejected." },
        kind: { type: 'string', enum: ['ask', 'answer', 'notice', 'handoff'], description: "Default notice." },
        replyTo: { type: 'string', description: "messageId/askId being answered, from the mailbox query." }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'waitFor',
    summary: 'Arm a one-shot continuation without stopping the current turn',
    description: "Arm a mail/event/session/time wait and keep working. Continuations use the session's ordinary input. Normal waits for the turn boundary; preempt tries available interruption and otherwise also waits for idle. If the turn ends first, the session parks until the fire or deadlineMs timeout. The note (≤2000 chars) returns verbatim: include the wait, next action and relevant paths/IDs. Finish other work before parking; this is the only waiting primitive, never poll an inbox. Ignore an already handled fireInstanceId.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        condition: { type: 'object', description: 'mail: {kind,from?,replyTo?}; event: {kind,source,types?,scope?}; session: {kind,sessionId,phase}; time: {kind,at} (ISO local or zoned date-time).',
          properties: { kind: { type: 'string', enum: ['mail', 'event', 'session', 'time'] }, from: { type: 'string' }, replyTo: { type: 'string' },
            source: { type: 'string' }, types: { type: 'array', items: { type: 'string' } }, scope: { type: 'string' }, sessionId: { type: 'string' },
            phase: { type: 'string', enum: ['needs_you', 'idle'] }, at: { type: 'string' } }, required: ['kind'] },
        note: { type: 'string', maxLength: 2000 },
        priority: { type: 'string', enum: ['normal', 'preempt'] },
        deadlineMs: { type: 'integer', minimum: 0, description: 'Relative timeout in milliseconds.' }
      }, required: ['condition', 'note']
    }
  },
  {
    name: 'sessions.readMessages',
    summary: "Read mail and continue pages",
    description: "Read mail only: batch unread bodies, page with cursors. wakeDeferred gives the reason and retryWhileUnread; wakeError is a delivery exception. For read messages, see read and readAt. To wait for a reply, event or session state, arm waitFor and keep working; continuation uses ordinary input at your turn boundary, or earlier if preempt is available.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        box: { type: 'string', enum: ['inbox', 'sent'] },
        messageId: { type: 'string', description: "Read this mail; omit for batch." },
        mailboxWorkspaceId: { type: 'string', description: "Storage workspace from results; needed for colliding legacy message IDs." },
        limit: { type: 'number', description: "1-50, default 12. Batch: nextCursor; summary lists: nextOffset." },
        unreadOnly: { type: 'boolean', description: "Unread-only initial fetch; cursor follows position regardless of read state." },
        since: { type: 'number', description: "Only mail after this Unix millisecond timestamp." },
        listOffset: { type: 'integer', minimum: 0, description: "Summary offset; requires includeBody=false or default sent. No messageId/cursor. Default 0; batch uses nextCursor." },
        bodyOffset: { type: 'integer', minimum: 0, description: "Body character offset; requires messageId, no cursor. Default 0; continue with nextOffset." },
        length: { type: 'number', description: "Single-body page: 1-5000 chars, default 4000. Batch: at most 5000 per mail." },
        includeBody: { type: 'boolean', description: "Inbox default true. False previews without marking read; unreturned pages stay unread." },
        maxChars: { type: 'number', description: "Batch JSON budget: default 8000, max 10000; insufficient budget errors without marking read." },
        cursor: { type: 'string', description: "Mailbox/box/workspace-bound; start=beginning. nextCursor includes body tails; reuse original for replay." }
      }
    }
  },
  {
    name: 'sessions.integrate',
    description:
      "After acceptance, host merges into main, completes the session and removes its task tree; Workers must not merge/remove it themselves. Dirty task trees, overlapping main changes and conflicts block; non-overlapping dirt is allowed. Changed package/lock files trigger npm install and available typecheck unless skipped. Multi-repo: any preflight conflict rejects all; unchanged repos skip, nested merge first; actual merge failures may leave partial results without rollback. Inspect repos results. Confirmed failures notify the user; auto failures emit merge_blocked.",
    dangerous: true,
    confirmAction: '合入',
    confirmSummary: (args) => integrateConfirmSummary(args),
    parameters: {
      type: 'object',
      properties: {
        ...sessionIdProp,
        target: {
          type: 'string',
          description: "Default: each repo's recorded base; legacy fallback origin/HEAD or main/master. Explicit branch applies to all repos; missing in any rejects all."
        },
        message: {
          type: 'string',
          description: "Merge commit message; default Git text, or host-generated with noFf."
        },
        noFf: {
          type: 'boolean',
          description: "Use --no-ff; default false permits fast-forward."
        },
        stashMain: {
          type: 'boolean',
          description:
            "Default false. Stash only overlapping main-repo files, then pop after merge. Not forwarded by sessions.review."
        },
        skipNpmInstall: {
          type: 'boolean',
          description: "Skip post-merge npm install."
        },
        skipTypecheck: {
          type: 'boolean',
          description: "Skip post-merge typecheck."
        },
        onGateFail: {
          type: 'string',
          enum: ['warn', 'abort'],
          description: "Verification failure: warn (default) keeps merge; abort rolls it back."
        },
        approval: {
          type: 'string',
          enum: ['auto', 'required'],
          description:
            "required (default)=confirm. auto=only simple bug/style/copy changes, with notification+acceptance record. Product shape/data flow/IPC changes or uncertainty require confirmation."
        }
      }
    }
  },
];
