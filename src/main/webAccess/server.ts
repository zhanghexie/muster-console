import { app, ipcMain } from 'electron';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { AcceptedWork } from '../net/acceptedWork';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { errorMessage } from '../../shared/errors';
import { hasIpcChannel, invokeIpcChannel } from '../ipc/handle';
import { isWebIpcAllowed } from '../ipc/accessPolicy';
import { handleExternalFileRequest, handleWorkspaceMediaRequest } from '../workspaceFsProtocol';
import { workspacePreviewsFor } from '../workspacePreview';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import type { AppContext } from '../context';
import { notifyTriggerLabel, type NotifyBus } from '../notify/bus';
import { formatNotifyText } from '../../shared/types';
import type { SessionStatusPush } from '../../shared/webPush';
import { onWebEventBroadcast } from './relay';
import { getResolvedLocale, t } from '../../shared/i18n';
import { HOOK_PATH_PREFIX, handleHookRequest, isHookPath, type HookRouteDeps } from './hookRoute';
import { parseGitHubPrWebhook } from '../../shared/webhookPayload';
import type { WebAccessHookInfo, WebAccessStatusBase } from '../../shared/webAccess';
import {
  isValidTokenShape,
  newToken,
  readWebAccessInfo,
  saveWebAccessInfo,
  type PersistedRaw,
  type SaveResult,
  type WebAccessInfo
} from './credentials';
import {
  SERVER_HEARTBEAT_INTERVAL_MS,
  capsDropList,
  encodePong,
  mergeDropList,
  parseClientFrame,
  shouldDropChannel
} from '../../shared/wsProtocol';
import { DEFAULT_WEB_ACCESS_PORT, resolvePreferredPort } from '../../shared/listenPort';
import { listenPreferred } from '../net/bindListen';
import { ensureInstanceId, loadInstancePorts, saveInstancePorts } from '../instance/portsFile';
import { MUSTER_APP_SCHEME, MUSTER_EXT_SCHEME, MUSTER_WS_SCHEME } from '../../shared/protocolSchemes';

const DEFAULT_PORT = DEFAULT_WEB_ACCESS_PORT;
const WS_PATH = '/ws';
const MAX_WS_PAYLOAD = 64 * 1024 * 1024;
/** 鉴权通过后由 shim 写入的 Cookie（img/媒体请求不带 query token 时走它） */
const COOKIE_NAME = 'ma_web_token';

/**
 * 允许 web 客户端 send（fire-and-forget）的通道：preload 里走 ipcRenderer.send
 * 的那几条（终端输入/缩放、活跃心跳、动态回执回执通道）。
 */
const SEND_ALLOW = new Set(['pty:input', 'pty:resize', 'sessions:touch-used']);
const SEND_PREFIX_ALLOW = ['ui:confirm:', 'ui:dialog:', 'terminal:capture:'];

const STATIC_ROOT = path.resolve(__dirname, '../renderer');
const EXTENSION_VIEW_OBJECT_CHANNELS = new Set(['extensionSurface:call', 'workbench:panelAppearance', 'workbench:panelPlacement']);
const EXTENSION_VIEW_TOKEN_CHANNELS = new Set(['extensionSurface:reload', 'extensionSurface:close']);
const EXTENSION_VIEW_EVENTS = new Set(['extensionSurface:event', 'workbench:extensionInvalidated', 'workbench:panelReturned', 'workbench:panelError']);

function extensionViewToken(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'token' in value && typeof value.token === 'string') return value.token;
  return undefined;
}

function tokenFilePath(): string {
  return userDataStorage(app.getPath('userData')).file('web-access');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function extractProvidedToken(req: http.IncomingMessage, url: URL): string | null {
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === COOKIE_NAME) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  return null;
}

function isAuthorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const provided = extractProvidedToken(req, url);
  return !!provided && safeEqual(provided, token);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** out/renderer 未构建时（dev 直接拉起主进程）给一个可读的引导页 */
