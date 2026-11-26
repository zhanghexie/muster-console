/**
 * 内置浏览器录屏/确定性渲染服务：普通录屏用 CDP Page.startScreencast 采集 JPEG 帧（含 ack），
 * 停止后把帧交给主窗口 renderer 的 WebCodecs VP8 编码桥（JPEG→VideoFrame→
 * VideoEncoder），回收编码块经 webmMuxer 合成可播放 .webm 落盘。
 *
 * 生命周期：preparing → capturing → finalizing → completed | failed | cancelled。
 * 上限（任一触发自动收尾）：时长 120s / 1500 帧 / 200MB 帧数据。
 * 回收：关 tab、guest 换代（wireGuest 重建 debugger 会话，录制监听失效）、应用退出、
 * cancel 均终止 job；cancel 丢弃帧不落盘。
 * 原生 webview 隐藏时普通录屏可能暂停合成；确定性 render job 则直接调用
 * window.renderAt(t) + Page.captureScreenshot，不显示窗口、不抢前台焦点。
 * 产物经 WebCodecs 编成真实 VP8 后复用，不把 JPEG 冒充 VP8；不用于网页浏览呈现。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, WebContents } from 'electron';
import { pruneBrowserCaptures } from '../persistenceSweeps';
import { muxWebm, type ScreencastFrame } from './webmMuxer';
import { t } from '../../shared/i18n';

/**
 * 注入主窗口 main world 的编码函数（renderer 才有 DOM/WebCodecs；preload 隔离层无
 * document）。自包含：JPEG base64 → ImageBitmap → 统一尺寸画布 → VideoFrame →
 * VideoEncoder(VP8) → base64 编码块。恒定关键帧（录屏证据场景 seeking 友好）。
 */
const ENCODE_FRAMES_SCRIPT_FN = `(async (payload) => {
  try {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return { ok: false, error: 'WebCodecs unavailable' };
    }
    const width = payload.width || 64, height = payload.height || 48;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: 'canvas 2d unavailable' };
    const chunks = [];
    let encErr = null;
    const enc = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        let bin = '';
        for (let i = 0; i < buf.length; i += 4096) bin += String.fromCharCode(...buf.subarray(i, i + 4096));
        chunks.push({ data: btoa(bin), ts: Number(chunk.timestamp) / 1000, key: chunk.type === 'key' });
      },
      error: (e) => { encErr = e; }
    });
    enc.configure({ codec: 'vp8', width, height, bitrate: 500000 });
    for (const f of payload.frames) {
      const bin = atob(f.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      ctx.drawImage(bmp, 0, 0, width, height);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(f.timestampMs * 1000) });
      enc.encode(frame, { keyFrame: true });
      frame.close(); bmp.close();
    }
    await enc.flush();
    enc.close();
    if (encErr) return { ok: false, error: encErr.message || 'encoder error' };
    return { ok: true, chunks };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
})`;

const MAX_DURATION_MS = 120_000;
const MAX_FRAMES = 1_500;
const MAX_FRAME_BYTES = 200 * 1024 * 1024;
/** 录制结果元数据保留时长（超时清理仅移除内存态，不动产物文件） */
const JOB_TTL_MS = 60 * 60 * 1_000;
const MAX_RENDER_FRAMES = 1_500;
const MAX_RENDER_DURATION_MS = 120_000;
const RENDER_COMMAND_TIMEOUT_MS = 20_000;
export const DEFAULT_RENDER_WIDTH = 1280;
export const DEFAULT_RENDER_HEIGHT = 720;
export const DEFAULT_RENDER_FPS = 30;
export const DEFAULT_RENDER_DURATION_MS = 10_000;

export type RecordingStatus = 'preparing' | 'capturing' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
export type RenderStatus = 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'failed' | 'cancelled';

export interface RecordingJobView {
  id: string;
  tabId: string;
  status: RecordingStatus;
  phase: RecordingStatus;
  startedAt: number;
  updatedAt: number;
  frameCount: number;
  artifact?: { path: string; mimeType: 'video/webm'; width: number; height: number; durationMs: number; frameCount: number };
  error?: string;
}

export interface RenderArtifact {
  path: string;
  mimeType: 'video/webm';
  width: number;
  height: number;
  durationMs: number;
  frameCount: number;
}

