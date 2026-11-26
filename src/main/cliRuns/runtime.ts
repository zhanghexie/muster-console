import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CliError, CLI_TERMINAL_STATES, type CliRunState } from '../../shared/cli';
import { writeJsonAtomicSync, writeTextAtomicSync } from '../atomicJson';
import { sweepStaleEntries } from '../persistenceSweeps';

/** cli-runs 7 天滚动回收（X3-F05；evidence 同口径）：只回收 run 命名条目，.bad 隔离档保留 */
const RUNS_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_ENTRY_RE = /^[a-f0-9-]{36}(?:\.json)?$/;

/** 启动清扫过期 run（<uuid>.json 与 <uuid>/ 任务目录；stat 顶层，不递归） */
export function sweepExpiredCliRuns(directory: string, now = Date.now()): number {
  return sweepStaleEntries(directory, { maxAgeMs: RUNS_RETAIN_MS, now, match: RUN_ENTRY_RE });
}

export interface CliWorker { taskId: string; sessionId?: string; queueId?: string; runtime?: string; /** Host-only evidence from a failed delegateTask creation. */ creationFailed?: true }
export interface CliRun {
  runId: string; workspaceId: string; state: CliRunState; revision: number; createdAt: number; updatedAt: number;
  idempotencyKey?: string; inputHash: string; taskPath: string; workers: CliWorker[];
  question?: { id: string; text: string }; result?: { summary: string; artifacts: string[]; verification: string }; error?: string;
  pending: Array<{ id: string; path: string }>;
  replies: Record<string, string>;
  logs: Array<{ seq: number; at: number; source: string; text: string }>;
  nextSeq: number;
}
export type CliPendingRun = { runId: string; workspaceId: string; taskPath: string; input: { id: string; path: string } };
const terminal = (run: CliRun) => CLI_TERMINAL_STATES.includes(run.state);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function nonempty(value: unknown, name: string, max = 65536): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CliError('invalid_arguments', `Invalid ${name}`);
  return value;
}
export class CliRunStore {
  private runs = new Map<string, CliRun>();
  private pendingIds = new Set<string>();
  private runOrder = new Map<string, number>();
  private nextOrder = 0;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    // X3-F05：cli-runs 只增不减 → 启动 7 天滚动回收（先清盘再加载，内存与磁盘一致）
    sweepExpiredCliRuns(directory);
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      // cli F-01：单个坏文件（半写/外部编辑）throw 会令 startCliRuns 整体失败、整个 CLI 禁用。
      // 改名 .bad 保留现场 + console.error + 跳过，其余 run 正常加载。
      let run: CliRun;
      try {
        run = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as CliRun;
        if (run.runId !== name.slice(0, -5) || !Array.isArray(run.logs) || !Array.isArray(run.workers) || !Array.isArray(run.pending)) throw new Error(`Corrupt CLI run: ${name}`);
      } catch (err) {
        const abs = path.join(directory, name);
        const bad = `${abs}.${new Date().toISOString().replace(/[:.]/g, '-')}.bad`;
        try {
          fs.renameSync(abs, bad);
          console.error(`[cli-runs] 损坏的 run 文件已隔离：${name} → ${path.basename(bad)}，跳过加载:`, err instanceof Error ? err.message : err);
        } catch (renameErr) {
          console.error(`[cli-runs] 损坏的 run 文件隔离失败，跳过加载 ${name}:`, err, renameErr);
        }
        continue;
      }
      this.runOrder.set(run.runId, this.nextOrder++); this.runs.set(run.runId, run);
      if (!terminal(run)) this.change(run.runId, draft => { draft.state = 'interrupted'; draft.pending = []; draft.error = 'Workbench restarted before delivery. Submit a new task explicitly; execution was not replayed.'; }, 'host', 'Run interrupted by restart');
    }
  }
  private save(run: CliRun) {
    writeJsonAtomicSync(path.join(this.directory, `${run.runId}.json`), run);
    if (!this.runs.has(run.runId)) this.runOrder.set(run.runId, this.nextOrder++);
    this.runs.set(run.runId, run);
    if (run.pending.length && !terminal(run)) this.pendingIds.add(run.runId); else this.pendingIds.delete(run.runId);
  }
  get(id: string): CliRun { const run = this.runs.get(id); if (!run) throw new CliError('run_not_found', `Unknown run: ${id}`); return clone(run); }
  view(id: string) { const { pending: _pending, replies: _replies, logs: _logs, nextSeq: _nextSeq, inputHash: _hash, idempotencyKey: _key, ...view } = this.get(id); return view; }
  list(workspaceId: string, offset = 0, limit = 40) {
    const all = [...this.runs.values()].filter(run => run.workspaceId === workspaceId).sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId));
    return { runs: all.slice(offset, offset + limit).map(run => this.view(run.runId)), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
  }
  all() { return [...this.runs.values()].map(clone); }
  /** The scheduler only needs runnable items, never historical logs from finished runs. */
  pending(): CliPendingRun[] {
    return [...this.pendingIds].sort((a, b) => this.runOrder.get(a)! - this.runOrder.get(b)!).flatMap(id => {
      const run = this.runs.get(id);
      return run && !terminal(run) && run.pending.length ? [{ runId: run.runId, workspaceId: run.workspaceId, taskPath: run.taskPath, input: { ...run.pending[0] } }] : [];
    });
  }
  submit(workspaceId: string, text: string, key?: string) {
    nonempty(workspaceId, 'workspace'); nonempty(text, 'text', 262144); if (key) nonempty(key, 'idempotency-key', 200);
    const inputHash = hash(text);
    if (key) {
      const previous = [...this.runs.values()].find(run => run.workspaceId === workspaceId && run.idempotencyKey === key);
      if (previous) { if (previous.inputHash !== inputHash) throw new CliError('idempotency_conflict', 'This key was used with different task content'); return { ...this.view(previous.runId), deduplicated: true }; }
    }
    const runId = randomUUID(), now = Date.now();
    const taskPath = path.join(this.directory, runId, 'task.txt');
    writeTextAtomicSync(taskPath, text);
    const run: CliRun = { runId, workspaceId, state: 'queued', revision: 1, createdAt: now, updatedAt: now, inputHash, idempotencyKey: key, taskPath, workers: [], pending: [{ id: randomUUID(), path: taskPath }], replies: {}, logs: [{ seq: 1, at: now, source: 'caller', text: 'Task submitted' }], nextSeq: 2 };
    this.save(run); return this.view(runId);
  }
  change(id: string, edit: (run: CliRun) => void, source: string, text: string) {
    const run = this.get(id); edit(run); run.revision++; run.updatedAt = Date.now();
    run.logs.push({ seq: run.nextSeq++, at: run.updatedAt, source, text: text.slice(0, 24000) });
    if (run.logs.length > 2000) run.logs.splice(0, run.logs.length - 2000);
    this.save(run); return this.view(id);
  }
  active(id: string) { const run = this.get(id); if (terminal(run)) throw new CliError('run_finished', `Run is ${run.state}`); return run; }
  progress(id: string, text: string) { this.active(id); return this.change(id, run => { if (run.state === 'queued') run.state = 'running'; }, 'scheduler', nonempty(text, 'progress')); }
  question(id: string, text: string) { this.active(id); return this.change(id, run => { run.state = 'waiting'; run.question = { id: randomUUID(), text: nonempty(text, 'question') }; }, 'scheduler', 'Response requested'); }
  reply(id: string, text: string, questionId?: string, key?: string) {
    const run = this.get(id); nonempty(text, 'reply', 262144); if (key) nonempty(key, 'idempotency-key', 200);
    const fingerprint = hash(JSON.stringify([questionId ?? null, text]));
    const replyKey = key ? hash(key) : undefined;
    if (replyKey && Object.hasOwn(run.replies, replyKey)) { if (run.replies[replyKey] !== fingerprint) throw new CliError('idempotency_conflict', 'Reply key was used with different content'); return { ...this.view(id), deduplicated: true }; }
    this.active(id);
    if (run.question ? questionId !== run.question.id : questionId !== undefined) throw new CliError('stale_question', 'Question ID is missing or stale', 'Read run get and answer its current question');
    const replyPath = path.join(this.directory, id, `reply-${randomUUID()}.txt`); writeTextAtomicSync(replyPath, text);
    return this.change(id, draft => { draft.pending.push({ id: randomUUID(), path: replyPath }); if (replyKey) draft.replies[replyKey] = fingerprint; draft.question = undefined; draft.state = 'queued'; }, 'caller', 'Reply submitted');
  }
  deliver(id: string, summary: string, artifacts: unknown, verification: string) {
    const run = this.active(id); nonempty(summary, 'summary'); nonempty(verification, 'verification');
    if (run.question || run.pending.length) throw new CliError('run_not_ready', 'Consume pending instructions and resolve the outstanding question before delivery');
    if (!Array.isArray(artifacts) || artifacts.length > 64 || artifacts.some(item => typeof item !== 'string' || !path.isAbsolute(item) || item.length > 4096)) throw new CliError('invalid_arguments', 'Artifacts must be up to 64 absolute file paths');
    return this.change(id, draft => { draft.state = 'delivered'; draft.result = { summary, artifacts: [...artifacts], verification }; }, 'scheduler', 'Result explicitly delivered');
  }
  fail(id: string, error: string) { this.active(id); return this.change(id, run => { run.state = 'failed'; run.error = nonempty(error, 'error'); run.pending = []; }, 'scheduler', 'Run failed'); }
  cancel(id: string) { const run = this.get(id); if (terminal(run)) return this.view(id); return this.change(id, draft => { draft.state = 'cancelled'; draft.pending = []; draft.question = undefined; }, 'caller', 'Cancellation requested'); }
  logs(id: string, after = 0, limit = 40) {
    const run = this.get(id), events = run.logs.filter(event => event.seq > after).slice(0, limit);
    const nextCursor = events.at(-1)?.seq ?? after;
    return { runId: id, events, nextCursor, hasMore: run.logs.some(event => event.seq > nextCursor), truncated: after < (run.logs[0]?.seq ?? 1) - 1 };
  }
}
