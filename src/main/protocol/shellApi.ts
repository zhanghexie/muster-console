import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../context';
import { executeTool, serializeModelToolResult, serializeResult, type ExecuteResult } from '../capabilities/executor';
import { ptyProjectedCatalog } from '../capabilities/catalog/projectedCatalog';
import { resolveProjectedHostApiName, routeProjectedHostCall } from '../capabilities/projectedHostRoute';
import { executeProjectedPty } from '../capabilities/projectedPty';
import { executeWorkerHostAsk } from '../agentSession/tools/workerHostAsk';
import { requestPtyHostQuestion } from '../agentSession/tools/ptyHostQuestion';
import type { LiveStatus, SessionPhase } from '../../shared/types';
import { capsuleForSetStatus } from '../../shared/setStatus';
import { ESCALATE_REFUSED_MESSAGE, escalateBudgetKey } from '../../shared/escalateBudget';
import { phaseWriteBlocked } from '../../shared/boardStatus';
import { parseStatusBody } from './statusBody';
import { afterNeedsYouReported } from '../agentSession/workerTreeGuard';
import { parseJsonBufferFlexible } from '../encoding/winUtf8';
import { META_AGENT_PRODUCT } from '../../shared/metaAgent';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';


import { listenPreferred } from '../net/bindListen';
import { loadInstancePorts, saveInstancePorts, ensureInstanceId } from '../instance/portsFile';
import { resolvePreferredPort } from '../../shared/listenPort';

import { ACTOR_SESSION_ID_ARG } from '../capabilities/hosts/actors';
import {runWithExternalMemoryCandidate} from '../agent/turnScope';
import { bindWorkerToolArgs, workerToolRequiresToken } from '../capabilities/workerBinding';
import { expandRunToolCall } from '../capabilities/runRouter';
import { runToolDomainOf } from '../capabilities/catalog/runTools';
import { captureTurnShots, recordBrowserToolUse } from '../browser/turnShotCapture';
import { requestAbort } from './requestAbort';
import { AcceptedWork } from '../net/acceptedWork';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { capturePtyDesktopRequest } from '../desktop/ptyDesktopRequest';
import { runAsPtyDesktopTurn } from '../agent/agentScope';

class UnauthenticatedHostCall extends Error {}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(parseJsonBufferFlexible(Buffer.concat(chunks)));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

/** 解析已序列化结果并转发；理论上 serializeResult 恒为合法 JSON，这里兜底防回归 */
function safeParseSerialized(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { ok: false, error: t('结果序列化异常（非合法 JSON）') };
  }
}

function bearerToken(req: http.IncomingMessage): string {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(\S+)/i.exec(h.trim());
  return m?.[1]?.trim() ?? '';
}

/**
 * 本机 Shell HTTP API：Worker 上报状态、脚本/Pi 调 Catalog。
 * 绑定 127.0.0.1 随机端口，端口写入 userData/shell-api.json。
 */
export class ShellApiServer {
  private server: http.Server | null = null;
  private port = 0;
  private endpointFile = '';
  private readonly work = new AcceptedWork();
  private stopping?: Promise<void>;
  private starting?: Promise<void>;

  constructor(private ctx: AppContext) {}