function sendDevFallback(res: http.ServerResponse, token: string, port: number): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="${getResolvedLocale()}"><meta charset="utf-8">
<title>${t('Muster Console 网页访问')}</title>
<body style="font-family:system-ui;max-width:640px;margin:80px auto;line-height:1.7">
<h2>${t('网页访问网关已启动（端口 {{port}}）', { port })}</h2>
<p>${t('当前没有构建产物 out/renderer。两种用法：')}</p>
<ol>
<li>${t('<b>生产页面</b>：先 <code>npm run build</code>，然后刷新本页，用带 token 的地址访问。')}</li>
<li>${t('<b>开发页面</b>：保持 <code>npm run dev</code> 运行，浏览器打开 vite 地址（默认 <code>http://&lt;本机IP&gt;:5188/?token={{token}}</code>），渲染层会自动连到本网关。', { token })}</li>
</ol>
<p style="color:#888">${t('token 同时落在 userData/web-access.json。')}</p>
</body></html>`);
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad Request');
    return true;
  }
  const joined = path.resolve(STATIC_ROOT, '.' + (/^[\\/]/.test(decoded) ? decoded : `/${decoded}`));
  if (joined !== STATIC_ROOT && !joined.startsWith(STATIC_ROOT + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  let file = joined;
  try {
    const st = await fsp.stat(file).catch(() => null);
    if (!st) {
      if (decoded === '/' || decoded === '/index.html') {
        return false; // 交给调用方走 dev fallback
      }
      sendText(res, 404, 'Not Found');
      return true;
    }
    if (st.isDirectory()) file = path.join(file, 'index.html');
    const body = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // 资产带内容 hash，可长缓存；入口 html 必须 no-cache 保证升级即生效
      'Cache-Control': decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    res.end(body);
    return true;
  } catch (err) {
    console.error('[web-access] static', decoded, err);
    sendText(res, 500, 'Internal Error');
    return true;
  }
}

/** 把 HTTP /media 路径原样拼回自定义协议 URL（保留百分号编码，解析复用协议侧逻辑） */
function mediaSchemeUrl(pathname: string, rawNoQuery: string, search = ''): { schemeUrl: string; ws: boolean } | null {
  if (pathname.startsWith('/media/ws/')) {
    return { schemeUrl: `${MUSTER_WS_SCHEME}://${rawNoQuery.slice('/media/ws/'.length)}${search}`, ws: true };
  }
  if (pathname.startsWith('/media/ext/')) {
    return { schemeUrl: `${MUSTER_EXT_SCHEME}://f/${rawNoQuery.slice('/media/ext/'.length)}`, ws: false };
  }
  return null;
}

async function sendResponse(resp: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(resp.status, headers);
  if (!resp.body) {
    res.end();
    return;
  }
  // 流式转发（Range 请求的大媒体不整读进内存）
  const stream = Readable.fromWeb(resp.body as unknown as import('node:stream/web').ReadableStream);
  stream.on('error', (err) => {
    console.error('[web-access] media stream', err);
    res.destroy();
  });
  stream.pipe(res);
}

/** 替身 Request：serveWorkspaceFile 只读 Range header（视频回放依赖 206） */
function gatewayRequest(rangeHeader: string | undefined): Request {
  const headers = new Headers();
  if (rangeHeader) headers.set('range', rangeHeader);
  return new Request('http://muster.local/', { headers });
}

type ClientMeta = {
  /** Host-generated ownership for open file views; renewed on each connection. */
  ownerId: string;
  /** 协议层心跳：收到 pong/任意帧置 true；扫表时未置则 terminate 僵尸 */
  isAlive: boolean;
  /** 兴趣过滤：null=未声明（全量，向后兼容）；数组=丢弃的事件通道 */
  drop: string[] | null;
  /** hello 里声明的 caps 展开的丢弃列表（filter 未覆盖时用） */
  capsDrop: string[];
  /** Panel tokens opened by this authenticated connection. */
  extensionViews: Set<string>;
};

/** 凭证变更（轮换/设置）结果：持久化失败时 ok=false 且内存/连接保持旧状态 */
export type CredentialChangeResult =
  | { ok: true; status: WebAccessStatusBase }
  | { ok: false; error: string; status: WebAccessStatusBase };

export class WebAccessServer {
  private ctx: AppContext | null = null;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ClientMeta>();
  private extensionViewOwners = new Map<string, WebSocket>();
  private readonly extensionViewClosures = new Set<Promise<void>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private offBroadcast: (() => void) | null = null;
  private offNotifyBus: (() => void) | null = null;
  /** 离线 Web Push 预留位（T1.2 只存不发；将来接 Web Push 协议从这里读） */
  private pushSubscription: unknown;
  private token = '';
  /** T3.2：webhook 触发端点的独立 token（URL 末段） */
  private hookToken = '';
  /** T3.2：GitHub webhook 签名密钥；空串 = 不校验 */
  private hookSecret = '';
  /** 网页访问 token 的生成时刻（落盘 rotatedAt；hook token 轮换不改它） */
  private rotatedAt = '';
  /** 最近一次成功落盘的盘面（未识别字段轮换时原样保留，见 credentials.saveWebAccessInfo） */
  private persistedRaw: PersistedRaw = {};
  private port = DEFAULT_PORT;
  private disabledReason = '';

  /** 设置页「远程连接」展示用状态（同步、随时可查） */
  getStatusInfo(): WebAccessStatusBase {
    return {
      running: !!this.httpServer,
      port: this.port,
      token: this.token,
      urls: this.collectUrls(),
      disabledReason: this.disabledReason,
      hook: this.getHookInfo()
    };
  }

