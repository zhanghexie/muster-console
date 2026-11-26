/**
 * 纯浏览器环境下的 window.api 替身（无 Electron preload 时安装）。
 *
 * 桌面壳里 preload 经 contextBridge 注入 window.api（ipcRenderer invoke/send/on）；
 * 浏览器打开网页访问网关（src/main/webAccess/server.ts）时没有 preload，这里用
 * 一条 WebSocket 实现同一份调用面：ns.method(...) → invoke 通道 ns:method，
 * 事件 on(channel) 走网关广播。通道名例外与本地特例对照 src/preload/index.ts 逐一核对。
 *
 * 本模块必须在 main.tsx 里第一个 import：ES 求值顺序保证安装先于其余模块体执行
 * （i18n/theme 等都会在启动早期调用 window.api）。
 *
 * 稳定性契约（shared/wsProtocol）：应用层心跳半开检测、可靠 send 重发、
 * last-good 候选地址、token 只认 query/Cookie（不落 localStorage）、事件兴趣过滤。
 */
import { IPC_EVENT_CHANNELS } from '../../shared/ipcEvents';
import { parseSessionStatusPush, type SessionStatusPush } from '../../shared/webPush';
import { packInvokeArgs } from '../../shared/webApiPacking';
import type { WorkspaceFileRef } from '../../shared/types';
import {
  HEARTBEAT_INTERVAL_MS,
  INVOKE_TIMEOUT_MS,
  TOKEN_COOKIE_NAME,
  TOKEN_REJECT_COOLDOWN_MS,
  createCandidateState,
  defaultWebCaps,
  encodeHello,
  encodePing,
  isHalfOpen,
  isReliableSend,
  onConnectFailure,
  onConnectSuccess,
  outboxEnqueue,
  outboxFlush,
  outboxOnDisconnect,
  pickConnectBase,
  resolveWebToken,
  shouldAdoptUrlToken,
  type CandidateState,
  type ClientCaps,
  type OutboxItem
} from '../../shared/wsProtocol';
import { mobileSurfaceLocked } from './mobile/useMobileSurface';
import { markWebGatewayActive } from './webGatewayEnvironment';
export { isWebGateway } from './webGatewayEnvironment';
import { setGatewayStatus } from './webGatewayStatus';
export { getWebGatewayStatus, subscribeWebGatewayStatus, type WebGatewayStatus } from './webGatewayStatus';

const WS_URL_KEY = 'muster.web.wsUrl';
/** 旧版本曾把 token 写进 localStorage；轮换后粘住导致 4001，现只认 query/Cookie */
const LEGACY_TOKEN_KEY = 'muster.web.token';
const GATEWAY_PORT = 7950;

/* ---------- 网关连接状态（手机端 UI 消费；桌面壳未装 shim 时恒「已连接」） ---------- */

let activeSocket: GatewaySocket | null = null;

/** 订阅服务端 session-status 推送（T1.2）：手机前台 toast + needs_you 深链的触发源。
 * 桌面壳（未装 shim）返回 no-op 退订——桌面有自己的 toast 总线，无服务端推送。 */
export function subscribeSessionStatusPush(listener: (p: SessionStatusPush) => void): () => void {
  return activeSocket ? activeSocket.subscribeSessionStatusPush(listener) : () => {};
}

/** invoke 通道名不等于 ns:method 的例外（其余默认 ns:method） */
const CHANNEL_OVERRIDES: Record<string, string> = {
  'sessions.delegate': 'tasks:delegate',
  'agentSession.historyRange': 'agentSession:getHistoryRange',
  'agentSession.listCodexModels': 'codex:listModels',
  'workspaces.listFiles': 'workspace:listFiles',
  'fs.listDirRef': 'fs:listDir',
  'fs.listTreeDirRef': 'fs:listTreeDir',
  'fs.readTextRef': 'fs:readText',
  'fs.removeRef': 'fs:remove',
  'fs.statRef': 'fs:stat',
  'app.bootWait': 'app:boot:wait',
  'app.logDir': 'app:log-dir',
  'app.reportRendererError': 'app:report-renderer-error',
  'usage.llmCall': 'usage:llm-call',
  'extensionSurface.openExtension': 'extensionSurface:open',
  'extensionSurface.reloadExtension': 'extensionSurface:reload',
  'extensionSurface.closeExtension': 'extensionSurface:close',
  'workbench.panelAppearance': 'workbench:panelAppearance',
  'workbench.panelPlacement': 'workbench:panelPlacement',
  'workbench.navigation': 'workbench:navigation',
  'workbench.saveNavigation': 'workbench:saveNavigation'
};

type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  channel: string;
  timer: number;
};

