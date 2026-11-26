/**
 * NodeReplSession：每会话一个持久 Node 代码执行内核（zcode-adopt-batch-d S2.2/T2）。
 * - 执行内核跑在独立 worker_threads Worker 里（eval 内嵌源码，免打包额外文件）：
 *   超时/取消用 worker.terminate() 硬杀——同步死循环与异步微任务死循环都能被杀，
 *   不再依赖主进程事件循环（原 vm+宏任务轮询实现会被 `for(;;) await Promise.resolve()`
 *   饿死、冻结整个主进程）。
 * - 跨调用 globalThis：同一 session 复用同一 Worker 全局；var/function/全局赋值保留，
 *   顶层 const/let 经 instrument 改写为 globalThis 赋值后同样保留。
 *   terminate 后 Worker 重建，旧绑定/定时器随进程消失（即「上下文已整体重建」语义）。
 * - generation 单调递增防 ABA：reset 后旧 generation 的迟到回包一律无效。
 * - 并发串行化：同 session 的并发 run 排队执行，避免共享全局互相污染。
 * - console 输出在 Worker 侧行数/字节双上限截断，且所有终态路径都带回（error 不残留串台）。
 * 只依赖 node:worker_threads，无 electron；test/node-repl.mjs 转译直测。
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import {
  formatNodeReplValue,
  isNodeReplStaleGeneration,
  nodeReplKernelResetNote,
  resolveNodeReplTimeoutMs,
  truncateNodeReplOutput,
  type NodeReplResetReason,
  type NodeReplRunResult
} from '../../shared/nodeRepl';

/**
 * 顶层声明改写：var/let/const 单绑定、function、class → globalThis 赋值。
 * 仅在花括号深度 0 的行生效（嵌套块内声明不改写）；扫描器跳过字符串/模板/注释。
 * 多绑定与解构不改写（仍为脚本作用域，下次调用不可见——合同里写明）。
 */
export function instrumentNodeReplTopLevel(code: string): string {
  const out: string[] = [];
  let depth = 0;
  let lineDepth = 0;
  let i = 0;
  let line = '';
  const flushLine = (raw: string): void => {
    out.push(lineDepth === 0 ? rewriteTopLevelLine(raw) : raw);
    line = '';
    lineDepth = depth;
  };
  while (i < code.length) {
    const ch = code[i];
    // 注释
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl + 1;
      line += code.slice(i, end);
      if (nl !== -1) {
        flushLine(line.replace(/\n$/, ''));
        out.push('');
        i = end;
        continue;
      }
      i = end;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      line += code.slice(i, stop);
      i = stop;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === quote) break;
        if (quote === '`' && code[j] === '$' && code[j + 1] === '{') {
          j += 2;
          let inner = 1;
          while (j < code.length && inner > 0) {
            if (code[j] === '{') inner++;
            else if (code[j] === '}') inner--;
            j++;
          }
          continue;
        }
        j++;
      }
      line += code.slice(i, Math.min(j + 1, code.length));
      i = j + 1;
      continue;
    }
    if (ch === '\n') {
      flushLine(line);
      out.push('');
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    line += ch;
    i++;
  }
  if (line.length > 0) flushLine(line);
  return out.join('\n');
}

function rewriteTopLevelLine(raw: string): string {
  const decl = raw.match(/^(\s*)(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(=|;|$)(.*)$/);
  if (decl) {
    const [, indent, , name, sep, rest] = decl;
    if (sep === '=') return `${indent}globalThis.${name} =${rest}`;
    return `${indent}globalThis.${name} = undefined;${rest}`;
  }
  const fn = raw.match(/^(\s*)(?:export\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)(.*)$/);
  if (fn) {
    const [, indent, asyncKw = '', name, rest] = fn;
    return `${indent}globalThis.${name} = ${asyncKw}function ${name}${rest}`;
  }
  const cls = raw.match(/^(\s*)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)(.*)$/);
  if (cls) {
    const [, indent, name, rest] = cls;
    return `${indent}globalThis.${name} = class ${name}${rest}`;
  }
  return raw;
}