  private getHookInfo(): WebAccessHookInfo {
    return {
      path: this.hookToken ? `${HOOK_PATH_PREFIX}${this.hookToken}` : '',
      urls: this.httpServer && this.hookToken ? this.collectHookUrls() : [],
      secret: this.hookSecret,
      signatureEnabled: !!this.hookSecret
    };
  }

  /** 看板翻转 → 手机表面 WS 推送帧（T1.2）。总线事件只在推送决策通过时发出
   * （翻转/45s 账本/免打扰/hidden 单点裁决见 shared/notifyDecision），这里只做
     通道投递：构造帧并广播给全部已鉴权客户端（手机前台 toast + 深链的触发源）。 */
  bindNotifyBus(bus: NotifyBus): void {
    this.offNotifyBus?.();
    this.offNotifyBus = bus.on((e) => {
      const label = formatNotifyText(e.sessionName, notifyTriggerLabel(e.trigger));
      this.broadcastPush({ type: 'session-status', sessionId: e.sessionId, phase: e.trigger, label });
    });
  }

  /** 离线 Web Push 预留位：仅持久化到 web-access.json，网关不发送（实现时接 Push 协议）。
   * 传 null/undefined = 清除存储位。与轮换同路径：落盘失败保持旧盘面并报错。 */
  setPushSubscription(sub: unknown): CredentialChangeResult {
    const info = { ...this.snapshotInfo(), pushSubscription: sub ?? undefined };
    return this.commitCredential('push 订阅更新', info, { revokeClients: false });
  }

  getPushSubscription(): unknown {
    return this.pushSubscription;
  }

  /** 重新生成 token：持久化成功才发布（内存+器客户端 4001）；失败时旧 token 继续生效
   * 并显式报错——不得一边宣称轮换成功，一边让重启后的旧磁盘凭证复活。
   * 在途 invoke 的取消是独立合同，这里只保证旧连接不能再发起新请求。 */
  rotateToken(): CredentialChangeResult {
    const info = {
      ...this.snapshotInfo(),
      token: newToken(),
      rotatedAt: new Date().toISOString()
    };
    return this.commitCredential('token 轮换', info, { revokeClients: true, printUrls: true });
  }

  /** 重新生成 hook token（旧 hook 地址立即失效；不影响网页访问 token 与已连客户端） */
  rotateHookToken(): CredentialChangeResult {
    const info = { ...this.snapshotInfo(), hookToken: newToken() };
    return this.commitCredential('hook token 轮换', info, {});
  }

  /** 设置/清除 GitHub 签名密钥（空串 = 关闭签名校验）；持久化成功才生效 */
  setHookSecret(secret: string): CredentialChangeResult {
    const info = { ...this.snapshotInfo(), hookSecret: secret.trim() };
    return this.commitCredential('hook 签名密钥设置', info, {});
  }

  /** 当前内存态的凭证快照（persist 入参；未设字段以 undefined 表清除语义） */
  private snapshotInfo(): WebAccessInfo {
    return {
      token: this.token,
      rotatedAt: this.rotatedAt,
      hookToken: this.hookToken,
      hookSecret: this.hookSecret,
      pushSubscription: this.pushSubscription
    };
  }

  /** 原子落盘；成功后同步盘面镜像（下次写入从最新盘面 merge 未知字段） */
  private persist(info: WebAccessInfo): SaveResult {
    const res = saveWebAccessInfo(tokenFilePath(), info, this.persistedRaw);
    if (res.ok) this.persistedRaw = res.raw;
    return res;
  }

  /** 凭证变更统一入口：准备新值 → 原子持久化 → 成功才发布内存态/撤销连接。
   * 失败策略单点：保留旧状态并返回失败，不路连接、不静默、不部分应用。 */
  private commitCredential(
    label: string,
    info: WebAccessInfo,
    opts: { revokeClients?: boolean; printUrls?: boolean }
  ): CredentialChangeResult {
    const saved = this.persist(info);
    if (!saved.ok) {
      console.error(`[web-access] ${label}落盘失败，保持旧凭证:`, saved.error);
      return {
        ok: false,
        error: t('凭证文件写入失败，已保留原凭证（{{detail}}）', { detail: saved.error }),
        status: this.getStatusInfo()
      };
    }
    this.token = info.token;
    this.rotatedAt = info.rotatedAt;
    this.hookToken = info.hookToken ?? '';
    this.hookSecret = info.hookSecret ?? '';
    this.pushSubscription = info.pushSubscription;
    if (opts.revokeClients) this.revokeClients('token rotated');
    if (opts.printUrls) this.printUrls();
    return { ok: true, status: this.getStatusInfo() };
  }