  get baseUrl(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  get statusPostUrl(): string {
    return this.baseUrl ? `${this.baseUrl}/v1/session-status` : '';
  }

  statusUrlForToken(token: string): string {
    return this.baseUrl ? `${this.baseUrl}/v1/s/${token}/status` : '';
  }

  start(): Promise<void> {
    if (!this.work.accepting) return Promise.reject(new Error('Shell API is stopping'));
    return this.starting ??= this.startListening().catch(async error => {
      this.work.stopAdmission();
      try { await this.closeResources(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Shell API startup and cleanup failed'); }
      throw error;
    });
  }

  private async startListening(): Promise<void> {
    this.endpointFile = userDataStorage(app.getPath('userData')).file('shell-api');

    this.server = http.createServer((req, res) => {
      if (!this.work.accepting) { res.writeHead(503); res.end(); return; }
      void this.work.run(() => this.handle(req, res)).catch(error => {
        console.error('[shellApi] request failed', error);
        res.destroy();
      });
    });

    const userData = app.getPath('userData');
    const persisted = loadInstancePorts(userData);
    const preferred = resolvePreferredPort({
      envPort: process.env.MUSTER_SHELL_API_PORT,
      persisted: persisted?.shellApiPort,
      defaultPort: 0
    });
    const { port } = await listenPreferred(this.server, preferred, '127.0.0.1');
    if (!this.work.accepting) throw new Error('Shell API stopped during startup');
    this.port = port;
    saveInstancePorts(userData, {
      instanceId: ensureInstanceId(userData),
      shellApiPort: port
    });
    this.writeEndpointFile();
  }

  stopAdmission(): void { this.work.stopAdmission(); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.work.stopAdmission();
    this.port = 0;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.closeResources();
    })();
    void this.stopping.catch(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async closeResources(): Promise<void> {
      this.port = 0;
      const server = this.server;
      const closed = server ? new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeAllConnections();
      }) : Promise.resolve();
      const results = await Promise.allSettled([closed, this.work.drain()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Shell API shutdown failed');
      this.server = null;
  }

  private writeEndpointFile(): void {
    const payload = {
      baseUrl: this.baseUrl,
      statusUrl: this.statusPostUrl,
      toolUrl: `${this.baseUrl}/v1/tool`,
      updatedAt: Date.now()
    };
    try {
      fs.mkdirSync(path.dirname(this.endpointFile), { recursive: true });
      fs.writeFileSync(this.endpointFile, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
      console.error('[shellApi] write endpoint file failed', e);
    }
  }

  /**
   * 应用上报 body：phase 需要人/完成（模型）+ activity（hooks）+ label 胶囊。
   * 至少其一；旧 body 仅 label 只改胶囊。
   */
  private async applyLiveStatus(
    sessionId: string,
    body: Record<string, unknown>,
    matchedBy: string
  ) {
    const parsed = parseStatusBody(body);
    if (parsed.activity) {
      this.ctx.sessions.applyActivitySignal(sessionId, parsed.activity, parsed.event, parsed.toolUseId);
      // CLI 回合截图证据（任务 D）：终端 Worker 报 idle 即回合收口——取走本回合实际
      // 用过的 browser tab 归集截图。fire-and-forget，失败不影响状态上报。
      if (parsed.activity === 'idle' && this.ctx.sessions.get(sessionId)?.type === 'terminal') {
        void captureTurnShots(this.ctx, sessionId);
      }
    }
    // HTTP needs_you 与 setStatus 工具共用用户注意通知预算；会话消息不计入。
    // CLI 首条简报 教的状态主通道不得绕过预算。预算尽：不 setPhase（不发「等人」
    // 通知），label/note 胶囊仍可更新，refused 进响应 body（Worker 读 curl 回包可见）。
    // 粘性预检与 setStatus 工具同谓词：model 写入必被拦的相位不烧预算（防空转烧额度）。
    let refusedEscalate: { message: string } | undefined;
    if (parsed.phase === 'needs_you') {
      const pre = this.ctx.sessions.get(sessionId);
      const stickyHeld = phaseWriteBlocked(pre?.phase, { source: 'model' });
      if (!stickyHeld) {
        const key = escalateBudgetKey({ sessionId });
        const attempt = this.ctx.sessions.consumeEscalateBudget(sessionId, key);
        if (!attempt.escalate) {
          refusedEscalate = {
            message: attempt.message ?? ESCALATE_REFUSED_MESSAGE
          };
        }
      }
    }
    let live: LiveStatus | undefined;
    let appliedPhase: SessionPhase | undefined;
    if (parsed.phase && !refusedEscalate) {
      // 与 sessions.setStatus 工具同语义：phase 真正写入（未被粘性拦下）且省略 label 时，
      // 宿主按 phase 补默认胶囊——节点推进必然刷新文案，Worker 想漏都难
      const after = this.ctx.sessions.setPhase(sessionId, {
        value: parsed.phase,
        source: 'model'
      });
      appliedPhase = after.phase;
      const phaseApplied = after.phase?.value === parsed.phase && after.phase?.source === 'model';
      const capsule = capsuleForSetStatus(
        { phase: parsed.phase, note: parsed.label, kind: parsed.kind },
        phaseApplied
      );
      if (capsule) {
        live = { ...capsule, summary: parsed.summary, ts: Date.now() };
        this.ctx.sessions.setLiveStatus(sessionId, live);
      }
    } else if (parsed.label) {
      // 仅胶囊（含预算尽时的 note 更新）：旧 body 仅 label 行为不变（缺省 info 着色）；
      // note 别名按进行中着色，与 sessions.setStatus 工具只传 note 的语义一致
      live = {
        label: parsed.label,
        kind: parsed.kind ?? (parsed.labelFromNote ? 'active' : 'info'),
        summary: parsed.summary,
        ts: Date.now()
      };
      this.ctx.sessions.setLiveStatus(sessionId, live);
    }
    const out: {
      ok: true;
      sessionId: string;
      matchedBy: string;
      liveStatus?: LiveStatus;
      activity?: string;
      phase?: string;
      warnings?: string[];
      dirtyWorktree?: boolean;
      refused?: boolean;
      message?: string;
    } = {
      ok: true,
      sessionId,
      matchedBy,
      liveStatus: live,
      activity: parsed.activity,
      phase: parsed.phase
    };
    if (refusedEscalate) {
      out.refused = true;
      out.message = refusedEscalate.message;
      out.warnings = [refusedEscalate.message];
      if (body.resultView === 'model') appliedPhase = this.ctx.sessions.get(sessionId)?.phase;
    } else if (parsed.phase === 'needs_you') {
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const guard = await afterNeedsYouReported(this.ctx, sessionId, reason);
      if (guard.warnings.length) {
        out.warnings = guard.warnings;
        out.dirtyWorktree = guard.dirty;
      }
    }
    if (body.resultView !== 'model') return out;
    return {
      ok: true, sessionId,
      ...(parsed.phase ? { phase: appliedPhase?.value ?? null, phaseSource: appliedPhase?.source } : {}),
      ...(live ? { liveStatus: { label: live.label, kind: live.kind } } : {}),
      ...(parsed.activity ? { activity: parsed.activity } : {}),
      ...(refusedEscalate ? { refused: true, message: refusedEscalate.message } : {}),
      ...(out.warnings && !refusedEscalate ? { warnings: out.warnings, dirtyWorktree: out.dirtyWorktree } : {})
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(res, 200, {
          ok: true,
          product: META_AGENT_PRODUCT,
          baseUrl: this.baseUrl,
          version: app.getVersion()
        });
        return;
      }

      // Worker 推荐：URL 已绑定会话，body 带 phase 和/或 label
      const tokenPath = /^\/v1\/s\/([^/]+)\/status$/.exec(url.pathname);
      if (req.method === 'POST' && tokenPath) {
        const body = (await readJson(req)) as Record<string, unknown>;
        const resolved = this.ctx.sessions.resolveSessionRef({ statusToken: tokenPath[1] });
        sendJson(res, 200, await this.applyLiveStatus(resolved.id, body, resolved.matchedBy));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/session-status') {
        const body = (await readJson(req)) as Record<string, unknown>;
        const statusToken =
          bearerToken(req) ||
          (typeof body.statusToken === 'string' ? body.statusToken.trim() : '') ||
          url.searchParams.get('token')?.trim() ||
          '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const externalSessionId =
          typeof body.externalSessionId === 'string' ? body.externalSessionId.trim() : '';
        const resolved = this.ctx.sessions.resolveSessionRef({
          statusToken,
          sessionId,
          externalSessionId
        });
        sendJson(res, 200, await this.applyLiveStatus(resolved.id, body, resolved.matchedBy));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/tool') {
        const token = bearerToken(req);
        let session;
        if (token) {
          try {
            const caller = this.ctx.sessions.resolveSessionRef({ statusToken: token });
            session = this.ctx.sessions.peek(caller.id);
          } catch { /* Unknown session token. */ }
        }
        if (!session || session.archived || !this.ctx.sessions.sessionScopeToken(session.id)) {
          sendJson(res, 401, { ok: false, error: 'Tool schemas require an authenticated Worker session.' });
          return;
        }
        const tools = ptyProjectedCatalog(true).map(({ def }) => ({
          name: def.name, description: def.description, inputSchema: def.parameters
        }));
        sendJson(res, 200, { ok: true, tools });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/tool') {
        const headerToken = bearerToken(req);
        let ptyDesktopTurn: ReturnType<typeof capturePtyDesktopRequest> | undefined;
        let ptyDesktopError: string | undefined;
        if (this.ctx.desktopTurns) {
          try { ptyDesktopTurn = capturePtyDesktopRequest(this.ctx, headerToken); }
          catch (error) { ptyDesktopError = errorMessage(error); }
        }
        const body = (await readJson(req)) as { name?: string; arguments?: unknown; resultView?: string };
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) {
          sendJson(res, 400, { ok: false, error: t('需要 name（Catalog 点名，如 sessions.observe）') });
          return;
        }
        let argsObj: Record<string, unknown> = {};
        if (typeof body.arguments === 'string' && body.arguments.trim()) {
          try {
            argsObj = JSON.parse(body.arguments) as Record<string, unknown>;
          } catch (e) {
            sendJson(res, 400, {
              ok: false,
              error: t('arguments 不是合法 JSON: {{message}}', { message: (e as Error).message })
            });
            return;
          }
        } else if (body.arguments && typeof body.arguments === 'object') {
          argsObj = body.arguments as Record<string, unknown>;
        }
        const entries = ptyProjectedCatalog(true);
        const publicName = resolveProjectedHostApiName(entries, name);
        if (!publicName) {
          sendJson(res, 403, { ok: false, error: `Unknown Worker host tool: ${name}` });
          return;
        }
        const token = headerToken || (typeof argsObj.statusToken === 'string' ? argsObj.statusToken.trim() : '');
        const caller = token ? this.ctx.sessions.resolveSessionRef({ statusToken: token }) : undefined;
        const session = caller ? this.ctx.sessions.peek(caller.id) : undefined;
        const scopeToken = caller ? this.ctx.sessions.sessionScopeToken(caller.id) : undefined;
        if (caller && (!session || session.archived || !scopeToken)) {
          sendJson(res, 401, { ok: false, error: 'Worker session is no longer available.' });
          return;
        }
        const request = requestAbort(req, res);
        const detach = this.work.attach(request.controller);
        const desktopRequest = publicName.startsWith('host.desktop.');
        const current = () => !request.signal.aborted && (!caller ||
          (this.ctx.sessions.peek(caller.id) === session && !session?.archived && this.ctx.sessions.sessionScopeToken(caller.id) === scopeToken)) &&
          (!desktopRequest || !this.ctx.desktopTurns || (!!ptyDesktopTurn && ptyDesktopTurn.sessionId === caller?.id && ptyDesktopTurn.isDesktopCurrent()));
        const invokeSource = async (target: string, sourceArgs: Record<string, unknown>) => {
          let execName = target, bound = sourceArgs, selfAction: string | undefined;
          if (runToolDomainOf(target)) {
            const route = expandRunToolCall(target, sourceArgs, caller ? { ctx: this.ctx, sessionId: caller.id } : undefined);
            execName = route.targetTool; bound = route.args;
            if (execName === target) selfAction = route.action;
          } else if (caller) bound = bindWorkerToolArgs(this.ctx, execName, sourceArgs, caller.id);
          else { bound = { ...sourceArgs }; delete bound[ACTOR_SESSION_ID_ARG]; delete bound.__browserOwner; }
          if (!caller && workerToolRequiresToken(execName)) throw new UnauthenticatedHostCall(`Tool ${publicName} requires an authenticated Worker session.`);
          const selfParams = { ...bound }; delete selfParams[ACTOR_SESSION_ID_ARG];
          const executorArgs = selfAction ? { action: selfAction, params: selfParams } : bound;
          const result = await executeTool(this.ctx, execName, JSON.stringify(executorArgs), {
            signal: request.signal, ...(caller ? { callingSessionId: caller.id } : {}) });
          if (caller) recordBrowserToolUse(caller.id, execName, bound, result);
          return result;
        };
        try {
          let value: unknown;
          if (desktopRequest && this.ctx.desktopTurns && !ptyDesktopTurn) {
            throw new Error(ptyDesktopError || 'CLI desktop execution context is unavailable');
          }
          if (!caller) {
            const route = routeProjectedHostCall(entries, 'worker', publicName, argsObj);
            if (route.kind !== 'direct') throw new UnauthenticatedHostCall(`Tool ${publicName} requires an authenticated Worker session.`);
            value = await invokeSource(route.target, route.args);
          } else {
            const run = () => executeProjectedPty(entries, publicName, argsObj, {
              sessionId: caller.id, isCurrent: current,
              resolveSession: ref => { try { return this.ctx.sessions.get(this.ctx.sessions.resolveSessionRef({ sessionId: ref }).id); } catch { return undefined; } },
              sessionIdentity: id => this.ctx.sessions.peek(id),
              execute: invokeSource,
              ask: args => executeWorkerHostAsk(args, (question, signal) => requestPtyHostQuestion(this.ctx.ui, session!.name, question, signal), request.signal)
            });
            value = desktopRequest && ptyDesktopTurn ? await runAsPtyDesktopTurn(ptyDesktopTurn, run)
              : ['host.memory.note', 'host.memory.correct'].includes(publicName) ? await runWithExternalMemoryCandidate(caller.id, run) : await run();
          }
          if (!res.destroyed) {
            const modelView = body.resultView === 'model';
            if (publicName === 'host.ask') sendJson(res, 200, { ok: true, result: value });
            else if (publicName === 'host.sessions.update') {
              const outcome = value as { ok: boolean; failed?: { error: string } };
              if (modelView) {
                const result: ExecuteResult = { ok: outcome.ok, result: value, error: outcome.failed?.error };
                sendJson(res, 200, safeParseSerialized(serializeModelToolResult(result, publicName, argsObj)));
              } else sendJson(res, 200, outcome.ok ? { ok: true, result: value } : { ok: false, error: JSON.stringify(value), result: value });
            } else {
              const result = value as ExecuteResult;
              sendJson(res, 200, safeParseSerialized(modelView ? serializeModelToolResult(result, publicName, argsObj) : serializeResult(result)));
            }
          }
        } catch (error) {
          if (!res.destroyed) sendJson(res, error instanceof UnauthenticatedHostCall ? 401 : 400, { ok: false, error: errorMessage(error) });
        } finally { detach(); request.dispose(); }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: errorMessage(e) });
    }
  }
}
