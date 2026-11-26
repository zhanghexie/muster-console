/**
 * webhook 触发端点（T3.2）：`POST /hook/<hookToken>`。
 *
 * 独立于网页访问 token 的 hook token（URL 末段，防路过者），叠加可选的
 * GitHub `X-Hub-Signature-256` 签名校验（证明 payload 来自知道 hook secret 的
 * 一方）。payload 经 shared/webhookPayload 归一为 push/issue/comment 触发事件，
 * 交给事件日志和订阅系统，不调用定时任务管理器。
 *
 * 本模块刻意不引 electron，也不依赖 WebAccessServer——路由逻辑可被测试以真实
 * http server 直接装配（见 test/hook-route.mjs），server.ts 只做依赖注入。
 * 响应体是给 GitHub / CI 的机器消费者，文案刻意用英文不接 i18n。
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { buildGitLabWebhookTriggerEvent, buildWebhookTriggerEvent, isGitHubPrEvent } from '../../shared/webhookPayload';
import { verifyHubSignature256 } from './hookVerify';
import type { EventLogInput } from '../awareness/eventLog';

/** hook 路径前缀；完整形态 `/hook/<token>` */
export const HOOK_PATH_PREFIX = '/hook/';

/** 请求体上限：GitHub 单条 webhook 通常远小于此（默认 1 MiB） */
export const DEFAULT_MAX_HOOK_BODY_BYTES = 1024 * 1024;

/** 触发日志条目（成功/失败/去抖丢弃/被拒），默认写 console，测试可注入收集 */
export interface HookLogEntry {
  at: number;
  /** triggered=已拉起（含去抖丢弃计数）；ignored=事件不映射任何任务；rejected=鉴权/签名/报文被拒；error=处理异常 */
  outcome: 'triggered' | 'ignored' | 'rejected' | 'error';
  note?: string;
  status?: number;
  triggered?: number;
  skipped?: number;
  remote?: string;
}

export interface HookRouteDeps {
  /** 期望的 hook token（URL 末段）；空串视为未启用端点，一律 404 */
  getHookToken(): string;
  /** GitHub 签名密钥；空串 = 未配置，跳过签名校验（内网场景 hook token 已够） */
  getHookSecret(): string;
  /** Persist and publish a webhook event to the event subscription system. */
  ingestWebhook(input: EventLogInput): Promise<{ triggered: number; skipped: number; queued?: boolean }>;
  log?(entry: HookLogEntry): void;
  maxBodyBytes?: number;
}

/** 是否本模块负责的路径（server.ts 据此分流，避免动到静态/媒体路由） */
export function isHookPath(pathname: string): boolean {
  return pathname === HOOK_PATH_PREFIX.slice(0, -1) || pathname.startsWith(HOOK_PATH_PREFIX);
}

function safeEqualStr(a: string, b: string): boolean {
  // Compare fixed-size digests to avoid a length-dependent early return.
  const ab = createHash('sha256').update(a, 'utf8').digest();
  const bb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ab, bb);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** 读请求体并限长；超限返回 null（调用方回 413） */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      // 声明超限：不销毁 socket（413 要能送达客户端，客户端见 413 即停）、不排空请求体；
      // 只有逐块超限路径（下方 size>limit）才 req.destroy()
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/**
 * 处理一个候选请求；返回 true 表示本模块已接管（无论成功/拒绝），false 表示
 * 不是 hook 路径，调用方继续走原有路由。hook 路径上的任何方法/报文都由本模块
 * 应答，避免落到「405 Method Not Allowed」的通用分支。
 */
