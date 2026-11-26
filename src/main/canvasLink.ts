/** Free-canvas fork and programmatic handover preparation. */
import { app } from 'electron';
import { t } from '../shared/i18n';
import { localizeGuiForkError } from '../shared/guiHostError';
import { forkSupportOf } from '../shared/forkCapability';
import { runtimeSurface, type SessionMeta } from '../shared/types';
import type { AppContext } from './context';
import { handle } from './ipc/handle';
import { discardHandoverDraft, prepareCanvasHandover } from './handover/documents';
import { localizeSessionUserOperation } from './sessions/userErrors';

function supportOf(ctx: AppContext, session: SessionMeta) {
  const entry = session.runtime ? ctx.runtimes.get(session.runtime) : undefined;
  return forkSupportOf(session.runtime, runtimeSurface(entry));
}

async function forkGui(ctx: AppContext, source: SessionMeta, name: string): Promise<SessionMeta> {
  const host = ctx.agentSessions;
  if (!host) throw new Error(t('GUI 会话宿主未就绪'));
  host.open(source);
  if (host.messageCount(source.id) === 0) {
    return ctx.sessions.createTerminal({
      runtime: source.runtime,
      cwd: source.cwd,
      workspaceId: source.workspaceId,
      sourceSessionId: source.id,
      name,
      activate: false,
      injectHostIntro: false,
      inheritSourceGuiConfig: true
    });
  }
  const result = await host.forkSession(source.id, undefined, { name, activate: false });
  if (!result.ok || !result.sessionId) throw new Error(result.error ? localizeGuiForkError(result.error) : t('fork 失败'));
  const created = ctx.sessions.get(result.sessionId);
  if (!created) throw new Error(t('fork 失败'));
  return created;
}

async function forkClaude(ctx: AppContext, source: SessionMeta, name: string): Promise<SessionMeta> {
  const sourceCli = source.externalSessionId?.trim();
  if (!sourceCli) throw new Error(t('源会话还没有 CLI 会话 id，无法 fork'));
  const cfg = ctx.config.get();
  const cwd = source.cwd?.trim() || cfg.workspaces?.find(w => w.id === (source.workspaceId ?? cfg.activeWorkspaceId))?.path || cfg.workspace;
  if (!(await ctx.runtimes.canResume(source.runtime ?? 'claude-code', cwd, sourceCli))) {
    throw new Error(t('源 CLI 会话记录不存在，无法 fork（可能已被清理）'));
  }
  return ctx.sessions.createTerminal({
    runtime: source.runtime,
    ...(source.cliLaunchOptions ? { cliLaunchOptions: { ...source.cliLaunchOptions } } : {}),
    cwd: source.cwd,
    workspaceId: source.workspaceId,
    sourceSessionId: source.id,
    name,
    activate: false,
    injectHostIntro: false,
    forkFromExternalSessionId: sourceCli
  });
}

export function registerCanvasLinkIpc(ctx: AppContext): void {
  handle('sessions:canvasFork', async (_event, sourceId: string) => {
    const source = ctx.sessions.get(String(sourceId ?? ''));
    if (!source || source.hidden) throw new Error(t('会话不存在: {{id}}', { id: sourceId }));
    const support = supportOf(ctx, source);
    const name = t('{{name}} ·fork', { name: source.name });
    if (support === 'gui') return { session: await localizeSessionUserOperation(() => forkGui(ctx, source, name)) };
    if (support === 'claude') return { session: await localizeSessionUserOperation(() => forkClaude(ctx, source, name)) };
    throw new Error(t('该类型暂不支持'));
  });

  handle('sessions:canvasHandover', async (_event, sourceId: string) => {
    const source = ctx.sessions.get(String(sourceId ?? ''));
    if (!source || source.hidden) throw new Error(t('会话不存在: {{id}}', { id: sourceId }));
    if (supportOf(ctx, source) === 'none') throw new Error(t('该类型暂不支持'));
    return localizeSessionUserOperation(() => prepareCanvasHandover(ctx, source, app.getPath('userData')));
  });

  handle('sessions:canvasHandoverCancel', async (_event, draftId: string) => {
    await localizeSessionUserOperation(() => discardHandoverDraft(app.getPath('userData'), String(draftId ?? '')));
    return { ok: true };
  });
}