export interface RenderFailure {
  stage: RenderStatus;
  frameIndex?: number;
  timeMs?: number;
  message: string;
  nextStep: string;
}

export interface RenderJobView {
  id: string;
  tabId: string;
  status: RenderStatus;
  phase: RenderStatus;
  startedAt: number;
  updatedAt: number;
  width: number;
  height: number;
  totalFrames: number;
  frameCount: number;
  currentTimeMs?: number;
  artifact?: RenderArtifact;
  error?: string;
  failure?: RenderFailure;
}

interface RecordingJob extends RecordingJobView {
  frames: ScreencastFrame[];
  frameBytes: number;
  startTimestamp: number;
  encodeError?: Error;
  cleanupTimer?: NodeJS.Timeout;
}

interface RenderJob extends RenderJobView {
  ownerWorkspaceId?: string;
  ownerSessionId?: string;
  times: number[];
  frames: ScreencastFrame[];
  frameBytes: number;
  cancelController: AbortController;
  restoreViewport?: () => Promise<void> | void;
  cleanupTimer?: NodeJS.Timeout;
}

function normalizeRenderTimes(times: number[]): number[] {
  if (!Array.isArray(times) || !times.length || times.length > MAX_RENDER_FRAMES) {
    throw new Error(t('确定性渲染 times 必须是 1-{{max}} 个时间点', { max: MAX_RENDER_FRAMES }));
  }
  const normalized = times.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value) || value < 0 || value > MAX_RENDER_DURATION_MS)) {
    throw new Error(t('确定性渲染时间点必须在 0-{{max}}ms 范围内', { max: MAX_RENDER_DURATION_MS }));
  }
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i] < normalized[i - 1]) throw new Error(t('确定性渲染 times 必须按时间递增'));
  }
  return normalized;
}

async function withDebuggerTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t('浏览器渲染命令超时（{{timeout}}ms）', { timeout: timeoutMs }))), timeoutMs);
        abort = () => reject(new Error(t('确定性渲染已取消')));
        signal.addEventListener('abort', abort, { once: true });
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export interface RecordingEncodeChunk {
  dataBase64: string;
  timestampMs: number;
  key: boolean;
}

/** 帧上限决策（纯逻辑）：返回应停止采集的原因，null=继续 */
export function shouldStopCapturing(
  frames: number,
  frameBytes: number,
  elapsedMs: number
): 'frames' | 'bytes' | 'duration' | null {
  if (frames >= MAX_FRAMES) return 'frames';
  if (frameBytes >= MAX_FRAME_BYTES) return 'bytes';
  if (elapsedMs >= MAX_DURATION_MS) return 'duration';
  return null;
}

export class BrowserRecordingService {
  private jobs = new Map<string, RecordingJob>();
  private renderJobs = new Map<string, RenderJob>();
  private seq = 0;
  private renderSeq = 0;
  private capturingByTab = new Map<string, string>();
  private renderingByTab = new Map<string, string>();

  constructor(
    /** 取目标 guest（经 BrowserTabService 注册表） */
    private getGuest: (tabId: string) => WebContents | null,
    private getWindow: () => BrowserWindow | null,
    private capturesDir: string,
    /** 录制期间关渲染节流（后台 webview 不产合成帧→screencast 无帧，实测根因）；结束时恢复 */
    private setThrottle: (tabId: string, busy: boolean) => void = () => {},
    /** Trusted embedder presentation; focus emulation can spoof guest visibilityState. */
    private isPresented: (tabId: string) => Promise<boolean> = async () => false
  ) {}

