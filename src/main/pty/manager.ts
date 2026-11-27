import { t } from '../../shared/i18n';
import { createOwnedInteractivePty, InteractivePtyCancelledError, InteractivePtyStartupCleanupError, type InteractivePtyOwner } from './interactiveOwner';
import { randomUUID } from 'node:crypto';
import { startOwnedBackgroundPty, type OwnedBackgroundPty } from './backgroundOwner';
import * as pty from 'node-pty';
import { preparePtySpawnHelper } from './spawnHelper';
import type { BrowserWindow } from 'electron';
import type { ResolvedLaunch, TerminalStatus } from '../../shared/types';
import { utf8ChildEnv } from '../encoding/winUtf8';
import type { TerminalOutputEvent } from './outputWait';
import {
  appendPtyChunk,
  createPtyChunkBuf,
  joinPtyChunks,
  type PtyChunkBuf
} from '../../shared/ptyBuffer';

const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 30;
/** pty:data 合流窗口：ConPTY TUI 整屏重绘每秒可产生上千 chunk，按会话拼成一条 IPC */
const PTY_DATA_FLUSH_MS = 8;

interface PtyEntry {
  proc: pty.IPty;
  buf: PtyChunkBuf;
  status: TerminalStatus;
  /** 最近一次收到 pty 输出的时间戳（ms） */
  lastOutputAt: number;
  generation: string;
  outputChars: number;
  exitCode?: number;
  logicalExitCode?: number;
  disposed?: boolean;
  acceptingInput?: boolean;
}

/** 尾部拼接缓存：buffer 长度未变时复用上次结果，静默期轮询不再重复拼串 */
interface BufferTailCache {
  len: number;
  maxChars: number;
  tail: string;
}

interface TermSize {
  cols: number;
  rows: number;
}

/** Free SDK PTY resources only after a confirmed exit; live trees require their creation owner. */
export function disposePtyAsync(proc: pty.IPty, exited = false): void {
  if (!exited) throw new Error('Live PTY cleanup requires its creation owner');
  setImmediate(() => {
    const agent = (proc as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]>; kill?: () => void } })._agent;
    if (process.platform === 'win32' && agent?._getConsoleProcessList) agent._getConsoleProcessList = async () => [];
    try { if (process.platform === 'win32' && agent?.kill) agent.kill(); else proc.kill(); } catch { /* Idempotent disposal after actual exit. */ }
  });
}

function disposeEntry(entry: PtyEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  disposePtyAsync(entry.proc, entry.status === 'exited');
}

/**
 * 按 sessionId 隔离的 node-pty 会话池。
 * 输出数据带 sessionId 广播给渲染层，天然不串台；
 * 同时保留 scrollback buffer 供切回会话时回放。
 */
export class PtyManager {
  private entries = new Map<string, PtyEntry>();
  private stopping = false;
  private interactiveOwners = new Map<string, InteractivePtyOwner>();
  private retiredOwners = new Map<string, Set<{ close(): Promise<void> }>>();
  private launchTokens = new Map<string, object>();
  private starts = new Set<Promise<unknown>>();
  private queuedInput = new Map<string, { token: object; chunks: string[]; bytes: number }>();
  private reportedOwners = new WeakSet<object>();
  onReclamationError?: (sessionId: string, error: unknown) => void;
  private backgroundOwners = new Map<string, OwnedBackgroundPty>();
  /** 渲染层 fit 结果；spawn 前也可能先到（会话 starting） */
  private sizeBySession = new Map<string, TermSize>();
  /** 最近一次成功 fit，供新会话尚无记录时使用 */
  private lastSize: TermSize = { cols: FALLBACK_COLS, rows: FALLBACK_ROWS };
  /** 待合流发送的 pty 输出（按会话）；scrollback 已在 onData 即时追加 */
  private pendingData = new Map<string, string[]>();
  /** 合流发送定时器（按会话） */
  private flushTimers = new Map<string, NodeJS.Timeout>();
  /** getBufferTail 结果缓存（按会话） */
  private tailCache = new Map<string, BufferTailCache>();
  private outputListeners = new Map<PtyEntry, Set<(event: TerminalOutputEvent) => void>>();
  private getWindow: () => BrowserWindow | null;
  onExit?: (sessionId: string, exitCode: number) => void;
  /** 多播退出监听（后台终端任务等额外消费方） */
  private exitListeners = new Set<(sessionId: string, exitCode: number) => void>();
  /** 可选：每次有输出时回调（shell 活跃态等） */
  onData?: (sessionId: string, data: string) => void;
  /** 可选：按宿主 sessionId 注入 MUSTER_* 等环境变量 */
  getHostEnv?: (sessionId: string) => Record<string, string>;
  /** pty 进程 pid 变化（入站 MCP pid-map） */
  onPtyPid?: (sessionId: string, pid: number | null) => void;
  onAuxiliaryPids?: (sessionId: string, pids: readonly number[]) => () => void;

