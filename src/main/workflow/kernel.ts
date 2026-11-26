/**
 * 工作流执行内核（dynamic-workflow W1）：每个 run 一个 worker_threads Worker（eval 内嵌
 * 源码，同 nodeRepl/session.ts），动态 import 工作流的 run.mjs 并调用其默认导出；
 * `wf.*` 经 postMessage 桥回主进程执行（WorkflowRuntime 实现）。取消/超限用
 * worker.terminate() 硬杀。**不是安全沙箱**：脚本拥有完整 Node 能力，边界由首次运行
 * 的信任确认承担（与动态工具同口径）。只依赖 node:worker_threads，便于离线直测。
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

/** Worker 侧源码：wf 桥 + import + 结果回传。state 随每次调用快照回主进程（续跑用） */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
let seq = 0;
const pending = new Map();
const state = workerData.state && typeof workerData.state === 'object' ? workerData.state : {};
function snapshot() {
  try { return JSON.parse(JSON.stringify(state)); } catch { return undefined; }
}
function errText(e) {
  return e && typeof e.message === 'string' ? e.message : String(e);
}
parentPort.on('message', (m) => {
  if (!m || m.type !== 'reply') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(new Error(m.error));
});
function call(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', id, method, args, state: snapshot() });
  });
}
const wf = Object.freeze({
  args: Object.freeze({ ...(workerData.args || {}) }),
  state,
  runId: workerData.runId,
  delegate: (opts) => call('delegate', [opts]),
  waitFor: (match, opts) => call('waitFor', [match, opts]),
  ask: (question, opts) => call('ask', [question, opts]),
  run: (cmd, args, opts) => call('run', [cmd, args, opts]),
  tool: (name, args) => call('tool', [name, args]),
  read: (p) => call('read', [p]),
  glob: (pattern) => call('glob', [pattern]),
  call: (name, args) => call('call', [name, args]),
  phase: (name) => call('phase', [name]),
  checkpoint: () => call('checkpoint', []),
  log: (text) => call('log', [String(text)])
});
(async () => {
  try {
    const url = pathToFileURL(workerData.script).href + '?v=' + encodeURIComponent(workerData.fingerprint || '');
    const mod = await import(url);
    const fn = mod && mod.default;
    if (typeof fn !== 'function') throw new Error('run.mjs 必须 export default async function (wf, args)');
    if (workerData.validateOnly) {
      parentPort.postMessage({ type: 'done', ok: true, result: null });
      return;
    }
    const result = await fn(wf, wf.args);
    let out = null;
    try { out = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch { out = String(result); }
    parentPort.postMessage({ type: 'done', ok: true, result: out, state: snapshot() });
  } catch (e) {
    parentPort.postMessage({ type: 'done', ok: false, error: errText(e), state: snapshot() });
  }
})();
`;

export interface KernelCall {
  method: string;
  args: unknown[];
  state?: Record<string, unknown>;
}

export type KernelOutcome =
  | { ok: true; result: unknown; state?: Record<string, unknown> }
  | { ok: false; error: string; state?: Record<string, unknown>; killed?: boolean };

export interface KernelStartOptions {
  runId: string;
  /** 原脚本路径（r2-W1：快照落同目录，保留 run.mjs 相对 import 的解析） */
  script: string;
  /** 已确认的脚本字节（r2-W1 执行绑定）：提供时内核把它快照到同目录隐藏文件后 import
   *  快照，而不是直接 import 可变的 run.mjs——重读与 worker import 之间的磁盘竞态
   *  不再能植入未经确认的字节。缺省读原路径（旧调用方/兼容）。 */
  scriptSource?: string;
  fingerprint: string;
  args: Record<string, unknown>;
  state: Record<string, unknown>;
  /** wf.* 调用：resolve 值回传脚本，reject 让脚本侧 await 抛错 */
  onCall: (call: KernelCall) => Promise<unknown>;
}

export class WorkflowKernel {
  private worker: Worker | null = null;
  private termination?: Promise<void>;
  private workerTermination?: Promise<void>;
  private readonly calls = new Set<Promise<unknown>>();
  private settle: ((o: KernelOutcome) => void) | null = null;
  /** 快照文件（scriptSource 模式）：内核结束后删除；崩溃残留无害（同名指纹内容一致，下次启动新实例不依赖它） */
  private execFileToClean: string | null = null;
  readonly done: Promise<KernelOutcome>;

  constructor(private opts: KernelStartOptions) {
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  start(): void {
    let execPath = this.opts.script;
    if (this.opts.scriptSource !== undefined) {
      // 执行绑定（r2-W1）：把已确认字节快照到脚本同目录的隐藏文件，worker import 快照。
      // 同目录保位 run.mjs 相对 import（./lib.mjs 等）解析不变；写不进快照就不执行——
      // 不回退原路径（那会重新打开「重读→import」竞态窗口）
      execPath = path.join(
        path.dirname(this.opts.script),
        `.exec-${this.opts.fingerprint}-${this.opts.runId.replace(/[^\w-]/g, '')}.mjs`
      );
      try {
        fs.writeFileSync(execPath, this.opts.scriptSource, 'utf8');
        this.execFileToClean = execPath;
      } catch (err) {
        this.finish({
          ok: false,
          error: `无法绑定已确认的脚本内容（快照写入失败，未执行）：${err instanceof Error ? err.message : String(err)}`
        });
        return;
      }
    }
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        runId: this.opts.runId,
        script: execPath,
        fingerprint: this.opts.fingerprint,
        args: this.opts.args,
        state: this.opts.state
      }
    });
    this.worker = w;
    w.on('message', (m: { type?: string; id?: number } & Record<string, unknown>) => {
      if (m?.type === 'call') {
        if (!this.settle) return;
        const call: KernelCall = {
          method: String(m.method),
          args: Array.isArray(m.args) ? m.args : [],
          ...(m.state && typeof m.state === 'object' ? { state: m.state as Record<string, unknown> } : {})
        };
        const pending = Promise.resolve().then(() => this.opts.onCall(call));
        this.calls.add(pending);
        void pending.then(
            (value) => this.reply(m.id!, true, value),
            (err) => this.reply(m.id!, false, undefined, err instanceof Error ? err.message : String(err))
          ).finally(() => this.calls.delete(pending)).catch(error => console.error('[workflow] call reply failed', error));
        return;
      }
      if (m?.type === 'done') {
        const state = m.state && typeof m.state === 'object' ? (m.state as Record<string, unknown>) : undefined;
        this.finish(
          m.ok
            ? { ok: true, result: m.result, ...(state ? { state } : {}) }
            : { ok: false, error: String(m.error ?? '脚本失败'), ...(state ? { state } : {}) }
        );
        void this.release().catch(error => console.error('[workflow] kernel release failed', error));
      }
    });
    w.on('error', (err: Error) => this.finish({ ok: false, error: `执行内核出错：${err.message}` }));
    w.on('exit', (code) => { if (this.worker === w) this.worker = null; this.finish({ ok: false, error: `执行内核意外退出（code ${code}）`, killed: true }); });
  }

  private reply(id: number, ok: boolean, value?: unknown, error?: string): void {
    if (!this.worker) return;
    try {
      this.worker.postMessage(ok ? { type: 'reply', id, ok: true, value: value ?? null } : { type: 'reply', id, ok: false, error });
    } catch (err) {
      // 结果不可克隆（函数/循环引用等）：退化为错误回给脚本
      this.worker.postMessage({ type: 'reply', id, ok: false, error: `返回值无法传回脚本：${(err as Error).message}` });
    }
  }

  private finish(o: KernelOutcome): void {
    const s = this.settle;
    if (!s) return;
    this.settle = null;
    if (this.execFileToClean) {
      try {
        fs.unlinkSync(this.execFileToClean);
      } catch {
        /* 崩溃残留无害（同指纹同字节）；下次实例不依赖它 */
      }
      this.execFileToClean = null;
    }
    s(o);
  }

  /** 硬杀（取消/超限/关机）；done 以 killed 结局 resolve */
  kill(reason: string): void {
    this.finish({ ok: false, error: reason, killed: true });
    void this.release().catch(error => console.error('[workflow] kernel release failed', error));
  }

  /** Business completion and real Worker/host-call reclamation are separate barriers. */
  release(): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = (async () => {
      await this.releaseWorker();
      while (this.calls.size) await Promise.allSettled([...this.calls]);
    })();
    void this.termination.catch(() => { this.termination = undefined; });
    return this.termination;
  }

  releaseWorker(): Promise<void> {
    if (this.workerTermination) return this.workerTermination;
    const worker = this.worker;
    this.workerTermination = (async () => {
      if (worker) { await worker.terminate(); if (this.worker === worker) this.worker = null; }
    })();
    void this.workerTermination.catch(() => { this.workerTermination = undefined; });
    return this.workerTermination;
  }
}

export interface WorkflowWorkerLease {
  readonly released: boolean;
  release(): Promise<void>;
}

/**
 * 冒烟：import 脚本快照（scriptSource 提供时绑定已确认字节，r2-W1）检查默认导出是
 * 函数，不执行（workflow.validate）。同目录快照保相对 import；快照写入失败直接报错不回退。
 */
export function smokeImportWorkflow(
  script: string,
  fingerprint: string,
  timeoutMs = 10_000,
  scriptSource?: string,
  signal?: AbortSignal,
  own?: (lease: WorkflowWorkerLease) => void
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve('import 已由宿主取消');
  return new Promise((resolve, reject) => {
    let execFile: string | null = null;
    let target = script;
    if (scriptSource !== undefined) {
      target = execFile = path.join(
        path.dirname(script),
        `.exec-validate-${fingerprint}-${randomUUIDish()}.mjs`
      );
      try {
        fs.writeFileSync(execFile, scriptSource, 'utf8');
      } catch (err) {
        resolve(`无法绑定已确认的脚本内容（快照写入失败，未 import）：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { runId: 'validate', script: target, fingerprint: `${fingerprint}-v${Date.now()}`, args: {}, state: {}, validateOnly: true }
    });
    let released = false, releasing: Promise<void> | undefined;
    const lease: WorkflowWorkerLease = {
      get released() { return released; },
      release: () => {
        if (releasing) return releasing;
        releasing = w.terminate().then(() => {
          released = true;
          if (execFile) { try { fs.unlinkSync(execFile); } catch { /* stale snapshot is harmless */ } }
        });
        void releasing.catch(() => { releasing = undefined; });
        return releasing;
      }
    };
    own?.(lease);
    let settled = false;
    const done = (err: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void lease.release().then(() => {
        resolve(err);
      }, reject);
    };
    const timer = setTimeout(() => done('import 超时（模块顶层有阻塞代码？）'), timeoutMs);
    timer.unref?.();
    const abort = () => done('import 已由宿主取消');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    w.on('message', (m: { type?: string; ok?: boolean; error?: string }) => {
      if (m?.type === 'done') done(m.ok ? null : String(m.error ?? 'import 失败'));
    });
    w.on('error', (err: Error) => done(err.message));
    w.on('exit', (code) => done(`执行内核意外退出（code ${code}）`));
  });
}

function randomUUIDish(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