export interface NodeReplRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Worker 侧执行内核源码（eval 模式内嵌，避免打包额外文件）。
 * 职责：console 截断捕获、间接 eval 进 Worker 全局（跨调用状态即 Worker 全局）、
 * 异步完成值 await、结果/错误序列化回传。超时/取消由主进程 terminate 兜底——
 * Worker 内不做任何超时（同步/异步死循环都靠硬杀）。
 * 回包防伪：bootstrap 即捕获 bind 过的 postMessage（用户代码替换
 * parentPort.postMessage 方法无效），回包带主进程 per-run secret（闭包内，
 * 执行中的代码不可见）。
 */
const WORKER_SOURCE = [
  "'use strict';",
  'const { parentPort } = require("node:worker_threads");',
  'const util = require("node:util");',
  'const post = parentPort.postMessage.bind(parentPort);',
  'const MAX_LINES = 500;',
  'const MAX_BYTES = 64 * 1024;',
  'let lines = [];',
  'let bytes = 0;',
  'let truncated = false;',
  'function capture(args) {',
  '  if (lines.length >= MAX_LINES || bytes >= MAX_BYTES) { truncated = true; return; }',
  '  const s = util.formatWithOptions({ depth: 2 }, ...args);',
  '  bytes += s.length;',
  '  lines.push(s);',
  '}',
  "for (const m of ['log', 'info', 'warn', 'error']) { console[m] = (...a) => capture(a); }",
  'function takeLines() {',
  '  const out = lines;',
  "  if (truncated) out.push('[console \\u8f93\\u51fa\\u5df2\\u622a\\u65ad]');",
  '  lines = []; bytes = 0; truncated = false;',
  '  return out;',
  '}',
  'parentPort.on("message", (msg) => {',
  '  const id = msg.id;',
  '  const secret = msg.secret;',
  '  Promise.resolve()',
  '    .then(() => {',
  '      const value = (0, eval)(msg.code);',
  '      if (value !== null && typeof value === "object" && typeof value.then === "function") return value;',
  '      return value;',
  '    })',
  '    .then(',
  '      (value) => {',
  '        const text = value === undefined ? "" : util.formatWithOptions({ depth: 2, breakLength: 80 }, value).replace(/\\n$/, "");',
  '        post({ id, secret, ok: true, text, hasValue: value !== undefined, lines: takeLines() });',
  '      },',
  '      (err) => {',
  '        const name = err && typeof err === "object" && typeof err.name === "string" && err.name ? err.name : "Error";',
  '        const message = err && typeof err === "object" && typeof err.message === "string" && err.message ? err.message : String(err);',
  '        post({ id, secret, ok: false, name, message, lines: takeLines() });',
  '      }',
  '    );',
  '});'
].join('\n');

interface WorkerReply {
  id: number;
  secret?: string;
  ok: boolean;
  text?: string;
  /** 求值是否有返回值（undefined 时 false）；旧 Worker 缺省视为有值 */
  hasValue?: boolean;
  name?: string;
  message?: string;
  lines?: string[];
}

/**
 * 持久 REPL 会话。同一实例跨调用保留上下文（Worker 全局）；reset/超时/取消后
 * terminate + generation+1，下次调用重建 Worker（旧状态清零）。
 */
export class NodeReplSession {
  private worker: Worker | null = null;
  private disposed = false;
  private disposal?: Promise<void>;
  private retirements = new Map<Worker, Promise<void> | undefined>();
  private _generation = 1;
  private seq = 0;
  private queueTail: Promise<unknown> = Promise.resolve();
  /** 在飞 run 数（0 时 worker 意外退出由常驻 exit 监听收尸） */
  private activeRuns = 0;

  get generation(): number {
    return this._generation;
  }

  /** 当前 generation 是否仍是 callGeneration（调用方完成时判串线） */
  isCurrentGeneration(callGeneration: number): boolean {
    return !this.disposed && !isNodeReplStaleGeneration(callGeneration, this._generation);
  }

