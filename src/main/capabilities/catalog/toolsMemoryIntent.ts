/** memory / scheduler.memory / intent 组（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';

export const TOOLS_MEMORY_INTENT_TOOL_DEFS: ToolDef[] = [
  // Typed knowledge: host supplies provenance and permission scope.
  {name:'memory.search',summary:"Search knowledge, history or work journals",description:"Search memory/journals; follow offsets or cursor.",dangerous:false,parameters:{type:'object',properties:{query:{type:'string'},mode:{type:'string',enum:['task','history','journal']},date:{type:'string'},fromDate:{type:'string'},toDate:{type:'string'},topicId:{type:'string',maxLength:100},cursor:{type:'string'},limit:{type:'integer',minimum:1,maximum:10},offset:{type:'integer',minimum:0,maximum:60}}}},
  {name:'memory.journal',summary:'Record this host session’s work',description:'Record decisions, findings, or handoff details worth revisiting. Skip routine turns. topicId links entries across sessions.',dangerous:false,parameters:{type:'object',properties:{topic:{type:'string',maxLength:20},topicId:{type:'string',maxLength:100},status:{type:'string',enum:['进行中','已完成','阻塞','搁置']},problem:{type:'string',maxLength:1500},points:{type:'array',items:{type:'string',maxLength:1500},minItems:1,maxItems:12},entryId:{type:'string'},revision:{type:'integer',minimum:1}},required:['topic','status','problem','points']}},
  {name:'memory.journalGet',summary:'Read a journal day',description:'Read original journal day; follow nextOffset.',dangerous:false,parameters:{type:'object',properties:{date:{type:'string'},offset:{type:'integer',minimum:0},maxChars:{type:'integer',minimum:1,maximum:5000}},required:['date']}},
  {name:'memory.list',summary:"List effective knowledge",description:"List visible scopes and evidence; follow nextOffset.",dangerous:false,parameters:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:50},offset:{type:'integer',minimum:0,maximum:100000}}}},
  {name:'memory.get',summary:'Read one memory and its evidence',description:'Exact ID/revision; concatenate text pages to parse JSON.',dangerous:false,parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string',maxLength:200},namespace:{type:'string',enum:['worker','scheduler','profile','host']},revision:{type:'integer',minimum:1},section:{type:'string',enum:['details','evidence']},offset:{type:'integer',minimum:0},maxChars:{type:'integer',minimum:1,maximum:5000}},required:['id']}},
  {name:'memory.confirm',summary:'Confirm a memory at the user’s explicit request',description:'Only explicit user: 确认记忆 <id> 正确. Host validates consent.',dangerous:false,parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string',maxLength:200},revision:{type:'integer',minimum:1}},required:['id','revision']}},
  {name:'memory.note',summary:"Submit a useful memory candidate",description:"Submit candidate; environmentKeys capture host values. Queued ≠ saved.",dangerous:false,parameters:{type:'object',properties:{text:{type:'string'},searchKeys:{type:'array',items:{type:'string',minLength:1,maxLength:300},minItems:1,maxItems:12},environmentKeys:{type:'array',items:{type:'string',enum:['appVersion','executorResultMaxChars','mcpCallResultMaxChars','mcpHubMaxChars']},maxItems:4}},required:['text','searchKeys']}},
  {name:'memory.correct',summary:'Report an incorrect memory version',description:'Report wrong ID/revision with source hint; check correctionStatus.',dangerous:false,parameters:{type:'object',additionalProperties:false,properties:{memoryId:{type:'string',maxLength:200},revision:{type:'integer',minimum:1},problem:{type:'string',maxLength:1500},evidence:{type:'string',maxLength:2500},suggestion:{type:'string',maxLength:1500}},required:['memoryId','revision','problem','evidence']}},
  {name:'memory.correctionStatus',summary:'Check your memory correction request',description:'Check own correction; pending is not applied.',dangerous:false,parameters:{type:'object',additionalProperties:false,properties:{requestId:{type:'string',maxLength:300}},required:['requestId']}},
  {name:'memory.remember',summary:"Remember an explicit user request",description:"Only explicit user request; queued is not saved.",dangerous:false,parameters:{type:'object',properties:{text:{type:'string'},searchKeys:{type:'array',items:{type:'string',minLength:1,maxLength:300},minItems:1,maxItems:12}},required:['text','searchKeys']}},
  // ---------- scheduler.policy（订阅策略：你听什么、多重要才叫醒你；仅调度调用链） ----------
  {
    name: 'scheduler.policy.get',
    summary: "Inspect scheduler notification policy",
    description:
      "Read this workspace's wake/digest/mute rules, defaults, immutable baseline, timing/guards and hit counts since startup. Inspect before changing policy.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'scheduler.policy.set',
    summary: "Replace scheduler notification policy",
    description:
      "Replace, not patch, workspace policy: resend rules to keep; empty rules resets defaults. First matching user rule wins before built-ins. Baseline human-wait/error/timeout/network/merge/gate events always wake. Read current policy first. Changes are recorded and notify the user.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          description:
            "Up to 40 rules.",
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: "Reserved prefix: builtin." },
              match: {
                type: 'object',
                description:
                  "All supplied fields must match: kind/trigger/factKind/sessionId/orchestrated. String fields accept arrays for any-of."
              },
              action: { type: 'string', enum: ['wake', 'digest', 'mute'] , description: "wake=wake scheduler; digest=attach to next wake; mute=drop."},
              note: { type: 'string', description: "Rationale, <=200 chars." }
            },
            required: ['match', 'action']
          }
        },
        timing: {
          type: 'object',
          description: "Milliseconds: mergeWindowMs 5000-120000; maxWaitMs >= window, <=300000. Defaults 25000/45000.",
          properties: {
            mergeWindowMs: { type: 'number' },
            maxWaitMs: { type: 'number' }
          }
        },
        guards: {
          type: 'object',
          description:
            "Milliseconds: heartbeatMs 5min-24h, needsYouMs 5min-4h; defaults 15min/30min. Mute the guard kind to disable, except baseline events.",
          properties: {
            heartbeatMs: { type: 'number' },
            needsYouMs: { type: 'number' },
          }
        },
        reason: { type: 'string', description: "Required rationale; recorded and shown to user." }
      },
      required: ['reason']
    }
  },
  // ---------- intent（standing intents 前瞻意图，memory-refactor B7 §9；2026-10-23 起开放 Worker，GUI+PTY） ----------
  {
    name: 'intent',
    summary: "Manage keyword/event reminders",
    description:
      "Register user-requested keyword/event reminders, one or both triggers. Creation requires an explicit request this turn; autonomous/background creation is rejected. Cancellation is persistent, never inferred. Pure time reminders use automations.run.",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'], description: "create=register; list=inspect; cancel=persist cancellation." },
        description: { type: 'string', description: "Intent summary; required for create." },
        triggerKeywords: {
          type: 'array',
          items: { type: 'string' },
          description: "All keywords must occur in the user message."
        },
        eventPredicates: {
          type: 'array',
          description: "Deterministic session/merge/PR event conditions.",
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['notify_flip', 'merge_blocked', 'pr_merged'], description: 'Event type' },
              trigger: { type: 'string', description: "notify_flip: needs_you/done/error." },
              branchIncludes: { type: 'string', description: "Branch substring for merge_blocked/pr_merged." },
              repoIncludes: { type: 'string', description: "Repo path substring for merge_blocked/pr_merged." }
            }
          }
        },
        cooldownHours: { type: 'number', description: "Cooldown after firing; default 24 hours." },
        fireBudget: { type: 'number', description: "Max firings; default 3." },
        expiryDays: { type: 'number', description: "Expiry after creation; default 90 days." },
        id: { type: 'number', description: "Intent id from list; required for cancel." }
      },
      required: ['action']
    }
  },
];