function clearTokenCookie(): void {
  try {
    document.cookie = `${TOKEN_COOKIE_NAME}=; Path=/; SameSite=Lax; max-age=0`;
  } catch {
    /* ignore */
  }
}

function writeTokenCookie(token: string): void {
  try {
    // 媒体（<img>/预览）请求带不了 header，用 Cookie 鉴权（SameSite=Lax 防跨站子资源）
    document.cookie = `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; max-age=86400`;
  } catch {
    /* ignore */
  }
}

function readWsOverride(): string {
  try {
    const q = new URLSearchParams(location.search).get('ws');
    if (q) {
      localStorage.setItem(WS_URL_KEY, q);
      return q;
    }
    return localStorage.getItem(WS_URL_KEY) ?? '';
  } catch {
    return '';
  }
}

/* ---------- 网关 socket：invoke 关联 / 事件分发 / 断线重连 ---------- */

export class GatewaySocket {
  // 单元测试（test/unit/web-gateway-socket.spec.ts）直接构造本类验证连接状态机；
  // 模块顶层的 installWebApiShimIfBrowser 由 'api' in window 守卫，测试预设后零副作用
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private outbox: OutboxItem[] = [];
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** 服务端主动推送帧（t:'push'）的订阅者；与 IPC 事件自名单分流（推送不是事件中继） */
  private pushListeners = new Set<(p: SessionStatusPush) => void>();
  private cand: CandidateState;
  private retry = 0;
  private retryTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastRxAt = 0;
  private caps: ClientCaps;
  private token: string;

  constructor(
    token: string,
    wsUrlOverride: string,
    caps: ClientCaps
  ) {
    this.token = token;
    this.caps = caps;
    this.cand = createCandidateState({ override: wsUrlOverride || null, defaults: defaultCandidates() });
    this.bindWake();
    this.connect();
  }

