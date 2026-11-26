/**
 * Worker 调宿主工具时的身份绑定（CLI /v1/tool Bearer 令牌与 GUI 进程内 exec.sessionId 两侧共用）。
 * 规则表在 shared/hostTools meta 的 bind 字段；这里只做机械应用，禁止在调用方另写一份。
 */
import { hostToolBinding } from '../../shared/hostTools';
import { ACTOR_SESSION_ID_ARG } from './hosts/actors';

interface BindingSessionLookup {
  sessions: {
    get(id: string): { workspaceId?: string; name: string } | undefined;
  };
}

/** actor / self 绑定的工具必须凭令牌认身份：缺令牌时拿不到调用方，模型自报的 sessionId 不可信 */
export function workerToolRequiresToken(toolName: string): boolean {
  const binding = hostToolBinding(toolName);
  return binding === 'actor' || binding === 'self';
}

function isBlank(v: unknown): boolean {
  return !(typeof v === 'string' && v.trim());
}

/**
 * 按绑定表改写参数：actor 工具注入 __actorSessionId；self 工具强制 sessionId=调用方会话
 * （丢弃 externalSessionId，防改他人会话）；其余工具剥掉模型伪造的 __actorSessionId。
 * ui.notify 另按绑定会话补全 workspaceId/sessionName。
 */
export function bindWorkerToolArgs(
  ctx: BindingSessionLookup,
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  sessionId: string
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) };
  delete out[ACTOR_SESSION_ID_ARG];
  delete out.__browserOwner;
  const binding = hostToolBinding(toolName);
  if (binding === 'actor') {
    out[ACTOR_SESSION_ID_ARG] = sessionId;
  } else if (binding === 'self') {
    out.sessionId = sessionId;
    delete out.externalSessionId;
  }
  // All browser calls carry the authenticated actor, including background selection/cookies.
  // Never infer this identity from the currently visible chat or model-supplied arguments.
  if (toolName.startsWith('browser.')) {
    const s = ctx.sessions.get(sessionId);
    if (s) out.__browserOwner = { ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}), sessionId };
  }
  if (toolName === 'ui.notify') {
    const s = ctx.sessions.get(sessionId);
    if (s) {
      if (isBlank(out.workspaceId)) out.workspaceId = s.workspaceId ?? '';
      if (isBlank(out.sessionName)) out.sessionName = s.name;
    }
  }
  return out;
}