  /** 立即吊销全部已连客户端的请求资格（新 invoke/send 即刻失败），再优雅 close 4001。
   * close 是异步握手，不能等它完成才撤销；在途请求的撤回不属于本合同。 */
  private revokeClients(reason: string): void {
    for (const ws of [...this.clients.keys()]) {
      this.releaseClient(ws);
      try {
        ws.close(4001, reason);
      } catch {
        /* already gone */
      }
    }
  }

  /** 启动时载入持久信息：token/hookToken 缺失或损坏时生成并落盘（重启后网址不变）。
   * 凭证落盘失败 → throw（start 捕获后停用远程服务并展示原因）：网关不得带着
   * 无法持久化的新凭证运行，否则重启后与磁盘状态不可预测地分叉。
   * 读取失败（EACCES/EIO 等）同样 throw 停用，但**不覆盖盘面**：旧 token/hookToken/
   * hookSecret/pushSubscription 原样保留——盘面内容未知时生成新凭证覆盖会丢字段，
   * 且磁盘/权限故障恢复后重启即回到已知旧状态，不会意外轮换。 */
  private loadOrInitInfo(): void {
    const read = readWebAccessInfo(tokenFilePath());
    if (read.kind === 'ok') {
      this.token = read.info.token;
      this.rotatedAt = read.info.rotatedAt || new Date().toISOString();
      this.hookSecret = typeof read.info.hookSecret === 'string' ? read.info.hookSecret : '';
      this.pushSubscription = read.info.pushSubscription;
      this.persistedRaw = read.raw;
      if (isValidTokenShape(read.info.hookToken)) {
        this.hookToken = read.info.hookToken;
        return; // 已有完整信息：复用不重写（rotatedAt 保持真实生成时刻）
      }
      // hook token 缺失/非法（旧版本文件）：补生成并落盘，其余字段原样保留
      this.hookToken = newToken();
    } else if (read.kind === 'read-error') {
      console.error(`[web-access] web-access.json 读取失败（${read.detail}），停用远程访问，盘面保留不改动`);
      throw new Error(
        t('凭证文件读取失败，远程访问停用（{{detail}}）；盘面未改动，请检查磁盘/权限后重启', {
          detail: read.detail
        })
      );
    } else {
      // missing / corrupt：旧内容不可用，生成全新凭证覆盖是唯一安全路径
      const why = read.kind === 'missing' ? '首次启动（文件不存在）' : `文件损坏（${read.detail}）`;
      console.warn(`[web-access] web-access.json ${why}，生成新凭证并落盘`);
      this.token = newToken();
      this.rotatedAt = new Date().toISOString();
      this.hookToken = newToken();
      this.hookSecret = '';
      this.pushSubscription = undefined;
      this.persistedRaw = {};
    }
    const saved = this.persist(this.snapshotInfo());
    if (!saved.ok) {
      throw new Error(t('新凭证落盘失败，远程访问停用待修复（{{detail}}）', { detail: saved.error }));
    }
  }