  invoke(channel: string, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`invoke timeout: ${channel}`));
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, channel, timer });
      this.enqueueFrame({ t: 'invoke', id, channel, args: packInvokeArgs(channel, args) }, channel, false);
    });
  }

  /**
   * fire-and-forget（preload 里 ipcRenderer.send 的对应面）。
   * 可靠通道（ui:confirm:/ui:dialog:/terminal:capture:）断线保留、重连重发；
   * 不可靠通道（pty:input 等）断线可丢。
   */
  send(channel: string, args: unknown[]): void {
    this.enqueueFrame({ t: 'send', channel, args }, channel, isReliableSend(channel));
  }

  subscribe(channel: string, listener: (payload: unknown) => void): () => void {
    if (!(IPC_EVENT_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`未知事件频道: ${channel}`);
    }
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** 服务端推送帧订阅（T1.2 session-status）；畸形帧在分发前破 parse 丢弃 */
  subscribeSessionStatusPush(listener: (p: SessionStatusPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => {
      this.pushListeners.delete(listener);
    };
  }

  /** 页面回到前台 / 网络恢复：取消退避并立即重连（手机锁屏回前台主场景） */
  private bindWake(): void {
    const wake = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      this.refreshToken();
      const rs = this.ws?.readyState;
      // OPEN=连接健康；CONNECTING=已有连接在途（此时再 new WebSocket 会造出双活连接：
      // 被弃 socket 的迟到事件走 onclose/onopen 的陈旧守卫，不扰动现役状态机）。
      // 代价：握手挂起期间唤醒不再另建连接，等浏览器握手超时→onclose→重连兜底
      if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
      this.cancelRetry();
      this.connect();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wake();
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', wake);
    }
  }

  /** token 只认 query > Cookie（不落 localStorage）；旧 key 顺手清掉 */
  private refreshToken(): void {
    try {
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      /* ignore */
    }
    const resolved = resolveWebToken(typeof location !== 'undefined' ? location.search : '', document.cookie);
    if (resolved) {
      this.token = resolved;
    }
  }

  private enqueueFrame(payload: Record<string, unknown>, channel: string, reliable: boolean): void {
    const text = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(text);
        return;
      } catch {
        /* 落入 outbox，重连后再送 */
      }
    }
    // 边界：send 成功（浏览器对 OPEN 态只缓冲不抛错）的帧不进 outbox——TCP 恰在其后
    // 半开死亡时该帧丢失，靠心跳半开检测重连兜底，不做服务端 ack 补发（协议预留面）
    this.outbox = outboxEnqueue(this.outbox, { text, reliable, channel });
  }

  private connect(): void {
    if (this.retryTimer !== null) return;
    this.refreshToken();
    if (!this.token) {
      const missingToken = '网页访问：缺少 token / Missing token';
      setGatewayStatus(false, missingToken,
        missingToken + '. Open this page with ?token= (see host userData/web-access.json)');
      // 不永久静默：visibility/online 会再读 Cookie/query；此处排一个低频重试兜底
      if (this.retryTimer === null) {
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, 15_000);
      }
      return;
    }
    const base = pickConnectBase(this.cand);
    if (!base) {
      const noAddress = '网页访问：无可用网关地址 / No gateway address';
      setGatewayStatus(false, noAddress, noAddress);
      return;
    }
    // token 必须进握手 query（网关在升级完成后的连接层校验）；
    // localStorage 只存基址，不落 token
    const url = `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    let opened = false;
    this.ws = ws;
    ws.onopen = () => {
      // 陈旧连接（已被更新的 connect() 替换）：迟到 open 直接关掉，不抢状态机
      if (this.ws !== ws) {
        try {
          ws.close();
        } catch {
          /* 已关 */
        }
        return;
      }
      // 成功打开即取消遗留的重连定时器，否则到点后会把刚建好的连接轮换掉再连一条
      this.cancelRetry();
      opened = true;
      this.retry = 0;
      this.cand = onConnectSuccess(this.cand, base);
      this.lastRxAt = Date.now();
      setGatewayStatus(true, '');
      try {
        localStorage.setItem(WS_URL_KEY, base);
      } catch {
        /* ignore */
      }
      writeTokenCookie(this.token);
      // 兴趣声明：手机丢终端/流式热区，弱网防洪泛；桌面全量
      try {
        ws.send(encodeHello(this.caps));
      } catch {
        /* 半开，onclose 收拾 */
      }
      this.startHeartbeat();
      this.flushOutbox(ws);
    };
    ws.onmessage = (ev) => {
      this.lastRxAt = Date.now();
      this.handleMessage(String(ev.data));
    };
    ws.onclose = (ev) => {
      // 陈旧连接的迟到事件：现役连接的 pending/outbox/心跳/重连自有一套状态，不得扰动
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      this.failPending(new Error(`网页网关连接已断开（${ev.code}）`));
      // 可靠 send 保留；不可靠丢弃
      this.outbox = outboxOnDisconnect(this.outbox);
      if (ev.code === 4001) {
        clearTokenCookie();
        // 用户可能已用带新 token 的链接刷新/打开了本页 → 立即换 token 重试，不空等
        if (shouldAdoptUrlToken(this.token, location.search)) {
          this.refreshToken();
          this.connect();
          return;
        }
        const rejected = '网页访问：token 被拒绝，请用新链接或扫码打开 / Token rejected. Open with a new link or QR';
        setGatewayStatus(false, rejected, rejected);
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, TOKEN_REJECT_COOLDOWN_MS);
        return;
      }
      this.scheduleReconnect(!opened);
    };
    ws.onerror = () => {
      /* onclose 会跟着触发，统一在那儿处理 */
    };
  }

  private flushOutbox(ws: WebSocket): void {
    const { remaining, giveUp } = outboxFlush(this.outbox, (text) => {
      ws.send(text);
    });
    this.outbox = remaining;
    for (const item of giveUp) {
      console.error('[web-shim] reliable send dropped after retries', item.channel);
      setGatewayStatus(true, `网页访问：回执未能送达 / Reliable send failed: ${item.channel}`);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (isHalfOpen(this.lastRxAt, Date.now())) {
        try {
          this.ws.close(4000, 'heartbeat timeout');
        } catch {
          /* onclose 仍会来 */
        }
        return;
      }
      try {
        this.ws.send(encodePing());
      } catch {
        /* onclose 收拾 */
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 连不上换候选；last-good 优先（见 shared/wsProtocol.onConnectFailure）；指数退避 */
  private scheduleReconnect(handshakeFailed: boolean): void {
    if (this.retryTimer !== null) return;
    this.retry++;
    const delay = Math.min(1000 * 2 ** Math.min(this.retry, 4), 15_000) + Math.random() * 300;
    setGatewayStatus(false, `网页访问：正在连接网关… / Connecting… (${this.cand.idx + 1}/${this.cand.candidates.length})`);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      // Retry the last working endpoint after a disconnect. Rotate only if its handshake fails.
      if (handshakeFailed) this.cand = onConnectFailure(this.cand, defaultCandidates());
      this.connect();
    }, delay);
  }

  private failPending(err: Error): void {
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(text: string): void {
    let msg: {
      t?: string;
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
      channel?: string;
      payload?: unknown;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'pong') return;
    if (msg.t === 'result' && typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      window.clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error ?? 'invoke failed'));
      return;
    }
    if (msg.t === 'push') {
      const push = parseSessionStatusPush(msg);
      if (!push) return;
      for (const fn of this.pushListeners) {
        try {
          fn(push);
        } catch (err) {
          console.error('[web-shim] push listener', err);
        }
      }
      return;
    }
    if (msg.t === 'event' && typeof msg.channel === 'string') {
      const set = this.listeners.get(msg.channel);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(msg.payload);
        } catch (err) {
          console.error(`[web-shim] listener ${msg.channel}`, err);
        }
      }
    }
  }
}

/**
 * 默认候选：页面由网关服务（:7950）时同源直达；否则（vite dev 5188 等）先试
 * 同源再试同主机 7950。连上的地址由 GatewaySocket 写回 localStorage。
 */
function defaultCandidates(): string[] {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sameOrigin = `${proto}://${location.host}/ws`;
  if (location.port === String(GATEWAY_PORT)) return [sameOrigin];
  return [sameOrigin, `${proto}://${location.hostname}:${GATEWAY_PORT}/ws`];
}