  /** 重建执行内核（terminate）、generation 单调 +1（无 worker 也 +1：取消/复位语义不变）；旧 generation 的迟到回包一并失效 */
  reset(reason: NodeReplResetReason): number {
    void reason;
    if (this.disposed) return this._generation;
    this.killWorker();
    this._generation += 1;
    return this._generation;
  }

  isDisposed(): boolean { return this.disposed; }

  /** Stop admission, terminate every generation, then settle accepted queued calls. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (!this.disposed) { this.disposed = true; this._generation += 1; }
    this.killWorker();
    const disposal = (async () => {
      // A failed terminate must be reported promptly, rather than waiting on
      // the active run that the still-live worker has not finished.
      await this.drainRetirements();
      await this.queueTail;
    })();
    this.disposal = disposal;
    void disposal.catch(() => { if (this.disposal === disposal) this.disposal = undefined; });
    return disposal;
  }

  private terminate(worker: Worker): Promise<void> {
    const pending = this.retirements.get(worker);
    if (pending) return pending;
    const terminating = Promise.resolve().then(() => {
      worker.ref();
      return worker.terminate();
    }).then(() => {
      if (this.retirements.get(worker) === terminating) this.retirements.delete(worker);
    }, error => {
      if (this.retirements.get(worker) === terminating) this.retirements.set(worker, undefined);
      console.error('[nodeRepl] worker termination failed', error);
      throw error;
    });
    this.retirements.set(worker, terminating);
    void terminating.catch(() => {});
    return terminating;
  }

  private killWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    void this.terminate(worker);
  }

  private async drainRetirements(): Promise<void> {
    while (this.retirements.size) {
      const results = await Promise.allSettled([...this.retirements.keys()].map(worker => this.terminate(worker)));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, `Node execution worker cleanup failed: ${errors.map(String).join('; ')}`);
    }
  }

  private cancelledResult(): NodeReplRunResult {
    return { status: 'cancel', text: nodeReplKernelResetNote('cancel'), generation: this._generation, kernelReset: true };
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Node execution session is disposed');
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_SOURCE, { eval: true });
    // 常驻收尸：空闲期 Worker 自杀（用户代码 setTimeout(()=>process.exit()) 在 run
    // 结算后才生效）不再留下僵尸引用——下一次 run 会重建而不是打死 worker 空等超时。
    // 在飞 run 的退出由其自身的 exit 监听结算（activeRuns>0 时这里不动）。
    w.on('exit', () => {
      if (this.worker === w && this.activeRuns === 0) {
        this.worker = null;
        this._generation += 1;
      }
    });
    this.worker = w;
    return w;
  }

  /** 执行一段代码（同 session 串行）。超时/取消 → terminate + kernel reset 指引。 */
  run(code: string, opts: NodeReplRunOptions = {}): Promise<NodeReplRunResult> {
    if (this.disposed) return Promise.reject(new Error('Node execution session is disposed'));
    const task = (): Promise<NodeReplRunResult> => this.disposed ? Promise.resolve(this.cancelledResult()) : this.runSerialized(code, opts);
    const p = this.queueTail.then(task, task);
    this.queueTail = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  private async runSerialized(code: string, opts: NodeReplRunOptions): Promise<NodeReplRunResult> {
    const timeoutMs = resolveNodeReplTimeoutMs(opts.timeoutMs);
    const signal = opts.signal;

    if (signal?.aborted) {
      this.reset('cancel');
      return {
        status: 'cancel',
        text: nodeReplKernelResetNote('cancel'),
        generation: this._generation,
        kernelReset: true
      };
    }

    await this.drainRetirements();
    if (this.disposed) return this.cancelledResult();
    if (signal?.aborted) { this.reset('cancel'); return this.cancelledResult(); }
    const callGeneration = this._generation;
    const worker = this.ensureWorker();
    const id = ++this.seq;
    // per-run 回包防伪 secret：闭包内持有，回包必须带同值——执行中的代码猜不到
    const secret = randomUUID();
    this.activeRuns += 1;
    return new Promise<NodeReplRunResult>((resolve) => {
      let settled = false;
      let resetting = false;
      const finish = (r: NodeReplRunResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      };
      const finishReset = (result: NodeReplRunResult): void => {
        void this.drainRetirements().then(() => finish(result), error => finish({ status: 'error', text: `执行内核回收失败：${String(error)}`, generation: this._generation, kernelReset: true }));
      };
      const onMessage = (msg: WorkerReply): void => {
        if (resetting) return;
        if (!msg || msg.id !== id || msg.secret !== secret) return;
        if (this.disposed || this.worker !== worker || callGeneration !== this._generation) {
          finish({ status: 'cancel', text: nodeReplKernelResetNote('cancel'), generation: callGeneration, kernelReset: true });
          return;
        }
        if (msg.ok) {
          const hasValue = msg.hasValue !== false; // 旧 Worker 回执缺省视为有值
          const body = [formatNodeReplValue(msg.text ?? '', hasValue), ...(msg.lines ?? [])]
            .filter((s) => s.length > 0)
            .join('\n');
          finish({
            status: 'ok',
            text: truncateNodeReplOutput(body),
            hasValue,
            generation: this._generation,
            kernelReset: false
          });
        } else {
          const body = [
            ...(msg.lines ?? []),
            `${msg.name ?? 'Error'}: ${msg.message ?? ''}`
          ]
            .filter((s) => s.length > 0)
            .join('\n');
          finish({
            status: 'error',
            text: truncateNodeReplOutput(body),
            generation: this._generation,
            kernelReset: false
          });
        }
      };
      // Worker 消失：主动 reset/超时/取消路径已先行结算（settled），这里兜住
      // 「执行期间外部 reset」与「用户代码 process.exit() 自杀」两类。
      const onExit = (): void => {
        if (settled || resetting) return;
        if (this.worker !== worker) {
          finish({
            status: 'cancel',
            text: nodeReplKernelResetNote('cancel'),
            generation: callGeneration,
            kernelReset: true
          });
          return;
        }
        this.reset('cancel');
        finish({
          status: 'error',
          text: '执行内核意外退出（代码可能调用了 process.exit()）：上下文已整体重建，重新初始化所需状态后再继续。',
          generation: this._generation,
          kernelReset: true
        });
      };
      const onError = (err: Error): void => {
        if (settled || resetting) return;
        resetting = true;
        this.reset('cancel');
        finishReset({
          status: 'error',
          text: truncateNodeReplOutput(`KernelError: ${err?.message ?? String(err)}`),
          generation: this._generation,
          kernelReset: true
        });
      };
      const timer = setTimeout(() => {
        if (settled || resetting) return;
        resetting = true;
        this.reset('timeout');
        finishReset({
          status: 'timeout',
          text: nodeReplKernelResetNote('timeout'),
          generation: this._generation,
          kernelReset: true
        });
      }, timeoutMs);
      const onAbort = (): void => {
        if (settled || resetting) return;
        resetting = true;
        this.reset('cancel');
        finishReset({
          status: 'cancel',
          text: nodeReplKernelResetNote('cancel'),
          generation: this._generation,
          kernelReset: true
        });
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        worker.off('error', onError);
        this.activeRuns = Math.max(0, this.activeRuns - 1);
        // 空闲不吊住进程退出（下次 run 前 ref 回来）
        if (this.worker === worker) worker.unref?.();
      };
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.on('error', onError);
      worker.ref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        worker.postMessage({ id, secret, code: instrumentNodeReplTopLevel(code) });
      } catch (e) {
        finish({
          status: 'error',
          text: truncateNodeReplOutput(`PostMessageError: ${(e as Error)?.message ?? String(e)}`),
          generation: this._generation,
          kernelReset: false
        });
      }
    });
  }
}