  constructor(getWindow: () => BrowserWindow | null, private readonly createInteractive = createOwnedInteractivePty) {
    this.getWindow = getWindow;
  }

  /** 订阅所有 pty 退出（含后台任务键）；返回退订函数 */
  addExitListener(fn: (sessionId: string, exitCode: number) => void): () => void {
    this.exitListeners.add(fn);
    return () => {
      this.exitListeners.delete(fn);
    };
  }

  private resolveSize(sessionId: string, cols?: number, rows?: number): TermSize {
    if (cols && rows && cols > 0 && rows > 0) return { cols, rows };
    return this.sizeBySession.get(sessionId) ?? this.lastSize;
  }

  private environment(sessionId: string, launch: ResolvedLaunch): Record<string, string> {
    const env: Record<string, string> = {
      ...utf8ChildEnv(process.env as Record<string, string | undefined>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      TERM_PROGRAM: 'MusterConsole',
      POWERSHELL_TELEMETRY_OPTOUT: process.env.POWERSHELL_TELEMETRY_OPTOUT ?? '1',
      ...(launch.env ?? {}),
      ...(this.getHostEnv?.(sessionId) ?? {})
    };
    delete env.NO_COLOR;
    delete env.CLICOLOR_FORCE;
    env.CLICOLOR = '1';
    env.CLICOLOR_FORCE = '1';
    return env;
  }

  private reportOwner(sessionId: string, owner: object, error: unknown): void {
    if (this.reportedOwners.has(owner)) return;
    this.reportedOwners.add(owner);
    console.error('[pty] owned reclamation failed', sessionId, error);
    this.onReclamationError?.(sessionId, error);
  }

  private retainOwner(sessionId: string, owner: { close(): Promise<void> }): void {
    let retired = this.retiredOwners.get(sessionId);
    if (!retired) { retired = new Set(); this.retiredOwners.set(sessionId, retired); }
    retired.add(owner);
  }

  private detachCurrent(sessionId: string, reason: 'stopped' | 'replaced' = 'stopped'): void {
    const entry = this.entries.get(sessionId);
    const owner = this.interactiveOwners.get(sessionId) ?? this.backgroundOwners.get(sessionId);
    if (entry?.status === 'running' && !owner) throw new Error('PTY creation owner is not yet available; close is unconfirmed');
    if (owner) {
      this.retainOwner(sessionId, owner);
      this.interactiveOwners.delete(sessionId); this.backgroundOwners.delete(sessionId);
    }
    if (!entry) return;
    this.emitOutput(entry, { type: reason }); this.flushPtyData(sessionId);
    this.entries.delete(sessionId); this.tailCache.delete(sessionId); this.onPtyPid?.(sessionId, null);
    if (entry.status === 'exited') disposeEntry(entry);
  }

  private async drainRetired(sessionId: string): Promise<void> {
    const owners = [...(this.retiredOwners.get(sessionId) ?? [])];
    const results = await Promise.allSettled(owners.map(async owner => {
      await owner.close();
      const set = this.retiredOwners.get(sessionId); set?.delete(owner);
      if (!set?.size) this.retiredOwners.delete(sessionId);
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'PTY process/container closure is unconfirmed; owner retained for retry');
  }

  stopAdmission(): void { this.stopping = true; this.launchTokens.clear(); }

  spawn(sessionId: string, launch: ResolvedLaunch, cwd: string, cols?: number, rows?: number,
    onDisposed?: () => void, assertPlacementCurrent?: () => void): Promise<string> {
    if (this.stopping) return Promise.reject(new Error('PTY manager is stopping'));
    const token = {}, env = this.environment(sessionId, launch);
    this.launchTokens.set(sessionId, token); this.queuedInput.set(sessionId, { token, chunks: [], bytes: 0 });
    const assertCurrent = (): void => { if (this.stopping || this.launchTokens.get(sessionId) !== token) throw new InteractivePtyCancelledError(); };
    const operation = Promise.resolve().then(async () => {
      assertCurrent(); this.detachCurrent(sessionId, 'replaced'); await this.drainRetired(sessionId); assertCurrent();
      let entry: PtyEntry | undefined, resourcesEnded = false;
      const endResources = (): void => { if (resourcesEnded) return; resourcesEnded = true; try { onDisposed?.(); } catch (error) { console.error('[pty] process disposal callback failed', error); } };
      const owner = this.createInteractive({ launch, cwd, env, assertCurrent: () => { assertCurrent(); assertPlacementCurrent?.(); },
        monitor: sessionId.startsWith('bg-')
          ? { businessLabel: '后台任务终端', role: '后台任务进程', taskId: sessionId.slice(3) }
          : { businessLabel: '终端会话', role: '终端进程', sessionId },
        spawn: bootstrap => { assertCurrent(); entry = this.spawnRaw(sessionId, bootstrap, cwd, cols, rows, endResources, { ...env, ...bootstrap.env }); entry.status = 'starting'; return entry.proc; },
        commandExited: code => { if (entry) { entry.logicalExitCode = code; entry.acceptingInput = false; } endResources(); }
      });
      this.interactiveOwners.set(sessionId, owner);
      void owner.completed.then(() => { if (this.interactiveOwners.get(sessionId) === owner) this.interactiveOwners.delete(sessionId); }, error => {
        if (error instanceof InteractivePtyCancelledError) return;
        this.retainOwner(sessionId, owner);
        if (this.interactiveOwners.get(sessionId) === owner) this.reportOwner(sessionId, owner, error);
      });
      try {
        await owner.ready; assertCurrent();
        if (!entry || this.entries.get(sessionId) !== entry || entry.status === 'exited' || entry.acceptingInput === false) throw new Error('PTY command exited before launch committed');
        entry.status = 'running'; entry.acceptingInput = true;
        const queued = this.queuedInput.get(sessionId);
        if (queued?.token === token) { this.queuedInput.delete(sessionId); for (const data of queued.chunks) entry.proc.write(data); }
        return entry.generation;
      } catch (error) {
        if (this.interactiveOwners.get(sessionId) === owner) this.interactiveOwners.delete(sessionId);
        if (this.entries.get(sessionId) === entry && entry) { this.entries.delete(sessionId); this.onPtyPid?.(sessionId, null); }
        if (error instanceof InteractivePtyStartupCleanupError) { this.retainOwner(sessionId, owner); this.reportOwner(sessionId, owner, error); }
        // ready already confirms cleanup on failure; the exited-before-commit case needs an explicit barrier.
        else { try { await owner.close(); } catch (cleanup) { this.retainOwner(sessionId, owner); this.reportOwner(sessionId, owner, cleanup); throw new AggregateError([error, cleanup], 'PTY launch and cleanup failed'); } }
        throw error;
      }
    }).finally(() => { this.starts.delete(operation); if (this.queuedInput.get(sessionId)?.token === token) this.queuedInput.delete(sessionId); });
    this.starts.add(operation); return operation;
  }

  private spawnRaw(sessionId: string, launch: ResolvedLaunch, cwd: string, cols?: number, rows?: number, onDisposed?: () => void, suppliedEnv?: Record<string, string>): PtyEntry {
    if (this.entries.has(sessionId)) throw new Error('PTY already exists; close its owner before replacement');

    const size = this.resolveSize(sessionId, cols, rows);
    this.sizeBySession.set(sessionId, size);
    this.lastSize = size;

    const env = suppliedEnv ?? this.environment(sessionId, launch);

    preparePtySpawnHelper();
    const proc = pty.spawn(launch.command,
      process.platform === 'win32' && launch.windowsVerbatimArguments ? launch.args.join(' ') : launch.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd,
      env,
      useConpty: true
    });
    const entry: PtyEntry = {
      proc,
      buf: createPtyChunkBuf(),
      status: 'running',
      lastOutputAt: 0,
      generation: randomUUID(),
      outputChars: 0
    };
    this.entries.set(sessionId, entry);
    this.onPtyPid?.(sessionId, proc.pid);

    proc.onData((data) => {
      if (this.entries.get(sessionId) !== entry) return;
      // scrollback 必须逐 chunk 即时追加（切回会话回放依赖完整 buffer）
      appendPtyChunk(entry.buf, data);
      entry.lastOutputAt = Date.now();
      entry.outputChars += data.length;
      // buffer 饱和时 append+drop 可使 len 保持不变而内容已变，尾部缓存必须随到随失效
      this.tailCache.delete(sessionId);
      // IPC 发送按会话合流（8ms 窗口拼一条），生命周期回调保持即时（一有输出就标 working）
      this.queuePtyData(sessionId, data);
      this.emitOutput(entry, { type: 'data', data });
      this.onData?.(sessionId, data);
    });
    proc.onExit(({ exitCode: nativeExitCode }) => {
      const exitCode = entry.logicalExitCode ?? nativeExitCode;
      // Per-process resources also settle after kill/replacement, whose old UI exit is suppressed.
      try { onDisposed?.(); } catch (error) { console.error('[pty] process disposal callback failed', error); }
      entry.status = 'exited';
      entry.exitCode = exitCode;
      const cur = this.entries.get(sessionId);
      if (cur?.proc !== proc) return;
      // 尾部数据先于 exit 送达，渲染层不能丢最后一段输出
      this.flushPtyData(sessionId);
      this.onPtyPid?.(sessionId, null);
      disposeEntry(entry);
      this.emitOutput(entry, { type: 'exited', exitCode });
      this.getWindow()?.webContents.send('pty:exit', { sessionId, exitCode });
      this.onExit?.(sessionId, exitCode);
      for (const fn of this.exitListeners) {
        try {
          fn(sessionId, exitCode);
        } catch (e) {
          console.error('[pty] exit listener failed', e);
        }
      }
    });
    return entry;
  }

  write(sessionId: string, data: string): boolean {
    const entry = this.entries.get(sessionId);
    if (this.stopping || entry?.acceptingInput === false) return false;
    const queued = this.queuedInput.get(sessionId);
    if (queued && this.launchTokens.get(sessionId) === queued.token) {
      const bytes = Buffer.byteLength(data); if (queued.bytes + bytes > 65536) return false;
      queued.bytes += bytes; queued.chunks.push(data); return true;
    }
    if (!entry || entry.status !== 'running') return false;
    entry.proc.write(data);
    return true;
  }

  /** A delayed submission must never write into a replacement process with the same session ID. */
  captureWriter(sessionId: string): { write(id: string, data: string): boolean } {
    const entry = this.entries.get(sessionId);
    return { write: (id, data) => {
      if (id !== sessionId || !entry || this.entries.get(sessionId) !== entry) return false;
      return this.write(sessionId, data);
    } };
  }

  /** Stable host-owned process identity; output/idle status is not a model turn boundary. */
  desktopProcessGeneration(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    return entry?.status === 'running' && entry.acceptingInput !== false ? entry.generation : undefined;
  }

  getOutputCursor(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? `${entry.generation}:${entry.outputChars}` : undefined;
  }

  /** Attach and read the retained suffix synchronously, so no output can fall between them. */
  observeOutput(sessionId: string, listener: (event: TerminalOutputEvent) => void, after?: string) {
    const entry = this.entries.get(sessionId);
    let backlog = '';
    const retained = entry ? joinPtyChunks(entry.buf) : '';
    let prefix = retained;
    if (after !== undefined) {
      const cursor = /^([\da-f-]{36}):(\d+)$/.exec(after);
      const offset = cursor ? Number(cursor[2]) : NaN;
      if (!entry || !cursor || cursor[1] !== entry.generation) throw new Error(t('输出游标不属于当前终端进程，请重新 capture'));
      if (!Number.isSafeInteger(offset) || offset > entry.outputChars || offset < entry.outputChars - retained.length) throw new Error(t('输出游标已过期或越界，请重新 capture'));
      const split = offset - (entry.outputChars - retained.length);
      prefix = retained.slice(0, split);
      backlog = retained.slice(split);
    }
    if (!entry || entry.status !== 'running') return { running: false, backlog, prefix, exitCode: entry?.exitCode, dispose() {} };
    let listeners = this.outputListeners.get(entry);
    if (!listeners) this.outputListeners.set(entry, listeners = new Set());
    listeners.add(listener);
    return { running: true, backlog, prefix, dispose: () => {
      listeners.delete(listener);
      if (!listeners.size) this.outputListeners.delete(entry);
    } };
  }

  private emitOutput(entry: PtyEntry, event: TerminalOutputEvent): void {
    const listeners = this.outputListeners.get(entry);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { console.error('[pty] output listener failed', error); }
    }
    if (event.type !== 'data') this.outputListeners.delete(entry);
  }

  /**
   * 始终记下尺寸（会话 starting、pty 未起也要记），
   * 否则异步 allocate 后 spawn 会落到默认 120×30，OpenCode 等 TUI 会按窄宽排版。
   */
  resize(sessionId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const size = { cols, rows };
    this.sizeBySession.set(sessionId, size);
    this.lastSize = size;
    const entry = this.entries.get(sessionId);
    if (entry && (entry.status === 'running' || entry.status === 'starting') && entry.acceptingInput !== false) {
      try {
        entry.proc.resize(cols, rows);
      } catch {
        // 进程正在退出时 resize 可能抛错，忽略
      }
    }
  }

  /** Background commands run under a held, authenticated Job/group leader. */
  async spawnOwnedBackground(sessionId: string, launch: ResolvedLaunch, cwd: string, assertCurrent: () => void): Promise<OwnedBackgroundPty> {
    if (this.entries.has(sessionId)) throw new Error('Background PTY already exists');
    let captured: PtyEntry | undefined;
    const owner = await startOwnedBackgroundPty({ launch, cwd, assertCurrent,
      monitor: sessionId.startsWith('bg-')
        ? { businessLabel: '后台任务终端', role: '后台任务进程', taskId: sessionId.slice(3) }
        : { businessLabel: '终端会话', role: '终端进程', sessionId },
      spawn: bootstrap => { captured = this.spawnRaw(sessionId, bootstrap, cwd); return captured.proc; },
      commandExited: code => { if (captured) captured.logicalExitCode = code; }
    });
    this.backgroundOwners.set(sessionId, owner);
    void owner.completed.then(() => { if (this.backgroundOwners.get(sessionId) === owner) this.backgroundOwners.delete(sessionId); }, () => {});
    return owner;
  }

  kill(sessionId: string): void {
    const owner = this.interactiveOwners.get(sessionId) ?? this.backgroundOwners.get(sessionId);
    void this.killAndWait(sessionId).catch(error => this.reportOwner(sessionId, owner ?? {}, error));
  }

  async killAndWait(sessionId: string, expectedGeneration?: string): Promise<void> {
    if (expectedGeneration !== undefined && this.entries.get(sessionId)?.generation !== expectedGeneration) return;
    this.launchTokens.delete(sessionId); this.queuedInput.delete(sessionId);
    this.detachCurrent(sessionId);
    await this.drainRetired(sessionId);
  }

  killAll(): void { void this.killAllAndWait().catch(error => console.error('[pty] shutdown failed', error)); }

  async killAllAndWait(): Promise<void> {
    this.stopAdmission();
    const ids = new Set([...this.entries.keys(), ...this.interactiveOwners.keys(), ...this.backgroundOwners.keys(), ...this.retiredOwners.keys()]);
    const results = await Promise.allSettled([...ids].map(id => this.killAndWait(id)));
    const starts = await Promise.allSettled([...this.starts]);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    for (const result of starts) if (result.status === 'rejected' && result.reason instanceof InteractivePtyStartupCleanupError) errors.push(result.reason);
    if ([...this.retiredOwners.values()].some(owners => owners.size > 0)) errors.push(new Error('Late PTY startup cleanup is unconfirmed; owner retained for retry'));
    if (errors.length) throw new AggregateError(errors, 'Some PTY owners could not confirm closure');
  }

  getBuffer(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? joinPtyChunks(entry.buf) : undefined;
  }

  /**
   * 只取 buffer 尾部 maxChars 字符（从 chunk 数组尾端向前拼，避免全量 join）。
   * 生命周期检测只看尾部窗口，静默期反复轮询时配合 len 缓存零重复拼接。
   * getBuffer（渲染层回填用）保持全量不动。
   */
  getBufferTail(sessionId: string, maxChars: number): string | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    const chunks = entry.buf.chunks;
    const cached = this.tailCache.get(sessionId);
    if (cached && cached.len === entry.buf.len && cached.maxChars === maxChars) {
      return cached.tail;
    }
    const parts: string[] = [];
    let need = maxChars;
    for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
      const c = chunks[i] ?? '';
      if (c.length > need) {
        parts.push(c.slice(c.length - need));
        need = 0;
      } else {
        parts.push(c);
        need -= c.length;
      }
    }
    const tail = parts.reverse().join('');
    this.tailCache.set(sessionId, { len: entry.buf.len, maxChars, tail });
    return tail;
  }

  /** 输出 chunk 入合流队列；首个 chunk 起一个 8ms 定时器统一发送 */
  private queuePtyData(sessionId: string, data: string): void {
    let arr = this.pendingData.get(sessionId);
    if (!arr) {
      arr = [];
      this.pendingData.set(sessionId, arr);
    }
    arr.push(data);
    if (this.flushTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(sessionId);
      this.flushPtyData(sessionId);
    }, PTY_DATA_FLUSH_MS);
    timer.unref?.();
    this.flushTimers.set(sessionId, timer);
  }

  /** 立即发送该会话待发数据（幂等；退出/杀进程/换绑前调用避免丢尾部） */
  private flushPtyData(sessionId: string): void {
    const timer = this.flushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(sessionId);
    }
    const arr = this.pendingData.get(sessionId);
    if (!arr || arr.length === 0) return;
    this.pendingData.delete(sessionId);
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:data', { sessionId, data: arr.join('') });
    }
  }

  /** 最近输出时间；无会话或尚未有输出时返回 0 */
  getLastOutputAt(sessionId: string): number {
    return this.entries.get(sessionId)?.lastOutputAt ?? 0;
  }

  getStatus(sessionId: string): TerminalStatus {
    return this.entries.get(sessionId)?.status ?? 'idle';
  }

  isRunning(sessionId: string): boolean {
    const entry = this.entries.get(sessionId); return entry?.status === 'running' && entry.acceptingInput !== false;
  }
}