function makeNamespace(name: string, sock: GatewaySocket): unknown {
  // 浏览器无等价物的本地特例 + 走 ipcRenderer.send 语义的通道（preload 用
  // ipcMain.on 注册，不在 handle 注册表里，invoke 会被网关拒绝——见 server SEND_ALLOW）
  let specials: Record<string, (...args: unknown[]) => unknown> | undefined;
  if (name === 'shell') {
    specials = {
      pathForFile: (file: unknown) => (file as File & { path?: string })?.path ?? '',
      clipboardFiles: () => Promise.resolve([]),
      startPathDrag: (..._paths: unknown[]) => {}
    };
  } else if (name === 'terminal') {
    specials = {
      // 动态回执：可靠 send，断线重连重发
      replyCapture: (requestId: unknown, payload: unknown) =>
        sock.send(`terminal:capture:${String(requestId)}`, [payload])
    };
  } else if (name === 'pty') {
    specials = {
      input: (...args: unknown[]) => sock.send('pty:input', args),
      resize: (...args: unknown[]) => sock.send('pty:resize', args)
    };
  } else if (name === 'sessions') {
    specials = { touchUsed: (...args: unknown[]) => sock.send('sessions:touch-used', args) };
  } else if (name === 'fs') {
    // Ref 写入口比旧位置参数少一个 filePath，保持与桌面 preload 一致。
    specials = { writeTextRef: (ref, content, expectedMtimeMs) =>
      sock.invoke('fs:writeText', [ref, (ref as WorkspaceFileRef).relativePath, content, expectedMtimeMs ?? null]) };
  } else if (name === 'git') {
    specials = { invokeScoped: (scope, method, ...args) => sock.invoke('git:invokeScoped', [scope, method, args]) };
  }
  return new Proxy(
    {},
    {
      get(_t, method) {
        if (specials && typeof method === 'string' && method in specials) {
          return specials[method];
        }
        const key = `${name}.${String(method)}`;
        const channel = CHANNEL_OVERRIDES[key] ?? `${name}:${String(method)}`;
        return (...args: unknown[]) => sock.invoke(channel, args);
      }
    }
  );
}

export function installWebApiShimIfBrowser(): void {
  const w = window as unknown as Record<string, unknown>;
  if (typeof window === 'undefined' || 'api' in w) return;
  markWebGatewayActive();
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* ignore */
  }
  const token = resolveWebToken(location.search, document.cookie);
  // 手机：terminal/stream=false → 服务端丢 pty:data 与 agent:token/thinking（弱网防洪泛）
  const caps = defaultWebCaps({ mobile: mobileSurfaceLocked() });
  const sock = new GatewaySocket(token, readWsOverride(), caps);
  activeSocket = sock;
  const nsCache = new Map<string, unknown>();
  const rootSpecials: Record<string, unknown> = {
    on: (channel: string, listener: (payload: unknown) => void) => sock.subscribe(channel, listener),
    confirmRespond: (
      requestId: string,
      confirmed: boolean,
      cancelledBy?: string,
      decision?: { kind?: string; scope?: string; freeText?: string }
    ) =>
      sock.send(`ui:confirm:${requestId}`, [
        {
          confirmed,
          cancelledBy,
          ...(decision?.kind ? { kind: decision.kind } : {}),
          ...(decision?.scope ? { scope: decision.scope } : {}),
          ...(decision?.freeText ? { freeText: decision.freeText } : {})
        }
      ]),
    dialogRespond: (requestId: string, response: unknown) =>
      sock.send(`ui:dialog:${requestId}`, [response])
  };
  const api = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'string' && prop in rootSpecials) return rootSpecials[prop];
        let ns = nsCache.get(prop as string);
        if (!ns) {
          ns = makeNamespace(String(prop), sock);
          nsCache.set(prop as string, ns);
        }
        return ns;
      }
    }
  );
  w.api = api as Window['api'];
}

installWebApiShimIfBrowser();