  /** 开始录制：guest 必须已挂载且 debugger 已附（BrowserTabService wireGuest 保证） */
  async start(tabId: string): Promise<RecordingJobView> {
    const existing = this.capturingByTab.get(tabId);
    if (existing) {
      const job = this.jobs.get(existing);
      if (job && (job.status === 'capturing' || job.status === 'preparing')) {
        throw new Error(t('该标签已有进行中的录制：{{id}}', { id: existing }));
      }
    }
    const deterministic = this.renderingByTab.get(tabId);
    if (deterministic) {
      const render = this.renderJobs.get(deterministic);
      if (render && (render.status === 'preparing' || render.status === 'rendering' || render.status === 'finalizing')) {
        throw new Error(t('该标签已有进行中的确定性渲染：{{id}}', { id: deterministic }));
      }
    }
    const wc = this.getGuest(tabId);
    if (!wc) throw new Error(t('浏览器标签尚未挂载，稍后重试'));
    if (!wc.debugger.isAttached()) throw new Error(t('浏览器调试通道未就绪，稍后重试'));
    // A hidden native webview may execute DOM without producing compositor
    // frames. Do not accept an empty recording or reveal it behind the user.
    const presented = await this.isPresented(tabId);
    if (this.getGuest(tabId) !== wc || wc.isDestroyed()) throw new Error(t('浏览器页面已关闭或换代'));
    if (!presented) {
      throw new Error(t('capability_unsupported: 隐藏的原生网页不能保证录屏产帧，请手动显示该页后再录制；未切换前台或焦点'));
    }
    // Visibility probing yields; another caller may have claimed this tab.
    if (this.capturingByTab.has(tabId)) throw new Error(t('该标签已有进行中的录制：{{id}}', { id: this.capturingByTab.get(tabId)! }));
    const id = `rec${++this.seq}-${randomUUID().slice(0, 6)}`;
    const job: RecordingJob = {
      id, tabId, status: 'preparing', phase: 'preparing',
      startedAt: Date.now(), updatedAt: Date.now(),
      frames: [], frameBytes: 0, startTimestamp: 0, frameCount: 0
    };
    this.jobs.set(id, job);
    this.capturingByTab.set(tabId, id);
    const onMessage = (_ev: unknown, method: string, params: unknown): void => {
      if (method !== 'Page.screencastFrame') return;
      const p = params as {
        data?: string;
        metadata?: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
        sessionId?: string;
      };
      if (typeof p?.data !== 'string') return;
      if (this.capturingByTab.get(tabId) !== id) return;
      const rel = job.startTimestamp > 0 && p.metadata?.timestamp
        ? Math.max(0, (p.metadata.timestamp - job.startTimestamp) * 1000)
        : job.frames.length * 100;
      if (job.startTimestamp === 0 && p.metadata?.timestamp) job.startTimestamp = p.metadata.timestamp;
      const buf = Buffer.from(p.data, 'base64');
      job.frames.push({
        data: new Uint8Array(buf),
        timestampMs: rel,
        ...(p.metadata?.deviceWidth && p.metadata?.deviceHeight
          ? { width: p.metadata.deviceWidth, height: p.metadata.deviceHeight }
          : {})
      });
      job.frameBytes += buf.byteLength;
      job.frameCount = job.frames.length;
      job.updatedAt = Date.now();
      void wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      const stop = shouldStopCapturing(job.frames.length, job.frameBytes, Date.now() - job.startedAt);
      if (stop) void this.stop(id, `auto:${stop}`).catch(() => {});
    };
    wc.debugger.on('message', onMessage as never);
    (job as RecordingJob & { __off?: () => void }).__off = (): void => {
      try { wc.debugger.removeListener('message', onMessage as never); } catch { /* 已销毁 */ }
    };
    try {
      await wc.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
      this.setThrottle(tabId, true);
      job.status = 'capturing';
      job.phase = 'capturing';
      job.updatedAt = Date.now();
    } catch (err) {
      this.cleanupCapture(job);
      this.setThrottle(tabId, false);
      job.status = 'failed';
      job.error = (err as Error).message;
      job.updatedAt = Date.now();
      throw err;
    }
    return this.view(job);
  }