export async function handleHookRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: HookRouteDeps
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'muster.local'}`);
  } catch {
    return false;
  }
  const pathname = url.pathname;
  if (!isHookPath(pathname)) return false;

  const remote = req.socket.remoteAddress ?? undefined;
  const expected = deps.getHookToken();
  const fail = (status: number, error: string, note?: string): true => {
    sendJson(res, status, { ok: false, error });
    deps.log?.({ at: Date.now(), outcome: 'rejected', status, note: note ?? error, remote });
    return true;
  };

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(405, 'Method Not Allowed');
  }
  if (!expected) return fail(404, 'Not Found');

  let provided: string;
  try {
    provided = decodeURIComponent(pathname.slice(HOOK_PATH_PREFIX.length));
  } catch {
    return fail(400, 'Bad hook token');
  }
  if (provided.includes('/') || !safeEqualStr(provided, expected)) {
    return fail(401, 'Unauthorized');
  }

  const body = await readBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_HOOK_BODY_BYTES);
  if (!body) return fail(413, 'Payload Too Large');

  const secret = deps.getHookSecret();
  const ghEvent = headerValue(req.headers['x-github-event']);
  const gitlabEvent = headerValue(req.headers['x-gitlab-event']);
  const gitlabToken = headerValue(req.headers['x-gitlab-token']);
  const isGitLab = gitlabEvent !== undefined || gitlabToken !== undefined;
  if (isGitLab && (ghEvent !== undefined || req.headers['x-hub-signature-256'] !== undefined)) {
    return fail(400, 'Ambiguous webhook provider');
  }
  if (isGitLab) {
    if (!gitlabEvent) return fail(400, 'Missing GitLab event');
    if (!secret || !gitlabToken || !safeEqualStr(gitlabToken, secret)) {
      return fail(401, 'Invalid GitLab token', 'gitlab-token');
    }
  } else if (isGitHubPrEvent(ghEvent) && !secret) {
    return fail(401, 'GitHub PR events require a webhook secret', 'signature');
  } else if (secret && !verifyHubSignature256(secret, body, headerValue(req.headers['x-hub-signature-256']))) {
    return fail(401, 'Invalid signature', 'signature');
  }

  let payload: unknown;
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
    payload = body.length ? JSON.parse(raw) : {};
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const built = isGitLab
    ? buildGitLabWebhookTriggerEvent(gitlabEvent!, payload)
    : buildWebhookTriggerEvent(ghEvent, payload);
  if (!built) {
    sendJson(res, 200, { ok: true, triggered: 0, skipped: 0, ignored: true, event: isGitLab ? gitlabEvent : ghEvent });
    deps.log?.({ at: Date.now(), outcome: 'ignored', note: isGitLab ? gitlabEvent : ghEvent, remote });
    return true;
  }

  try {
    const rawDeliveryId = headerValue(req.headers[isGitLab ? 'x-gitlab-event-uuid' : 'x-github-delivery']);
    if (rawDeliveryId && (rawDeliveryId.length > 200 || /[\x00-\x1f\x7f]/.test(rawDeliveryId))) return fail(400, 'Invalid delivery ID');
    const repository = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { repository?: { full_name?: unknown } }).repository?.full_name : undefined;
    const input: EventLogInput = { source: isGitLab ? 'gitlab' : 'github',
      ...(rawDeliveryId ? { deliveryId: rawDeliveryId } : {}), type: built.event.eventType ?? 'manual',
      scope: isGitLab ? String(built.event.gitlab?.projectId ?? '') : typeof repository === 'string' ? repository.slice(0, 300) : '',
      receivedAt: built.event.at, summary: built.note.slice(0, 1000), payload: raw };
    const { triggered, skipped, queued } = await deps.ingestWebhook(input);
    sendJson(res, 200, { ok: true, triggered, skipped, ...(queued ? { queued: true } : {}), note: built.note });
    deps.log?.({
      at: Date.now(),
      outcome: 'triggered',
      note: built.note,
      triggered,
      skipped,
      remote
    });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: 'Trigger failed' });
    deps.log?.({
      at: Date.now(),
      outcome: 'error',
      note: err instanceof Error ? err.message : String(err),
      remote
    });
  }
  return true;
}