  /** 可用连接地址：远程可达优先（Tailscale 等组网 100.64/10 > 局域网私网 > 其他 IPv4），
   * 回环垫底——urls[0] 即「推荐地址」（设置页二维码），扫码端是别的设备，
   * 127.0.0.1 只对工作机自己有效。均含 token query。 */
  /** 可用网卡地址（远程可达优先：CGNAT 组网 > 私网 > 其他 IPv4；回环不在列） */
  private collectHosts(): string[] {
    const overlay: string[] = [];
    const lan: string[] = [];
    const other: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const [a, b] = ni.address.split('.').map(Number);
        const isCgnat = a === 100 && b >= 64 && b <= 127; // Tailscale/ZeroTier 常用 CGNAT 段
        const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
        if (isCgnat) overlay.push(ni.address);
        else if (isPrivate) lan.push(ni.address);
        else other.push(ni.address);
      }
    }
    return [...overlay, ...lan, ...other];
  }

  private collectUrls(): string[] {
    if (!this.httpServer) return [];
    const suffix = `:${this.port}/?token=${this.token}`;
    return [...this.collectHosts(), '127.0.0.1'].map((ip) => `http://${ip}${suffix}`);
  }

  /** hook 地址（同网卡优先级；不含网页 token，路径本身即凭证） */
  private collectHookUrls(): string[] {
    const suffix = `:${this.port}${HOOK_PATH_PREFIX}${this.hookToken}`;
    return [...this.collectHosts(), '127.0.0.1'].map((ip) => `http://${ip}${suffix}`);
  }

  private starting?: Promise<void>;
  start(ctx: AppContext): Promise<void> {
    if (!this.work.accepting) return Promise.reject(new Error('Web access is stopping'));
    return this.starting ??= this.startListening(ctx);
  }

  private async startListening(ctx: AppContext): Promise<void> {
    this.ctx = ctx;
    if (process.env.MUSTER_WEB === '0') {
      console.log('[web-access] MUSTER_WEB=0，网页访问未启动');
      return;
    }
    const userData = app.getPath('userData');
    const persisted = loadInstancePorts(userData);
    this.port = resolvePreferredPort({
      envPort: process.env.MUSTER_WEB_PORT,
      persisted: persisted?.webAccessPort,
      defaultPort: DEFAULT_PORT
    });
    const host = process.env.MUSTER_WEB_HOST || '0.0.0.0';
    try {
      this.loadOrInitInfo();
      const server = http.createServer((req, res) => {
        if (!this.work.accepting) { res.writeHead(503); res.end(); return; }
        void this.work.run(() => this.handleRequest(req, res)).catch(error => {
          console.error('[web-access] HTTP request failed', error); res.destroy();
        });
      });
      this.httpServer = server;
      this.wss = new WebSocketServer({
        server,
        path: WS_PATH,
        maxPayload: MAX_WS_PAYLOAD
      });
      // ws 构造器会把 http server 的 error 事件中继到 WebSocketServer 自身：
      // WSS 上若没有 error 监听，端口被占（EADDRINUSE）时中继会先抛
      // uncaughtException，把下面 once('error', reject) 的 reject 吞掉。
      this.wss.on('error', (err) => console.error('[web-access] ws error:', err));
      this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
      this.startServerHeartbeat();
      this.offBroadcast = onWebEventBroadcast((channel, payload) => {
        this.broadcastEvent(channel, payload);
      });
      const bound = await listenPreferred(server, this.port, host);
      if (!this.work.accepting) throw new Error('Web access stopped during startup');
      this.port = bound.port;
      saveInstancePorts(userData, {
        instanceId: ensureInstanceId(userData),
        webAccessPort: this.port
      });
      // listen 就绪后的常驻兜底（防未预期错误变成 uncaughtException）
      server.on('error', (err) => console.error('[web-access] http error:', err));
      console.log(`[web-access] 网页访问已启动（host=${host} port=${this.port}）`);
      this.printUrls();
    } catch (err) {
      // 网关失败不影响桌面使用（端口被占等场景）
      this.disabledReason = errorMessage(err);
      console.error('[web-access] 启动失败（不影响桌面使用）:', err);
      // The public stop waits this startup. Cleanup here must not await itself.
      this.work.stopAdmission();
      await this.closeResources();
    }
  }

  private readonly work = new AcceptedWork();
  private stopping?: Promise<void>;
  stopAdmission(): void { this.work.stopAdmission(); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.work.stopAdmission();
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.closeResources();
    })();
    void this.stopping.catch(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async closeResources(): Promise<void> {
    this.offBroadcast?.();
    this.offBroadcast = null;
    this.offNotifyBus?.();
    this.offNotifyBus = null;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const ws of this.clients.keys()) this.dropClient(ws);
    const wss = this.wss, server = this.httpServer;
    await (async () => {
      const closedWs = wss ? new Promise<void>((resolve, reject) => {
        wss.close(error => error && error.message !== 'The server is not running' ? reject(error) : resolve());
      }) : Promise.resolve();
      const closedHttp = server ? new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeAllConnections();
      }) : Promise.resolve();
      const results = await Promise.allSettled([closedWs, closedHttp, this.work.drain(), ...this.extensionViewClosures]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Web access shutdown failed');
      this.wss = null; this.httpServer = null;
    })();
  }

  private printUrls(): void {
    const urls = this.collectUrls();
    urls.forEach((url, i) =>
      console.log(`[web-access] ${url.includes('127.0.0.1') ? '本机' : i === 0 ? '推荐' : '局域网'}: ${url}`)
    );
    console.log(`[web-access] token 文件: ${tokenFilePath()}`);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    const rawNoQuery = raw.split('?')[0] || '/';
    let url: URL;
    try {
      url = new URL(raw, `http://${req.headers.host ?? 'muster.local'}`);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }
    const pathname = url.pathname;
    try {
      // 预览地址本身只授权某个源根的只读资源，不暴露可调用 IPC 的网关 token。
      if (pathname.startsWith('/media/preview/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'Method Not Allowed'); return; }
        if (!this.ctx) { sendText(res, 503, 'Not Ready'); return; }
        const match = /^\/media\/preview\/([0-9a-f]{48})\/(.*)$/.exec(rawNoQuery);
        if (!match) { sendText(res, 403, 'Forbidden'); return; }
        let relativePath: string;
        try { relativePath = match[2].split('/').map(decodeURIComponent).join('/'); }
        catch { sendText(res, 400, 'Bad Request'); return; }
        const response = await workspacePreviewsFor(this.ctx).serve(match[1], relativePath, gatewayRequest(req.headers.range));
        if (req.method === 'HEAD') { response.body?.cancel().catch(() => {}); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(); }
        else await sendResponse(response, res);
        return;
      }
      // webhook 触发端点（T3.2）：POST /hook/<hookToken>，独立于静态/媒体路由
      if (isHookPath(pathname)) {
        await handleHookRequest(req, res, this.hookDeps());
        return;
      }
      if (rawNoQuery === WS_PATH) {
        sendText(res, 426, 'Upgrade Required');
        return;
      }
      if (pathname.startsWith('/media/extension/')) {
        const match = /^\/media\/extension\/([0-9a-f-]{36})\/(view\/|__sdk__\/)(.*)$/.exec(rawNoQuery);
        if (!match) { sendText(res, 404, 'Not Found'); return; }
        const token = match[1];
        const owner = this.extensionViewOwners.get(token);
        // Sandboxed opaque-origin frames cannot send the gateway's SameSite
        // cookie for subresources. The random, connection-owned view token is
        // a read-only resource capability, revoked on close/disconnect.
        if (!owner || owner.readyState !== 1) { sendText(res, 401, 'Unauthorized'); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'Method Not Allowed'); return; }
        if (!this.ctx?.extensionSystem) { sendText(res, 503, 'Not Ready'); return; }
        const resource = match[2] === 'view/' ? match[3] : `__sdk__/${match[3]}`;
        const schemeUrl = `${MUSTER_APP_SCHEME}://${token}/${resource}`;
        const request = new Request(schemeUrl, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : undefined });
        const response = await this.ctx.extensionSystem.extensionHost.resource(request);
        if (this.extensionViewOwners.get(token) !== owner || owner.readyState !== 1) {
          await response.body?.cancel();
          sendText(res, 401, 'Unauthorized');
          return;
        }
        const headers = new Headers(response.headers);
        headers.set('Referrer-Policy', 'no-referrer');
        // Modules and fonts are CORS fetches from the iframe's opaque origin.
        // The view token still authorizes every request and no credentials are shared.
        if (req.headers.origin === 'null') headers.set('Access-Control-Allow-Origin', 'null');
        if (req.method === 'HEAD') await response.body?.cancel();
        await sendResponse(new Response(req.method === 'HEAD' ? null : response.body, { status: response.status, headers }), res);
        return;
      }
      if (pathname.startsWith('/media/ws/') || pathname.startsWith('/media/ext/')) {
        if (!isAuthorized(req, url, this.token)) {
          sendText(res, 401, 'Unauthorized');
          return;
        }
        await this.handleMedia(pathname, rawNoQuery, req.headers.range, res, url.search);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
      }
      // 鉴权口径（A2-7-1 + web-access F-02）：免鉴权静态面收敛为——
      //   ① /assets/* 构建资产（内容 hash 无密，已授权页面加载需要）；
      //   ② 其余根级路径（入口页 /、/index.html，以及未来任何新增产物如
      //      version.json、配置快照）一律要求 token——未授权只拿得到 401，
      //      不再因 serveStatic 对 out/renderer 全放行而静默扩大暴露面；
      //   ③ / 与 /index.html 未命中产物时仍走 sendDevFallback（内嵌 token 明文，
      //      绝不能未授权下发，故同样先过鉴权）。
      if (!pathname.startsWith('/assets/') && !isAuthorized(req, url, this.token)) {
        sendText(res, 401, 'Unauthorized');
        return;
      }
      const served = await serveStatic(pathname, res);
      if (!served) sendDevFallback(res, this.token, this.port);
    } catch (err) {
      console.error('[web-access] request failed', raw, err);
      if (!res.headersSent) sendText(res, 500, 'Internal Error');
      else res.destroy();
    }
  }

  /** hook 路由的依赖注入：token/密钥取内存态，触发交给任务管理器 */
  private hookDeps(): HookRouteDeps {
    return {
      getHookToken: () => this.hookToken,
      getHookSecret: () => this.hookSecret,
      ingestWebhook: async (input) => {
        const ctx = this.ctx;
        if (!ctx?.eventRouter) throw new Error('Event router is unavailable');
        const receipt = ctx.eventRouter.publish(input);
        if (receipt.inserted && input.source === 'github' && input.type === 'pull_request.ready_for_review') {
          try {
            const event = parseGitHubPrWebhook('pull_request', JSON.parse(input.payload));
            if (event) ctx.githubPr?.observeWebhook(event);
          } catch { console.warn('[github-pr] could not queue signed PR event'); }
        }
        return { triggered: 0, skipped: 0, queued: true };
      },
      log: (entry) => {
        const counts =
          entry.outcome === 'triggered' ? ` triggered=${entry.triggered ?? 0} skipped=${entry.skipped ?? 0}` : '';
        const detail = entry.note ? ` ${entry.note}` : '';
        console.log(`[web-access] hook ${entry.outcome}${counts}${detail}`);
      }
    };
  }

  private async handleMedia(
    pathname: string,
    rawNoQuery: string,
    range: string | undefined,
    res: http.ServerResponse,
    search = ''
  ): Promise<void> {
    if (!this.ctx) {
      sendText(res, 503, 'Not Ready');
      return;
    }
    const parsed = mediaSchemeUrl(pathname, rawNoQuery, search);
    if (!parsed) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const request = gatewayRequest(range);
    const resp = parsed.ws
      ? await handleWorkspaceMediaRequest(this.ctx, parsed.schemeUrl, request)
      : await handleExternalFileRequest(parsed.schemeUrl, request);
    await sendResponse(resp, res);
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'muster.local'}`);
    } catch {
      ws.close(4002, 'bad request');
      return;
    }
    if (!isAuthorized(req, url, this.token)) {
      // 带长度差诊断（不落 token 本体），排查「浏览器连不上但 Node 能连」类问题
      const provided = extractProvidedToken(req, url);
      console.warn(
        `[web-access] ws 鉴权失败: provided=${provided ? `len(${provided.length})` : "none"} expected=len(${this.token.length}) from=${req.socket.remoteAddress}`
      );
      ws.close(4001, "unauthorized");
      return;
    }
    this.clients.set(ws, { ownerId: `web:${randomBytes(16).toString('hex')}`, isAlive: true, drop: null, capsDrop: [], extensionViews: new Set() });
    ws.on('pong', () => {
      const meta = this.clients.get(ws);
      if (meta) meta.isAlive = true;
    });
    ws.on('close', () => this.releaseClient(ws));
    ws.on('error', (err) => {
      console.warn('[web-access] ws error:', err.message);
    });
    ws.on('message', (raw) => {
      const meta = this.clients.get(ws);
      if (meta) meta.isAlive = true;
      // 局部失败收尾（R1）：分派器内部不应抛错，但万一抛了不能变成全局
      // unhandledRejection——记日志并收尾该连接（释放 owner 资源，与 close 路径一致）
      if (!this.work.accepting) return;
      this.work.run(() => this.handleClientMessage(ws, raw)).catch((err) => {
        console.error('[web-access] client message dispatch failed:', err);
        this.dropClient(ws);
      });
    });
  }

  /** 协议层 ping/pong 扫僵尸：连续一个周期无 pong/帧则 terminate */
  private startServerHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, meta] of [...this.clients]) {
        if (!meta.isAlive) {
          this.dropClient(ws);
          continue;
        }
        meta.isAlive = false;
        try {
          ws.ping();
        } catch {
          this.dropClient(ws);
        }
      }
    }, SERVER_HEARTBEAT_INTERVAL_MS);
  }

  private dropClient(ws: WebSocket): void {
    this.releaseClient(ws);
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }

  private releaseClient(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;
    this.clients.delete(ws);
    for (const token of client.extensionViews) {
      this.extensionViewOwners.delete(token);
      const close = this.closeExtensionView(token).catch(error => console.error('[web-access] extension view cleanup failed:', error));
      this.extensionViewClosures.add(close);
      void close.then(() => this.extensionViewClosures.delete(close));
    }
    client.extensionViews.clear();
    if (this.ctx) workspaceRootUsesFor(this.ctx.config).closeOwner(client.ownerId);
  }

  private async closeExtensionView(token: string): Promise<void> {
    await this.ctx?.extensionSystem?.extensionHost.close(token);
  }

  /** 帧解码（wsProtocol.parseClientFrame，合法帧才非 null）+ 业务分派。
  * 结构验证在共享解码层完成；这里只做带鉴权/owner 语义的分派与回复合同。
  * 已被吊销（rotate 后 close 前窗口）或已断开的连接不再受理任何帧。 */
  private async handleClientMessage(ws: WebSocket, raw: unknown): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // 畸形帧静默丢弃
    }
    const frame = parseClientFrame(msg);
    if (!frame) return; // 合法 JSON 但不是协议对象（null/数组/标量/字段类型不对）→ 静默丢弃
    const meta = this.clients.get(ws);
    if (!meta) return; // 连接已吊销/断开：不再受理（旧连接在 close 完成前也不能新发请求）
    switch (frame.kind) {
      case 'ping': {
        try {
          ws.send(encodePong());
        } catch {
          this.dropClient(ws);
        }
        return;
      }
      case 'pong':
        return;
      case 'hello':
        meta.capsDrop = capsDropList(frame.caps);
        meta.drop = mergeDropList(meta.capsDrop, null);
        return;
      case 'filter':
        meta.drop = mergeDropList(meta.capsDrop, frame.drop);
        return;
      case 'invoke':
        await this.handleInvoke(ws, frame.id, frame.channel, frame.args);
        return;
      case 'send': {
        const channel = frame.channel;
        const allowed =
          SEND_ALLOW.has(channel) || SEND_PREFIX_ALLOW.some((p) => channel.startsWith(p));
        if (!allowed) return;
        try {
          ipcMain.emit(channel, null, ...frame.args);
        } catch (err) {
          console.error(`[web-access] send ${channel} failed:`, err);
        }
        return;
      }
    }
  }

  private async handleInvoke(
    ws: WebSocket,
    id: number,
    channel: string,
    rawArgs: unknown
  ): Promise<void> {
    const reply = (body: Record<string, unknown>): void => {
      try {
        const serialized = JSON.stringify({ t: 'result', id, ...body });
        if (serialized) ws.send(serialized);
      } catch (err) {
        console.error(`[web-access] reply ${channel} failed:`, err);
      }
    };
    if (!isWebIpcAllowed(channel, Array.isArray(rawArgs) ? rawArgs : [])) {
      const error = channel.startsWith('browser:')
        ? t('内置浏览器仅在 Muster 桌面应用中可用。请在桌面应用中继续此操作。')
        : t('网页访问不支持通道: {{channel}}', { channel });
      reply({ ok: false, error });
      return;
    }
    if (!hasIpcChannel(channel)) {
      reply({ ok: false, error: t('[ipc] 无此通道: {{channel}}', { channel }) });
      return;
    }
    try {
      const args = Array.isArray(rawArgs) ? rawArgs : [];
      const client = this.clients.get(ws);
      if (!client) throw new Error('web client disconnected');
      const objectToken = EXTENSION_VIEW_OBJECT_CHANNELS.has(channel);
      const directToken = EXTENSION_VIEW_TOKEN_CHANNELS.has(channel);
      const token = objectToken ? extensionViewToken(args[0]) : directToken && typeof args[0] === 'string' ? args[0] : undefined;
      if ((objectToken || directToken) && (!token || !client.extensionViews.has(token))) {
        throw new Error('Extension view belongs to another client or is no longer available');
      }
      const isAlive = (): boolean => this.clients.get(ws) === client && ws.readyState === 1;
      const result = await invokeIpcChannel(channel, args, {
        id: client.ownerId, kind: 'web', isAlive,
        sendEvent: (eventChannel, payload) => {
          if (!isAlive() || shouldDropChannel(client.drop, eventChannel)) return;
          if (EXTENSION_VIEW_EVENTS.has(eventChannel) && this.extensionViewOwners.get(extensionViewToken(payload) ?? '') !== ws) return;
          this.sendToClient(ws, JSON.stringify({ t: 'event', channel: eventChannel, payload }));
        }
      });
      if (channel === 'extensionSurface:open') {
        const opened = extensionViewToken(result);
        if (!opened) throw new Error('Extension view identity is unavailable');
        if (!isAlive()) {
          await this.closeExtensionView(opened);
          return;
        }
        client.extensionViews.add(opened);
        this.extensionViewOwners.set(opened, ws);
      } else if (channel === 'extensionSurface:close' && token) {
        client.extensionViews.delete(token);
        this.extensionViewOwners.delete(token);
      }
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: errorMessage(err) });
    }
  }

  private broadcastEvent(channel: string, payload: unknown): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify({ t: 'event', channel, payload });
    } catch (err) {
      console.error(`[web-access] serialize event ${channel} failed:`, err);
      return;
    }
    if (!serialized) return;
    const scoped = EXTENSION_VIEW_EVENTS.has(channel);
    const viewToken = scoped ? extensionViewToken(payload) : undefined;
    const viewOwner = viewToken ? this.extensionViewOwners.get(viewToken) : undefined;
    for (const [ws, meta] of this.clients) {
      if (scoped && ws !== viewOwner) continue;
      if (shouldDropChannel(meta.drop, channel)) continue;
      this.sendToClient(ws, serialized);
    }
    if (channel === 'workbench:extensionInvalidated' && viewToken && viewOwner) {
      this.clients.get(viewOwner)?.extensionViews.delete(viewToken);
      this.extensionViewOwners.delete(viewToken);
    }
  }

  /** 服务端主动推送帧（T1.2 session-status；与 event 广播同走全量客户端） */
  private broadcastPush(frame: SessionStatusPush): void {
    const serialized = JSON.stringify({ t: 'push', ...frame });
    this.broadcastRaw(serialized);
  }

  private broadcastRaw(serialized: string): void {
    for (const ws of this.clients.keys()) {
      this.sendToClient(ws, serialized);
    }
  }

  /** send 抛错 = 连接已死：terminate 并摘出 clients（原实现只吞异常留僵尸） */
  private sendToClient(ws: WebSocket, serialized: string): void {
    try {
      ws.send(serialized);
    } catch {
      this.dropClient(ws);
    }
  }
}