  /** 停止并合成：帧交 renderer 编码 → mux → 落盘。reason 记录触发来源（不外显）。 */
  async stop(id: string, reason = 'manual'): Promise<RecordingJobView> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(t('录制任务不存在：{{id}}', { id }));
    if (job.status !== 'capturing' && job.status !== 'preparing') return this.view(job);
    this.cleanupCapture(job);
    const wc = this.getGuest(job.tabId);
    if (wc && !wc.isDestroyed()) {
      void wc.debugger.sendCommand('Page.stopScreencast').catch(() => {});
    }
    job.status = 'finalizing';
    job.phase = 'finalizing';
    job.updatedAt = Date.now();
    if (!job.frames.length) {
      job.status = 'failed';
      job.error = t('录制期间未收到任何帧（页面可能处于隐藏状态）');
      job.updatedAt = Date.now();
      this.scheduleTtlCleanup(id);
      return this.view(job);
    }
    try {
      const chunks = await this.encodeFrames(job.frames);
      const width = job.frames[0]?.width ?? 0;
      const height = job.frames[0]?.height ?? 0;
      const webm = muxWebm(chunks.map((c) => ({
        data: new Uint8Array(Buffer.from(c.dataBase64, 'base64')),
        timestampMs: c.timestampMs,
        width, height
      })));
      fs.mkdirSync(this.capturesDir, { recursive: true });
      const file = path.join(this.capturesDir, `rec-${Date.now()}-${randomUUID().slice(0, 6)}.webm`);
      fs.writeFileSync(file, Buffer.from(webm));
      // X3-F05：录屏产物与截图共目录，写路径按 keep-newest 回收（同 turnShotCapture）
      pruneBrowserCaptures(this.capturesDir);
      job.status = 'completed';
      job.updatedAt = Date.now();
      job.artifact = {
        path: file,
        mimeType: 'video/webm',
        width, height,
        durationMs: job.frames[job.frames.length - 1]?.timestampMs ?? 0,
        frameCount: chunks.length
      };
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      job.updatedAt = Date.now();
    }
    job.frames = [];
    job.frameBytes = 0;
    this.scheduleTtlCleanup(id);
    void reason;
    return this.view(job);
  }

  /** 取消：丢弃帧，不落盘。 */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'capturing' || job.status === 'preparing') {
      this.cleanupCapture(job);
      const wc = this.getGuest(job.tabId);
      if (wc && !wc.isDestroyed()) {
        void wc.debugger.sendCommand('Page.stopScreencast').catch(() => {});
      }
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return true;
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.updatedAt = Date.now();
    job.frames = [];
    job.frameBytes = 0;
    this.scheduleTtlCleanup(id);
    return true;
  }

  /** 目标 tab 关闭/换代：终止采集（保留已收帧走 stop 合成或直接取消由调用方定） */
  abortForTab(tabId: string, mode: 'cancel' | 'finalize'): void {
    const id = this.capturingByTab.get(tabId);
    if (!id) return;
    if (mode === 'cancel') this.cancel(id);
    else void this.stop(id, 'tab-gone').catch(() => {});
  }

  job(id: string): RecordingJobView | null {
    const job = this.jobs.get(id);
    return job ? this.view(job) : null;
  }

  /** Start a deterministic render batch without requiring foreground presentation. */
  async startRender(
    tabId: string,
    options: {
      times: number[];
      width: number;
      height: number;
      restoreViewport?: () => Promise<void> | void;
      owner?: { workspaceId?: string; sessionId?: string };
      signal?: AbortSignal;
    }
  ): Promise<RenderJobView> {
    const captureId = this.capturingByTab.get(tabId);
    if (captureId) {
      const capture = this.jobs.get(captureId);
      if (capture && (capture.status === 'capturing' || capture.status === 'preparing' || capture.status === 'finalizing')) {
        throw new Error(t('该标签已有进行中的录制：{{id}}', { id: captureId }));
      }
    }
    const existing = this.renderingByTab.get(tabId);
    if (existing) {
      const running = this.renderJobs.get(existing);
      if (running && (running.status === 'preparing' || running.status === 'rendering' || running.status === 'finalizing')) {
        throw new Error(t('该标签已有进行中的确定性渲染：{{id}}', { id: existing }));
      }
    }
    const wc = this.getGuest(tabId);
    if (!wc) throw new Error(t('浏览器标签尚未挂载，稍后重试'));
    if (!wc.debugger.isAttached()) throw new Error(t('浏览器调试通道未就绪，稍后重试'));
    const normalizedTimes = normalizeRenderTimes(options.times);
    const id = `render${++this.renderSeq}-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const job: RenderJob = {
      id,
      tabId,
      status: 'preparing',
      phase: 'preparing',
      startedAt: now,
      updatedAt: now,
      width: Math.max(1, Math.floor(options.width)),
      height: Math.max(1, Math.floor(options.height)),
      totalFrames: normalizedTimes.length,
      frameCount: 0,
      ...(options.owner?.workspaceId ? { ownerWorkspaceId: options.owner.workspaceId } : {}),
      ...(options.owner?.sessionId ? { ownerSessionId: options.owner.sessionId } : {}),
      times: normalizedTimes,
      frames: [],
      frameBytes: 0,
      cancelController: new AbortController(),
      ...(options.restoreViewport ? { restoreViewport: options.restoreViewport } : {})
    };
    this.renderJobs.set(id, job);
    this.renderingByTab.set(tabId, id);
    if (options.signal) {
      if (options.signal.aborted) job.cancelController.abort();
      else options.signal.addEventListener('abort', () => job.cancelController.abort(), { once: true });
    }
    void this.runRender(job).catch(error => this.failRender(job, error));
    return this.renderView(job);
  }

  async validateRender(tabId: string, signal?: AbortSignal, options?: { times?: number[] }): Promise<{ frames: Array<{ timeMs: number; consistent: boolean; bytes: number }> }> {
    const wc = this.getGuest(tabId);
    if (!wc) throw new Error(t('浏览器标签尚未挂载，稍后重试'));
    if (wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error(t('浏览器页面已关闭或调试通道未就绪'));
    const response = await withDebuggerTimeout(
      wc.debugger.sendCommand('Runtime.evaluate', {
        expression: `typeof (globalThis.window && globalThis.window.renderAt) === 'function'`,
        returnByValue: true,
        userGesture: false
      }),
      RENDER_COMMAND_TIMEOUT_MS,
      signal ?? new AbortController().signal
    );
    if (response?.exceptionDetails || response?.result?.value !== true) {
      throw new Error('window.renderAt(t) is not defined');
    }
    const frames: Array<{ timeMs: number; consistent: boolean; bytes: number }> = [];
    for (const timeMs of options?.times ?? []) {
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_RENDER_DURATION_MS) throw new Error('关键帧时间超出渲染上限');
      await this.renderAt(wc, timeMs / 1000, signal ?? new AbortController().signal);
      const first = await this.captureRenderFrame(wc, signal ?? new AbortController().signal);
      await this.renderAt(wc, timeMs / 1000, signal ?? new AbortController().signal);
      const second = await this.captureRenderFrame(wc, signal ?? new AbortController().signal);
      const consistent = first === second;
      frames.push({ timeMs, consistent, bytes: Buffer.byteLength(first, 'base64') });
      if (!consistent) throw new Error(`关键帧 ${timeMs}ms 两次渲染结果不一致`);
    }
    return { frames };
  }

  renderJob(id: string, owner?: { workspaceId?: string; sessionId?: string }): RenderJobView | null {
    const job = this.renderJobs.get(id);
    if (job && owner && job.ownerWorkspaceId && job.ownerWorkspaceId !== owner.workspaceId) return null;
    return job ? this.renderView(job) : null;
  }

  cancelRender(id: string, owner?: { workspaceId?: string; sessionId?: string }): boolean {
    const job = this.renderJobs.get(id);
    if (!job) return false;
    if (owner && job.ownerWorkspaceId && job.ownerWorkspaceId !== owner.workspaceId) return false;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return true;
    job.cancelController.abort();
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.updatedAt = Date.now();
    job.error = '确定性渲染已取消';
    job.failure = { stage: 'cancelled', frameIndex: job.frameCount, timeMs: job.currentTimeMs, message: job.error, nextStep: '重新提交一个新的渲染任务' };
    job.frames = [];
    job.frameBytes = 0;
    this.cleanupRender(job);
    this.scheduleRenderTtlCleanup(id);
    return true;
  }

  /** Target tab closed/replaced while deterministic rendering is in flight. */
  abortRenderForTab(tabId: string): void {
    const id = this.renderingByTab.get(tabId);
    if (id) this.cancelRender(id);
  }

  stopAll(finalize: boolean): void {
    for (const id of [...this.capturingByTab.values()]) {
      if (finalize) void this.stop(id, 'app-quit').catch(() => {});
      else this.cancel(id);
    }
    for (const id of [...this.renderingByTab.values()]) this.cancelRender(id);
  }

  private cleanupCapture(job: RecordingJob): void {
    if (this.capturingByTab.get(job.tabId) === job.id) {
      this.capturingByTab.delete(job.tabId);
      this.setThrottle(job.tabId, false);
    }
    (job as RecordingJob & { __off?: () => void }).__off?.();
  }

  private scheduleTtlCleanup(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.cleanupTimer) return;
    job.cleanupTimer = setTimeout(() => {
      this.jobs.delete(id);
    }, JOB_TTL_MS);
    job.cleanupTimer.unref?.();
  }

  private scheduleRenderTtlCleanup(id: string): void {
    const job = this.renderJobs.get(id);
    if (!job || job.cleanupTimer) return;
    job.cleanupTimer = setTimeout(() => this.renderJobs.delete(id), JOB_TTL_MS);
    job.cleanupTimer.unref?.();
  }

  private view(job: RecordingJob): RecordingJobView {
    const { frames: _f, frameBytes: _b, startTimestamp: _s, encodeError: _e, cleanupTimer: _c, ...rest } = job;
    return { ...rest, frameCount: job.frameCount };
  }

  private renderView(job: RenderJob): RenderJobView {
    const { times: _t, frames: _f, frameBytes: _b, cancelController: _c, restoreViewport: _r, cleanupTimer: _timer, ownerWorkspaceId: _ow, ownerSessionId: _os, ...rest } = job;
    return { ...rest, frameCount: job.frameCount };
  }

  private cleanupRender(job: RenderJob): void {
    if (this.renderingByTab.get(job.tabId) === job.id) {
      this.renderingByTab.delete(job.tabId);
      this.setThrottle(job.tabId, false);
    }
    try {
      const restore = job.restoreViewport;
      job.restoreViewport = undefined;
      if (restore) void Promise.resolve(restore()).catch(() => {});
    } catch {
      /* viewport restoration is best effort after a closed/replaced guest */
    }
  }

  private failRender(job: RenderJob, error: unknown): void {
    if (job.status === 'cancelled') return;
    const message = error instanceof Error ? error.message : String(error);
    const stage = job.phase;
    job.status = 'failed';
    job.phase = 'failed';
    job.error = message;
    job.failure = { stage, frameIndex: job.frameCount, timeMs: job.currentTimeMs, message, nextStep: '检查入口文件、renderAt(t) 和项目资源后重试' };
    job.updatedAt = Date.now();
    job.frames = [];
    job.frameBytes = 0;
    this.cleanupRender(job);
    this.scheduleRenderTtlCleanup(job.id);
  }

  private async runRender(job: RenderJob): Promise<void> {
    this.setThrottle(job.tabId, true);
    job.status = 'rendering';
    job.phase = 'rendering';
    job.updatedAt = Date.now();
    const wc = this.getGuest(job.tabId);
    if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error(t('浏览器页面已关闭或调试通道未就绪'));
    for (const timeMs of job.times) {
      if (this.renderCancelled(job)) {
        this.cancelRender(job.id);
        return;
      }
      if (this.getGuest(job.tabId) !== wc || wc.isDestroyed()) throw new Error(t('浏览器页面已关闭或换代'));
      job.currentTimeMs = timeMs;
      // The render contract is expressed in seconds while the job scheduler
      // stores milliseconds for timestamps and progress. Convert exactly once
      // at the page boundary so a 100 ms frame calls renderAt(0.1).
      await this.renderAt(wc, timeMs / 1000, job.cancelController.signal);
      if (this.renderCancelled(job)) {
        this.cancelRender(job.id);
        return;
      }
      const screenshot = await this.captureRenderFrame(wc, job.cancelController.signal);
      if (this.renderCancelled(job)) {
        this.cancelRender(job.id);
        return;
      }
      const data = Buffer.from(screenshot, 'base64');
      job.frames.push({ data: new Uint8Array(data), timestampMs: timeMs, width: job.width, height: job.height });
      job.frameBytes += data.byteLength;
      job.frameCount = job.frames.length;
      job.updatedAt = Date.now();
      if (job.frameBytes > MAX_FRAME_BYTES) throw new Error(t('确定性渲染帧数据超过上限'));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (this.renderCancelled(job)) {
      this.cancelRender(job.id);
      return;
    }
    job.status = 'finalizing';
    job.phase = 'finalizing';
    job.updatedAt = Date.now();
    try {
      const chunks = await this.encodeFrames(job.frames);
      if (this.renderCancelled(job)) {
        this.cancelRender(job.id);
        return;
      }
      const webm = muxWebm(chunks.map((chunk) => ({
        data: new Uint8Array(Buffer.from(chunk.dataBase64, 'base64')),
        timestampMs: chunk.timestampMs,
        width: job.width,
        height: job.height
      })));
      fs.mkdirSync(this.capturesDir, { recursive: true });
      const file = path.join(this.capturesDir, `render-${Date.now()}-${randomUUID().slice(0, 6)}.webm`);
      fs.writeFileSync(file, Buffer.from(webm));
      pruneBrowserCaptures(this.capturesDir);
      job.status = 'completed';
      job.phase = 'completed';
      job.updatedAt = Date.now();
      job.artifact = {
        path: file,
        mimeType: 'video/webm',
        width: job.width,
        height: job.height,
        durationMs: job.times[job.times.length - 1] ?? 0,
        frameCount: chunks.length
      };
    } finally {
      job.frames = [];
      job.frameBytes = 0;
      this.cleanupRender(job);
      this.scheduleRenderTtlCleanup(job.id);
    }
  }

  private renderCancelled(job: RenderJob): boolean {
    return job.cancelController.signal.aborted || job.status === 'cancelled';
  }

  private async renderAt(wc: WebContents, timeSeconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const expression = `(async () => {
      const fn = globalThis.window && globalThis.window.renderAt;
      if (typeof fn !== 'function') return { ok: false, error: 'window.renderAt(t) is not defined' };
      await fn(${JSON.stringify(timeSeconds)});
      return { ok: true };
    })()`;
    const response = await withDebuggerTimeout(
      wc.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false }),
      RENDER_COMMAND_TIMEOUT_MS,
      signal
    );
    if (response?.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderAt failed';
      throw new Error(description);
    }
    const value = response?.result?.value as { ok?: boolean; error?: string } | undefined;
    if (!value?.ok) throw new Error(value?.error || 'window.renderAt(t) failed');
  }

  private async captureRenderFrame(wc: WebContents, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const response = await withDebuggerTimeout(
      wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true, captureBeyondViewport: false }),
      RENDER_COMMAND_TIMEOUT_MS,
      signal
    );
    if (!response || typeof response.data !== 'string' || !response.data) throw new Error('Page.captureScreenshot returned no frame');
    return response.data;
  }

  /** 帧批量发主窗口 renderer 编码（WebCodecs 在 renderer 可用；data: 页不可用——主窗口是 file://） */
  private async encodeFrames(frames: ScreencastFrame[]): Promise<RecordingEncodeChunk[]> {
    const win = this.getWindow();
    if (!win || win.webContents.isDestroyed()) throw new Error(t('浏览器宿主窗口不可用'));
    const BATCH = 20;
    const chunks: RecordingEncodeChunk[] = [];
    const width = frames[0]?.width ?? 0;
    const height = frames[0]?.height ?? 0;
    for (let i = 0; i < frames.length; i += BATCH) {
      const batch = frames.slice(i, i + BATCH).map((f) => ({
        dataBase64: Buffer.from(f.data).toString('base64'),
        timestampMs: f.timestampMs
      }));
      const result = await win.webContents.executeJavaScript(
        ENCODE_FRAMES_SCRIPT_FN + `(${JSON.stringify({ frames: batch, width, height })})`
      ).catch((err: Error) => { throw new Error(t('录屏编码失败：{{message}}', { message: err.message })); });
      if (!result?.ok || !Array.isArray(result.chunks)) {
        throw new Error(t('录屏编码失败：{{message}}', { message: result?.error ?? 'unknown' }));
      }
      for (const c of result.chunks as Array<{ data: string; ts: number; key: boolean }>) {
        chunks.push({ dataBase64: c.data, timestampMs: c.ts, key: !!c.key });
      }
    }
    return chunks;
  }
}
