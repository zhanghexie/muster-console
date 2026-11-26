/**
 * GUI（chat surface）Worker 会话 IPC：与调度 agent:* 频道分开。
 * 审批响应只经 respondApproval 送达主进程；渲染层不改本地消息状态。
 */
import { handle, ipcCaller, type IpcCaller } from './handle';
import { registerHistorySearchIpc } from './chatSearch';
import { listModelRequests, readModelRequest, readCompressionTrace, recordingToken, setModelRequestRecording } from '../agentSession/modelRequestStore';
import { publishModelRequestRecording } from '../agentSession/modelRequestEvents';
import { readModelRequestSource } from '../agentSession/modelRequestSource';
import { writeModelRequestExport } from '../agentSession/modelRequestExport';
import { modelRequestSchedulerWorkspace, type ModelRequestExportResult } from '../../shared/modelRequest';
import type { AppContext } from '../context';
import { t } from '../../shared/i18n';
import { app, BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { prepareGuiInput } from '../attachments/guiInput';
import { getChatCapabilities, isChatRuntimeId } from '../../shared/agentRuntimeCapabilities';
import { probeClaudeGuiStatus } from '../agentSession/drivers/claude/status';
import { listClaudeModels } from '../agentSession/drivers/claude/models';
import { listCodexModels } from '../agentSession/drivers/codex/models';
import { listTaskCodexModels } from '../agentSession/drivers/codex/taskModels';
import { boundedAcpRequest, listAcpModels, type AcpModelListResult } from '../agentSession/drivers/acp/models';
import { BoundedAcpRequestError } from '../agentSession/processReclamation';
import { defaultAcpAgentId, getAcpPresets } from '../agentSession/drivers/acp/agents';
import { listExternalPiModels } from '../agentSession/drivers/externalPi/models';
import { listZCodeModels } from '../agentSession/drivers/zcode/process';
import { listMuseModels } from '../agentSession/drivers/muse/process';
import { captureSessionHarnessModelExpected, sameSessionHarnessModelExpected, type SessionHarnessModelExpected } from '../agentSession/harnessModelIdentity';
import { assertSessionTargetCurrent, resolveSessionTarget, type SessionTargetInput } from '../sessions/targets';
import { registerTurnChangesIpc } from '../turnChanges/ipc';
import { collectEnvSecrets, redactSafetyText } from '../safety/redact';
import { sourcePathKey, sourceRootsFor } from '../workspacePaths';
import { isPathInsideWorkspace } from '../git/scan';
import { HarnessModelSelectionStore } from '../agentSession/harnessModelSelectionStore';
import { HARNESS_CATALOG } from '../../shared/harnessCatalog';
import { refreshHarnessCatalogs } from '../agentSession/refreshHarnessCatalogs';
import type { HarnessCatalogRefreshResult } from '../../shared/harnessCatalogRefresh';
import type { HarnessPickerRequest, HarnessPickerResult, SetModelConfigurationInput, SetModelConfigurationResult } from '../../shared/harnessPicker';
import { listHarnessPickerChoices, readHarnessPickerCatalog, setPickerModelConfiguration } from '../agentSession/harnessPickerCatalog';
import { modelCatalogDirectory, assertModelCatalogSourceCurrent, resolveSessionModelSource } from '../agentSession/harnessCatalogSource';

export function registerAgentSessionIpc(ctx: AppContext): void {
  registerTurnChangesIpc(ctx);
  // Only this IPC's own deadline is localized; an identical upstream error is data.
  const boundedCatalogRequest = async <T>(promise: Promise<T>, label: string, signal: AbortSignal): Promise<T> => {
    try { return await boundedAcpRequest(promise, 5000, label, signal); }
    catch (error) {
      if (error instanceof BoundedAcpRequestError && error.label === label) {
        const operation = t(label);
        throw new Error(error.reason === 'timeout' ? t('{{operation}} 超时', { operation }) : t('{{operation}} 已取消', { operation }), { cause: error });
      }
      throw error;
    }
  };
  const modelSelections = new HarnessModelSelectionStore(app.getPath('userData'));
  const harnessModelRequests = new Map<string, AbortController>();
  let catalogBatch: AbortController | undefined;
  const modelCatalogEnabled = (runtimeId: string, agentId: string | undefined, cliRuntimeId: unknown): boolean => {
    if (cliRuntimeId === undefined) return ctx.runtimes.get(runtimeId)?.enabled === true;
    if (typeof cliRuntimeId !== 'string') return false;
    const cli = ctx.runtimes.get(cliRuntimeId);
    return !!cli?.enabled && (cli.surface ?? 'pty') === 'pty' && (
      (runtimeId === 'acp' && cli.manifest?.chat !== undefined && cli.manifest.id === agentId) ||
      HARNESS_CATALOG.some(entry => entry.runtimeId === runtimeId &&
        entry.cliRuntimeId === cliRuntimeId && (runtimeId !== 'acp' || entry.acpPresetId === agentId)));
  };
  const safeModelError = (message: string): string => redactSafetyText(message, collectEnvSecrets(process.env)).slice(0, 800);
  type CatalogTarget = { workspaceId: string; cwd: string; sourceRoot: { rootId: string } };
  const notifyModelCatalogUpdated = (runtimeId: string, target: CatalogTarget, agentId?: string, requestId?: string): void => {
    try {
      ctx.getWindow()?.webContents.send('agentSession:modelCatalogUpdated', {
        runtimeId, agentId, workspaceId: target.workspaceId, rootId: target.sourceRoot.rootId, cwd: target.cwd,
        ...(requestId ? { requestId } : {})
      });
    } catch (error) { console.warn('[agentSession] model catalog notification failed:', (error as Error).message || String(error)); }
  };
  const modelExecutable = (id: 'claude' | 'pi-external' | 'omp' | 'muse-gui' | 'zcode-gui'): string | undefined => {
    if (id === 'claude') return undefined;
    const value: unknown = id === 'pi-external' || id === 'omp'
      ? ctx.config.get().externalPi?.[id]?.executable : ctx.config.get().externalHarness?.[id]?.executable;
    if (value !== undefined && typeof value !== 'string') throw new Error(t('外部引擎配置无效'));
    return value;
  };
  const finishModelError = (result: Extract<AcpModelListResult, { ok: false }>, controller: AbortController, caller: IpcCaller, cancelled: () => string) => {
    const detail = safeModelError(result.error);
    const callerGone = !caller.isAlive();
    if (result.cleanupFailed) {
      console.error('[agentSession] model discovery cleanup failed:', detail);
      if (callerGone) {
        try { ctx.ui.notify(t('模型探测进程回收失败'), detail); }
        catch (error) { console.error('[agentSession] cleanup notification failed:', safeModelError((error as Error).message || String(error))); }
      }
    }
    return { ok: false as const, error: controller.signal.aborted || callerGone ? `${cancelled()}：${detail}` : detail,
      ...(result.cleanupFailed ? { cleanupFailed: true as const } : {}) };
  };
  handle(
    'agentSession:send',
    async (
      _e,
      args: {
        sessionId: string;
        text: string;
        images?: Array<{ data: string; mimeType: string; name?: string; sourcePath?: string }>;
        /** 忙时是否优先插话（steer）；缺省 true。聊天输入框普通发送传 false（忙时排队） */
        steerOnBusy?: boolean;
      }
    ) => {
      if (!ctx.agentSessions) return { ok: false, error: t('GUI 会话宿主未就绪') };
      const session = ctx.sessions.get(String(args?.sessionId ?? ''));
      if (!session) return { ok: false, error: t('会话不存在') };
      // Record user acceptance before attachment processing can yield. A stop
      // during conversion must not turn the older message into a new instruction.
      const desktopMessageId = ctx.desktopTurns ? randomUUID() : undefined;
      if (desktopMessageId) ctx.desktopTurns!().noteUserInstruction(session.id, desktopMessageId);
      // 自动命名用用户原文（附件处理会改写 text，名字该反映用户敲的字）
      const rawInputText = String(args?.text ?? '');
      try {
        const prepared = await prepareGuiInput(ctx, session, rawInputText, args.images);
        args = { ...args, text: prepared.text, images: prepared.images };
      } catch (error) { return { ok: false, error: (error as Error).message }; }
      const currentSession = ctx.sessions.get(session.id);
      if (!currentSession) return { ok: false, error: t('会话已删除') };
      // A visible chat surface may still be cold after browsing, or its host
      // lifecycle marker may have been released during a view transition.
      // Re-open at the user-send boundary before materializing execution state.
      try { ctx.agentSessions.open(currentSession); }
      catch (error) { return { ok: false, error: (error as Error).message || String(error) }; }
      const activitySession = ctx.sessions.get(String(args?.sessionId ?? ''));
      if (activitySession) ctx.usage.recordSessionActivity(activitySession.id, {
        name: activitySession.name || activitySession.id,
        runtime: activitySession.runtime || 'unknown', workspaceId: activitySession.workspaceId || '' });
      ctx.usage.recordGuiWorkerSend();
      // 图片按 driver 能力拦截（supportsImages；形状在 Host 校验）
      const result = await ctx.agentSessions.send(
        String(args?.sessionId ?? ''),
        String(args?.text ?? ''),
        args?.images,
        { steerOnBusy: args?.steerOnBusy !== false,
          ...(desktopMessageId ? { messageId: desktopMessageId, desktopPreaccepted: true } : {}) }
      );
      // 默认名空会话：首条用户指令受理即自动命名（排队/插话受理同属首条指令）
      if (result?.ok && !result.steerUnsupported) ctx.sessions.autoNameFromInstruction(session.id, rawInputText);
      return result;
    }
  );
  handle('agentSession:abort', (_e, raw: string | { sessionId?: string; holdQueue?: boolean }) => {
    if (!ctx.agentSessions) return;
    const args = typeof raw === 'string' ? { sessionId: raw } : (raw ?? {});
    return ctx.agentSessions.abort(String(args.sessionId ?? ''), { holdQueue: args.holdQueue === true });
  });
  handle('agentSession:retry', (_e, sessionId: string) => {
    if (!ctx.agentSessions) return { ok: false, error: t('GUI 会话宿主未就绪') };
    return ctx.agentSessions.retry(String(sessionId ?? ''));
  });
  handle(
    'agentSession:recallAborted',
    (_e, args: { sessionId: string; messageId?: string }) => {
      if (!ctx.agentSessions) return { ok: false, error: t('GUI 会话宿主未就绪') };
      return ctx.agentSessions.recallAborted(
        String(args?.sessionId ?? ''),
        args?.messageId ? String(args.messageId) : undefined
      );
    }
  );
  handle(
    'agentSession:compact',
    (_e, args: { sessionId: string; instructions?: string }) =>
      ctx.agentSessions
        ? ctx.agentSessions.compactSession(
            String(args?.sessionId ?? ''),
            args?.instructions ? String(args.instructions) : undefined
          )
        : Promise.resolve({ ok: false, error: t('GUI 会话宿主未就绪') })
  );
  handle(
    'agentSession:respondApproval',
    (_e, args: { sessionId: string; approvalId: string; approved?: boolean; reason?: string; nativeChoiceId?: string }) => {
      if (!ctx.agentSessions) return { ok: false };
      const ok = ctx.agentSessions.respondApproval(
        String(args?.sessionId ?? ''),
        String(args?.approvalId ?? ''),
        !!args?.approved,
        args?.reason ? String(args.reason) : undefined,
        typeof args?.nativeChoiceId === 'string' ? args.nativeChoiceId : undefined
      );
      return { ok };
    }
  );
  handle(
    'agentSession:respondUserQuestion',
    (_e, args: {
      sessionId: string;
      questionId: string;
      action: 'answer' | 'abort';
      answers?: Array<{ id: string; selected: string[]; custom?: string }>;
    }) =>
      ctx.agentSessions
        ? {
            ok: ctx.agentSessions.respondUserQuestion(
              String(args?.sessionId ?? ''),
              String(args?.questionId ?? ''),
              args?.action === 'abort' ? 'abort' : 'answer',
              args?.answers
            )
          }
        : { ok: false }
  );
  handle(
    'agentSession:setMode',
    (_e, args: { sessionId: string; mode: import('../../shared/types').GuiWorkerMode }) =>
      ctx.agentSessions
        ? ctx.agentSessions.setMode(String(args?.sessionId ?? ''), args?.mode)
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle('agentSession:listPiModes', () =>
    ctx.agentSessions ? ctx.agentSessions.listPiModes() : null
  );
  handle('agentSession:getHarnessModelSelections', () => (ctx.agentSessions?.modelAdmission?.selections ?? modelSelections).read());
  handle('agentSession:setHarnessModelSelection', (_event, args: { key: string; modelIds: string[] | null }) => {
    const saved = (ctx.agentSessions?.modelAdmission?.selections ?? modelSelections).update(args?.key, args?.modelIds);
    try { ctx.getWindow()?.webContents.send('agentSession:harnessModelSelectionsChanged', { key: args.key, selections: saved }); }
    catch (error) { console.warn('[agentSession] model selection notification failed:', error); }
    return saved;
  });
  handle('agentSession:listAcpAgents', () =>
    ctx.agentSessions ? ctx.agentSessions.listAcpAgents() : null
  );
  handle('agentSession:refreshHarnessModelCatalogs', async (event, requestId: string): Promise<HarnessCatalogRefreshResult> => {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) {
      return { ok: false, error: t('模型发现请求缺少会话来源或引擎') };
    }
    if (catalogBatch) return { ok: false, error: t('正在刷新模型目录') };
    const caller = ipcCaller(event);
    const controller = new AbortController();
    catalogBatch = controller;
    const timer = setInterval(() => { if (!caller.isAlive()) controller.abort(); }, 1000);
    timer.unref?.();
    const send = (channel: string, payload: unknown): void => {
      if (controller.signal.aborted || !caller.isAlive()) return;
      try { ctx.getWindow()?.webContents.send(channel, payload); }
      catch (error) { console.warn('[agentSession] catalog refresh event failed:', safeModelError((error as Error).message)); }
    };
    try {
      const result = await refreshHarnessCatalogs(ctx, app.getPath('userData'), controller.signal, {
        availability: () => send('runtimes:availabilityChanged', {}),
        catalogs: (workspace, rows) => send('agentSession:harnessCatalogRefreshProgress', { requestId, kind: 'catalogs', workspace, rows }),
        progress: row => send('agentSession:harnessCatalogRefreshProgress', { requestId, kind: 'progress', row }),
        updated: (runtimeId, target, agentId) => notifyModelCatalogUpdated(runtimeId, target, agentId)
      });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: safeModelError((error as Error).message || String(error)) };
    } finally {
      clearInterval(timer);
      if (catalogBatch === controller) catalogBatch = undefined;
    }
  });
  handle('agentSession:listAcpModels', async (event, args: { source?: SessionTargetInput; agentId?: string; requestId?: string; modelId?: string; refresh?: boolean; cliRuntimeId?: string }) => {
    const caller = ipcCaller(event);
    const requestId = typeof args?.requestId === 'string' ? args.requestId : '';
    const agentId = typeof args?.agentId === 'string' ? args.agentId.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId) || !agentId || !args?.source?.workspaceId || !args.source.rootId)
      return { ok: false as const, error: t('模型发现请求缺少会话来源或引擎') };
    const prefix = `${caller.id}\0`;
    const key = `${prefix}${requestId}`;
    if (harnessModelRequests.has(key)) return { ok: false as const, error: t('模型发现请求已存在') };
    if ([...harnessModelRequests.keys()].filter(candidate => candidate.startsWith(prefix)).length >= 4)
      return { ok: false as const, error: t('模型发现请求过多，请稍后重试') };
    const controller = new AbortController();
    harnessModelRequests.set(key, controller);
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    deadline.unref?.();
    const cancelled = (): string => timedOut ? t('模型发现超时，请重试') : t('模型发现已取消');
    const aliveCheck = setInterval(() => { if (!caller.isAlive()) controller.abort(); }, 1000);
    aliveCheck.unref?.();
    try {
      const target = await boundedCatalogRequest(resolveSessionTarget(ctx.config.get(), args.source), '运行目录检查', controller.signal);
      assertSessionTargetCurrent(ctx.config.get(), target);
      if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
      if (!ctx.agentSessions || !modelCatalogEnabled('acp', agentId, args.cliRuntimeId)) return { ok: false as const, error: t('ACP 引擎未启用') };
      if (args.refresh === true) {
        const probe = await boundedCatalogRequest(ctx.agentSessions.probeRuntime('acp', agentId), 'ACP 检测', controller.signal);
        if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
        if (probe.status !== 'available') return { ok: false as const, error: probe.problems?.map(problem => problem.message).join('；') || t('ACP 引擎不可用') };
      }
      assertSessionTargetCurrent(ctx.config.get(), target);
      const modelId = typeof args.modelId === 'string' && args.modelId.length <= 512 ? args.modelId : undefined;
      const result = await listAcpModels({ cwd: target.cwd, agentId, userDataDir: app.getPath('userData'), signal: controller.signal, modelId, refresh: args.refresh === true });
      if (!result.ok) {
        return finishModelError(result, controller, caller, cancelled);
      }
      assertSessionTargetCurrent(ctx.config.get(), target);
      if (!modelCatalogEnabled('acp', agentId, args.cliRuntimeId)) throw new Error(t('ACP 引擎未启用'));
      if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
      if (args.refresh === true) notifyModelCatalogUpdated('acp', target, agentId, requestId);
      return result;
    } catch (error) {
      return { ok: false as const, error: controller.signal.aborted ? cancelled() : (error as Error).message || String(error) };
    } finally {
      clearTimeout(deadline);
      clearInterval(aliveCheck);
      if (harnessModelRequests.get(key) === controller) harnessModelRequests.delete(key);
    }
  });
  handle('agentSession:listLocalHarnessModels', async (event, args: { source?: SessionTargetInput; runtimeId?: string; requestId?: string; refresh?: boolean; cliRuntimeId?: string }) => {
    const caller = ipcCaller(event);
    const requestId = typeof args?.requestId === 'string' ? args.requestId : '';
    const runtimeId = args?.runtimeId;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId) || (runtimeId !== 'claude' && runtimeId !== 'pi-external' && runtimeId !== 'omp' && runtimeId !== 'zcode-gui' && runtimeId !== 'muse-gui') || !args?.source?.workspaceId || !args.source.rootId)
      return { ok: false as const, error: t('模型发现请求缺少会话来源或引擎') };
    const prefix = `${caller.id}\0`, key = `${prefix}${requestId}`;
    if (harnessModelRequests.has(key)) return { ok: false as const, error: t('模型发现请求已存在') };
    if ([...harnessModelRequests.keys()].filter(candidate => candidate.startsWith(prefix)).length >= 4)
      return { ok: false as const, error: t('模型发现请求过多，请稍后重试') };
    const controller = new AbortController();
    harnessModelRequests.set(key, controller);
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    deadline.unref?.();
    const cancelled = (): string => timedOut ? t('模型发现超时，请重试') : t('模型发现已取消');
    const aliveCheck = setInterval(() => { if (!caller.isAlive()) controller.abort(); }, 1000);
    aliveCheck.unref?.();
    try {
      const externalId = runtimeId === 'pi-external' || runtimeId === 'omp' ? runtimeId : undefined;
      const executableOverride = modelExecutable(runtimeId);
      const target = await boundedCatalogRequest(resolveSessionTarget(ctx.config.get(), args.source), '运行目录检查', controller.signal);
      assertSessionTargetCurrent(ctx.config.get(), target);
      if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
      if (!ctx.agentSessions || !modelCatalogEnabled(runtimeId, undefined, args.cliRuntimeId)) return { ok: false as const, error: t('外部引擎未启用') };
      const driverVersion = ctx.agentSessions.getDriver(runtimeId)?.connectionVersion;
      if (args.refresh === true) {
        const probe = await boundedCatalogRequest(ctx.agentSessions.probeRuntime(runtimeId), '外部引擎检测', controller.signal);
        if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
        if (probe.status !== 'available') return { ok: false as const, error: probe.problems?.map(problem => problem.message).join('；') || t('外部引擎不可用') };
      }
      assertSessionTargetCurrent(ctx.config.get(), target);
      if (modelExecutable(runtimeId) !== executableOverride) throw new Error(t('引擎程序路径在读取期间变化，请重试'));
      const result = runtimeId === 'claude' ? await listClaudeModels({ cwd: target.cwd, userDataDir: app.getPath('userData'),
        isolateConfig: args.cliRuntimeId === undefined && ctx.config.get().claude?.isolateConfig === true, signal: controller.signal, refresh: args.refresh === true })
        : externalId ? await listExternalPiModels({ cwd: target.cwd, runtimeId: externalId, executableOverride, signal: controller.signal, refresh: args.refresh === true })
        : runtimeId === 'muse-gui' ? await listMuseModels({ cwd: target.cwd, executableOverride, signal: controller.signal, refresh: args.refresh === true })
          : await listZCodeModels({ cwd: target.cwd, executableOverride, signal: controller.signal, refresh: args.refresh === true });
      if (!result.ok) {
        return finishModelError(result, controller, caller, cancelled);
      }
      assertSessionTargetCurrent(ctx.config.get(), target);
      if (!modelCatalogEnabled(runtimeId, undefined, args.cliRuntimeId)) throw new Error(t('外部引擎未启用'));
      if (runtimeId === 'claude' && ctx.agentSessions?.getDriver(runtimeId)?.connectionVersion !== driverVersion) throw new Error(t('Claude 配置在读取期间变化，请重试'));
      if (modelExecutable(runtimeId) !== executableOverride) throw new Error(t('引擎程序路径在读取期间变化，请重试'));
      if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
      if (args.refresh === true) notifyModelCatalogUpdated(runtimeId, target, undefined, requestId);
      return result;
    } catch (error) {
      return { ok: false as const, error: controller.signal.aborted ? cancelled() : (error as Error).message || String(error) };
    } finally {
      clearTimeout(deadline);
      clearInterval(aliveCheck);
      if (harnessModelRequests.get(key) === controller) harnessModelRequests.delete(key);
    }
  });
  handle('agentSession:getSessionHarnessModelState', (_e, sessionId: string) => {
    try {
      const session = ctx.sessions.get(String(sessionId ?? ''));
      if (!session || session.archived || session.launchKind === 'shell' || !ctx.agentSessions) throw new Error(t('会话不存在或不支持读取模型目录'));
      const driver = ctx.agentSessions.getDriver(session.runtime ?? '');
      if (!driver) throw new Error(t('外部引擎不可用'));
      return { ok: true as const, expected: captureSessionHarnessModelExpected(session, app.getPath('userData'), driver.connectionVersion) };
    } catch (error) { return { ok: false as const, error: safeModelError((error as Error).message || String(error)) }; }
  });
  handle('agentSession:listSessionHarnessModels', async (event, args: { sessionId?: string; requestId?: string; expected?: SessionHarnessModelExpected; refresh?: boolean }) => {
    const caller = ipcCaller(event);
    const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
    const requestId = typeof args?.requestId === 'string' ? args.requestId : '';
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) return { ok: false as const, error: t('模型发现请求缺少会话来源或引擎') };
    const prefix = `${caller.id}\0`, key = `${prefix}${requestId}`;
    if (harnessModelRequests.has(key)) return { ok: false as const, error: t('模型发现请求已存在') };
    if ([...harnessModelRequests.keys()].filter(candidate => candidate.startsWith(prefix)).length >= 4)
      return { ok: false as const, error: t('模型发现请求过多，请稍后重试') };
    const controller = new AbortController();
    harnessModelRequests.set(key, controller);
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    const aliveCheck = setInterval(() => { if (!caller.isAlive()) controller.abort(); }, 1000);
    deadline.unref?.(); aliveCheck.unref?.();
    const cancelled = (): string => timedOut ? t('模型发现超时，请重试') : t('模型发现已取消');
    try {
      const session = ctx.sessions.get(sessionId);
      const runtimeId = session?.runtime;
      if (!session || session.archived || session.launchKind === 'shell' || !session.cwd ||
        (runtimeId !== 'acp' && runtimeId !== 'claude' && runtimeId !== 'pi-external' && runtimeId !== 'omp' && runtimeId !== 'muse-gui' && runtimeId !== 'zcode-gui')) {
        throw new Error(t('会话不存在或不支持读取模型目录'));
      }
      if (!ctx.agentSessions || !args.expected || !sameSessionHarnessModelExpected(session, app.getPath('userData'), args.expected, ctx.agentSessions.getDriver(runtimeId)?.connectionVersion)) {
        throw new Error(t('会话配置在模型读取期间变化，请重试'));
      }
      const stamp = JSON.stringify([session.runtime, session.piModeId, session.cwd, session.workspaceId, session.sourceRoot, session.worktreeGroups, session.modelOverride, session.archived]);
      const checkCurrent = (): void => {
        const current = ctx.sessions.get(sessionId);
        if (!current || !ctx.agentSessions || stamp !== JSON.stringify([current.runtime, current.piModeId, current.cwd, current.workspaceId, current.sourceRoot, current.worktreeGroups, current.modelOverride, current.archived]) ||
          !sameSessionHarnessModelExpected(current, app.getPath('userData'), args.expected!, ctx.agentSessions.getDriver(runtimeId)?.connectionVersion))
          throw new Error(t('会话配置在模型读取期间变化，请重试'));
      };
      const config = ctx.config.get();
      const target = await boundedCatalogRequest(resolveSessionModelSource(config, session), '运行目录检查', controller.signal);
      checkCurrent(); assertSessionTargetCurrent(ctx.config.get(), target);
      const catalogCwd = target.sourceRoot.cwd;
      if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
      const agentId = runtimeId === 'acp' ? args.expected.agentId : undefined;
      const externalId = runtimeId === 'pi-external' || runtimeId === 'omp' ? runtimeId : undefined;
      const executableOverride = runtimeId !== 'acp' ? modelExecutable(runtimeId) : undefined;
      if (!ctx.agentSessions) throw new Error(t('GUI 会话宿主未就绪'));
      if (args.refresh === true) {
        const probe = await boundedCatalogRequest(ctx.agentSessions.probeRuntime(runtimeId, agentId), '外部引擎检测', controller.signal);
        checkCurrent(); assertSessionTargetCurrent(ctx.config.get(), target);
        if (probe.status !== 'available') return { ok: false as const, error: probe.problems?.map(problem => problem.message).join('；') || t('外部引擎不可用') };
      }
      if (runtimeId !== 'acp' && modelExecutable(runtimeId) !== executableOverride) throw new Error(t('引擎程序路径在读取期间变化，请重试'));
      const result = runtimeId === 'claude' ? await listClaudeModels({ cwd: catalogCwd, userDataDir: app.getPath('userData'),
        isolateConfig: ctx.config.get().claude?.isolateConfig === true, signal: controller.signal, refresh: args.refresh === true })
        : runtimeId === 'acp' ? await listAcpModels({ cwd: catalogCwd, agentId: agentId!, userDataDir: app.getPath('userData'), signal: controller.signal, modelId: session.modelOverride?.modelId, refresh: args.refresh === true })
        : externalId ? await listExternalPiModels({ cwd: catalogCwd, runtimeId: externalId, executableOverride, signal: controller.signal, refresh: args.refresh === true })
          : runtimeId === 'muse-gui' ? await listMuseModels({ cwd: catalogCwd, executableOverride, signal: controller.signal, refresh: args.refresh === true }) : await listZCodeModels({ cwd: catalogCwd, executableOverride, signal: controller.signal, refresh: args.refresh === true });
      if (!result.ok) {
        return finishModelError(result, controller, caller, cancelled);
      }
      checkCurrent(); assertSessionTargetCurrent(ctx.config.get(), target);
      if (runtimeId !== 'acp' && modelExecutable(runtimeId) !== executableOverride) throw new Error(t('引擎程序路径在读取期间变化，请重试'));
      if (runtimeId === 'acp' && defaultAcpAgentId(session.piModeId, getAcpPresets(app.getPath('userData'))) !== agentId) throw new Error(t('ACP 引擎在模型读取期间变化，请重试'));
      if (controller.signal.aborted || !caller.isAlive()) return { ok: false as const, error: cancelled() };
      const beforeParameters = JSON.stringify(ctx.sessions.get(sessionId)?.modelParameters ?? null);
      if (args.refresh === true) await ctx.agentSessions.reconcileModelParameters(sessionId);
      const parametersChanged = beforeParameters !== JSON.stringify(ctx.sessions.get(sessionId)?.modelParameters ?? null);
      checkCurrent(); assertSessionTargetCurrent(ctx.config.get(), target);
      if (args.refresh === true) notifyModelCatalogUpdated(runtimeId, { ...target, cwd: catalogCwd }, agentId, requestId);
      return { ...result, runtimeId, ...(agentId ? { agentId } : {}), ...(parametersChanged ? { warning: t('已清除当前模型不支持的参数') } : {}) };
    } catch (error) {
      return { ok: false as const, error: controller.signal.aborted ? cancelled() : safeModelError((error as Error).message || String(error)) };
    } finally {
      clearTimeout(deadline); clearInterval(aliveCheck);
      if (harnessModelRequests.get(key) === controller) harnessModelRequests.delete(key);
    }
  });
  handle('agentSession:cancelHarnessModels', (event, requestId: string) => {
    const caller = ipcCaller(event);
    const key = `${caller.id}\0${typeof requestId === 'string' ? requestId : ''}`;
    const controller = harnessModelRequests.get(key);
    if (!controller) return { ok: false };
    controller.abort();
    return { ok: true };
  });
  handle('agentSession:listHarnessPickerChoices', () => listHarnessPickerChoices(ctx));
  handle('agentSession:readHarnessPickerCatalog', async (event, request: HarnessPickerRequest): Promise<HarnessPickerResult> => {
    const caller = ipcCaller(event);
    const id = request?.requestId;
    const scopes = request && [Object.hasOwn(request, 'sessionId'), Object.hasOwn(request, 'dispatch'), Object.hasOwn(request, 'source')].filter(Boolean).length;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || scopes !== 1) return { ok: false, error: t('模型发现请求缺少会话来源或引擎') };
    const prefix = `${caller.id}\0`, key = `${prefix}${id}`;
    if (harnessModelRequests.has(key) || [...harnessModelRequests.keys()].filter(candidate => candidate.startsWith(prefix)).length >= 4) {
      return { ok: false, error: t('模型发现请求过多，请稍后重试') };
    }
    const controller = new AbortController();
    harnessModelRequests.set(key, controller);
    const timeout = setTimeout(() => controller.abort(), request.refresh ? 30_000 : 10_000);
    const alive = setInterval(() => { if (!caller.isAlive()) controller.abort(); }, 1000);
    timeout.unref?.(); alive.unref?.();
    try {
      const result = await readHarnessPickerCatalog(ctx, request, controller.signal);
      if (!caller.isAlive() || controller.signal.aborted) throw new Error(t('模型发现已取消'));
      if (result.cleanupFailed) ctx.ui.notify(t('模型探测进程回收失败'), safeModelError(result.catalog.warning ?? ''));
      if (result.updated) {
        const source = result.catalog.source;
        notifyModelCatalogUpdated(result.updated.runtimeId, { ...source, sourceRoot: { rootId: source.rootId } }, result.updated.agentId, id);
      }
      return { ok: true, catalog: { ...result.catalog,
        ...(result.catalog.warning ? { warning: safeModelError(result.catalog.warning) } : {}),
        ...(result.catalog.parameterWarning ? { parameterWarning: safeModelError(result.catalog.parameterWarning) } : {}) } };
    } catch (error) { return { ok: false, error: controller.signal.aborted ? t('模型发现已取消') : safeModelError((error as Error).message || String(error)) }; }
    finally {
      clearTimeout(timeout); clearInterval(alive);
      if (harnessModelRequests.get(key) === controller) harnessModelRequests.delete(key);
    }
  });
  handle('agentSession:setModelConfiguration', async (_event, request: SetModelConfigurationInput): Promise<SetModelConfigurationResult> => {
    try { return await setPickerModelConfiguration(ctx, request); }
    catch (error) { return { ok: false, error: safeModelError((error as Error).message || String(error)) }; }
  });
  handle('claude:status', () => probeClaudeGuiStatus(ctx, app.getPath('userData')));
  handle('codex:listModels', async (_e, args: { sessionId?: string; source?: import('../sessions/targets').SessionTargetInput; refresh?: boolean }) => {
    if (args?.source) {
      const { workspaceId, rootId, rootsRevision, cwd } = args.source;
      return listTaskCodexModels(() => ctx.config.get(), { workspaceId, rootId, rootsRevision, cwd }, args.refresh === true, listCodexModels,
        target => { if (args.refresh === true) notifyModelCatalogUpdated('codex-gui', target); });
    }
    const session = ctx.sessions.get(String(args?.sessionId ?? ''));
    if (session?.runtime !== 'codex-gui' || !session.cwd) return { ok: false, error: t('Codex 会话不存在或缺少工作目录') };
    try {
      const target = await resolveSessionModelSource(ctx.config.get(), session);
      const physicalCwd = modelCatalogDirectory(target.sourceRoot.cwd);
      const result = await listCodexModels(target.sourceRoot.cwd, args?.refresh === true);
      assertModelCatalogSourceCurrent(ctx.config.get(), target, physicalCwd);
      if (result.ok && args.refresh === true) notifyModelCatalogUpdated('codex-gui', target);
      return result;
    } catch (error) { return { ok: false, error: safeModelError((error as Error).message || String(error)) }; }
  });
  handle(
    'agentSession:setModel',
    (
      _e,
      args: {
        sessionId: string;
        model: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null;
        expected?: SessionHarnessModelExpected;
      }
    ) =>
      ctx.agentSessions
        ? ctx.agentSessions.setSessionModel(
            String(args?.sessionId ?? ''),
            args?.model
              ? {
                  providerId: String(args.model.providerId ?? ''),
                  modelId: String(args.model.modelId ?? ''),
                  ...(args.model.params?.length ? { params: args.model.params } : {})
                }
              : null,
            args?.expected
          )
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle(
    'agentSession:setPiMode',
    (_e, args: { sessionId: string; modeId: string }) =>
      ctx.agentSessions
        ? ctx.agentSessions.setPiMode(String(args?.sessionId ?? ''), String(args?.modeId ?? ''))
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle(
    'agentSession:setThinking',
    (
      _e,
      args: { sessionId: string; level: import('../../shared/types').GuiThinkingLevel | null }
    ) =>
      ctx.agentSessions
        ? ctx.agentSessions.setThinkingLevel(String(args?.sessionId ?? ''), args?.level ?? null)
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle(
    'agentSession:planAction',
    (_e, args: { sessionId: string; action: 'execute' | 'abandon' }) =>
      ctx.agentSessions
        ? ctx.agentSessions.planAction(String(args?.sessionId ?? ''), args?.action ?? 'execute')
        : Promise.resolve({ ok: false, error: t('GUI 会话宿主未就绪') })
  );
  registerHistorySearchIpc('agentSession', (id, before, limit) => ctx.agentSessions?.getHistoryRange(id, before, limit) ?? null);
  const requestSession = (id: string): boolean => {
    if (typeof id !== 'string') return false;
    const workspaceId = modelRequestSchedulerWorkspace(id);
    if (workspaceId !== null) return !!ctx.orchestrator && ctx.workspaces.list().some(workspace => workspace.id === workspaceId);
    return getChatCapabilities(ctx.sessions.get(id)?.runtime ?? '').modelRequests === true;
  };
  handle('agentSession:modelRequestRecording', (_e, id: string) =>
    requestSession(id) && !!recordingToken(app.getPath('userData'), id));
  handle('agentSession:setModelRequestRecording', (_e, id: string, enabled: boolean) => {
    if (!requestSession(id) || typeof enabled !== 'boolean') throw new Error(t('当前会话不支持录制模型请求'));
    const current = setModelRequestRecording(app.getPath('userData'), id, enabled);
    publishModelRequestRecording(ctx, id, current);
    return current;
  });
  handle('agentSession:modelRequests', (_e, id: string, before?: number) =>
    requestSession(id) && (before == null || Number.isSafeInteger(before)) ? listModelRequests(app.getPath('userData'), id, before) : []);
  handle('agentSession:modelRequestBody', (_e, id: string, call: number) =>
    requestSession(id) && Number.isSafeInteger(call) && call > 0 ? readModelRequest(app.getPath('userData'), id, call) : null);
  handle('agentSession:exportModelRequests', async (event, id: string, call?: number): Promise<ModelRequestExportResult> => {
    if (!requestSession(id) || (call !== undefined && (!Number.isSafeInteger(call) || call <= 0)))
      return { ok: false, error: t('模型请求导出参数无效') };
    const owner = event?.sender && BrowserWindow.fromWebContents(event.sender);
    if (!owner) return { ok: false, error: t('请在桌面客户端导出模型请求') };
    try {
      const picked = await dialog.showSaveDialog(owner, {
        title: t('导出模型请求'),
        defaultPath: 'model-requests-' + id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) +
          (call === undefined ? '' : '-' + call) + '.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      if (!requestSession(id)) return { ok: false, error: t('暂无模型请求记录') };
      const result = writeModelRequestExport(app.getPath('userData'), id, picked.filePath, call);
      return { ok: true, path: picked.filePath, ...result };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const message = code === 'ENOENT' ? t('保存目录不存在，请重新选择导出位置')
        : ['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '') ? t('无法写入所选位置，请检查权限或文件占用')
        : code === 'ENOSPC' ? t('磁盘空间不足，无法导出模型请求')
        : ['EISDIR', 'ENOTDIR'].includes(code ?? '') ? t('导出路径不可用，请重新选择文件位置')
        : error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });
  handle('agentSession:modelRequestCompression', (_e, id: string, call: number) =>
    requestSession(id) && Number.isSafeInteger(call) ? readCompressionTrace(app.getPath('userData'), id, call)?.items ?? [] : []);
  handle('agentSession:modelRequestSource', (_e, id: string, call: number, source: string, offset: number) =>
    requestSession(id) && Number.isSafeInteger(call) && typeof source === 'string' && Number.isSafeInteger(offset) && offset >= 0
      ? readModelRequestSource(app.getPath('userData'), id, call, source, offset) : null);
  handle('agentSession:injectionDetails',(_e,sessionId:string,reference:import('../../shared/guiHistoryMetadata').GuiInjectionDetailRef)=>
    ctx.agentSessions?.injectionDetails(String(sessionId??''),reference)??{ok:false,error:t('GUI 会话宿主未就绪')});
  handle('agentSession:engineInput', (_e, sessionId: string, messageId: string, ref: string) =>
    typeof sessionId === 'string' && typeof messageId === 'string' && typeof ref === 'string'
      ? ctx.agentSessions?.engineInput(sessionId, messageId, ref) ?? null : null);
  handle('agentSession:metadataTimeline',(_e,sessionId:string,kind:import('../../shared/guiHistoryMetadata').GuiMetadataKind,before?:number|null,limit?:number|null)=>
    ctx.agentSessions?.metadataTimeline(String(sessionId??''),kind,before??undefined,limit??120)??{ok:false,error:t('GUI 会话宿主未就绪')});
  handle('agentSession:replayMaterial', (_e, sessionId: string, beforeMessageIds?: readonly string[]) => {
    const session = typeof sessionId === 'string' && ctx.sessions.get(sessionId);
    if (!session || !isChatRuntimeId(session.runtime ?? '') || !ctx.agentSessions) throw new Error('请选择一个 GUI 聊天会话');
    return ctx.agentSessions.store.replayMaterial(session.id, beforeMessageIds);
  });
  handle('agentSession:getHistoryRange', (_e, sessionId: string, before?: number, limit?: number, targetMessageId?: string) =>
    ctx.agentSessions
      ? ctx.agentSessions.getHistoryRange(String(sessionId ?? ''), before, limit, targetMessageId)
      : null
  );
  handle('agentSession:getModelParameters', (_e, sessionId: string) => ctx.agentSessions?.getModelParameters(String(sessionId)) ?? null);
  handle('agentSession:getNativeConfig', (_e, sessionId: string) => ctx.agentSessions?.getNativeConfig(String(sessionId)) ?? null);
  handle('agentSession:describeNativeConfig', async (event, args: { runtimeId: string; presetId?: string; source: SessionTargetInput; refresh?: boolean }) => {
    const host = ctx.agentSessions;
    if (!host || !args?.source || typeof args.runtimeId !== 'string' || !isChatRuntimeId(args.runtimeId) || args.runtimeId === 'pi') return null;
    const { workspaceId, rootId, rootsRevision, cwd } = args.source;
    if (typeof workspaceId !== 'string' || !workspaceId || typeof rootId !== 'string' || !rootId) return null;
    const source = await resolveSessionTarget(ctx.config.get(), { workspaceId, rootId, rootsRevision, cwd });
    if (args.runtimeId === 'acp' && (typeof args.presetId !== 'string' || !host.listAcpAgents()?.some(preset => preset.id === args.presetId))) return null;
    const result = await host.describeNativeConfig({ runtime: args.runtimeId, piModeId: args.presetId,
      cwd: source.cwd, workspaceId: source.workspaceId, sourceRoot: source.sourceRoot }, args.refresh === true);
    if (ctx.agentSessions !== host || !ipcCaller(event).isAlive()) return null;
    assertSessionTargetCurrent(ctx.config.get(), source);
    return result;
  });
  handle('agentSession:refreshNativeConfig', (_e, sessionId: string) => ctx.agentSessions?.refreshNativeConfig(String(sessionId)) ?? null);
  handle('agentSession:setNativeConfig', (_e, args: { sessionId: string; change: import('../../shared/nativeSessionConfig').NativeConfigChange }) =>
    ctx.agentSessions?.setNativeConfig(String(args?.sessionId ?? ''), args?.change) ?? { ok: false, error: t('GUI 会话宿主未就绪') });
  handle('agentSession:describeModelParameters', async (event, target: import('../agentSession/host/modelParameters').ParameterTarget & { source?: SessionTargetInput }) => {
    const host = ctx.agentSessions;
    if (!host) return null;
    // Pi, Cursor and trusted static manifests do not start a discovery process;
    // retain their existing settings behavior even when no workspace is open.
    if (!['claude', 'acp', 'codex-gui'].includes(target?.runtimeId)) return host.describeModelParameters(target);
    const failure = (message: string) => ({ runtimeId: target?.runtimeId ?? '', providerId: target?.providerId ?? target?.runtimeId ?? '',
      modelId: target?.modelId ?? '', parameters: [], unavailable: true, warning: safeModelError(message) });
    try {
      const config = ctx.config.get();
      const source = target.source;
      if (target.cwd !== undefined && (typeof target.cwd !== 'string' || !target.cwd.trim())) throw new Error(t('模型参数发现的工作目录无效'));
      if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source) ||
          typeof source.workspaceId !== 'string' || !source.workspaceId.trim() ||
          typeof source.rootId !== 'string' || !source.rootId.trim() ||
          (source.rootsRevision !== undefined && (!Number.isSafeInteger(source.rootsRevision) || source.rootsRevision < 0)) ||
          (source.cwd !== undefined && (typeof source.cwd !== 'string' || !source.cwd.trim())))) {
        throw new Error(t('模型参数发现缺少有效的工作区与源目录'));
      }
      if (target.cwd && source?.cwd && sourcePathKey(target.cwd) !== sourcePathKey(source.cwd)) throw new Error(t('模型参数发现的工作目录与来源不一致'));
      const cwd = target.cwd ?? source?.cwd;
      if (!source && cwd) {
        // A bare path must identify one registered root, including nested roots
        // and aliases; otherwise the caller must supply the source identity.
        const cwdKey = sourcePathKey(cwd);
        const matches = config.workspaces.flatMap(workspace => workspace.rootsError ? [] : sourceRootsFor(workspace)
          .filter(root => isPathInsideWorkspace(cwdKey, sourcePathKey(root.path)))
          .map(root => ({ workspaceId: workspace.id, rootId: root.id })));
        if (matches.length !== 1 || matches[0].workspaceId !== config.activeWorkspaceId) throw new Error(t('工作目录不能唯一归属于当前工作区，请选择源文件夹'));
      }
      // Only renderer-facing source fields are allowed here; capturedSource is
      // reserved for trusted task/session paths and must not pass through IPC.
      const sourceInput: SessionTargetInput = source ? { workspaceId: source.workspaceId, rootId: source.rootId,
        ...(source.rootsRevision !== undefined ? { rootsRevision: source.rootsRevision } : {}), ...(cwd ? { cwd } : {}) }
        : cwd ? { cwd } : {};
      const resolved = await resolveSessionTarget(config, sourceInput);
      const cwdKey = sourcePathKey(resolved.cwd);
      const driver = host.getDriver(target.runtimeId);
      const version = driver?.connectionVersion;
      const caller = ipcCaller(event);
      const checkCurrent = async (): Promise<void> => {
        if (!caller.isAlive() || ctx.agentSessions !== host) throw new Error(t('模型参数发现已取消'));
        const current = ctx.config.get();
        if (!source && current.activeWorkspaceId !== resolved.workspaceId) throw new Error(t('当前工作区已变化，请重试'));
        assertSessionTargetCurrent(current, resolved);
        const fresh = await resolveSessionTarget(current, { workspaceId: resolved.workspaceId,
          rootId: resolved.sourceRoot.rootId, rootsRevision: resolved.rootsRevision, cwd: resolved.cwd });
        const after = ctx.config.get();
        if (!caller.isAlive() || ctx.agentSessions !== host) throw new Error(t('模型参数发现已取消'));
        assertSessionTargetCurrent(after, resolved);
        if (!source && after.activeWorkspaceId !== resolved.workspaceId) throw new Error(t('当前工作区已变化，请重试'));
        const workspace = after.workspaces.find(item => item.id === resolved.workspaceId);
        if ((workspace?.rootsRevision ?? 0) !== resolved.rootsRevision || sourcePathKey(fresh.cwd) !== cwdKey ||
            host.getDriver(target.runtimeId) !== driver || host.getDriver(target.runtimeId)?.connectionVersion !== version) {
          throw new Error(t('模型参数发现的来源或引擎配置已变化，请重试'));
        }
      };
      await checkCurrent();
      const { source: _source, ...request } = target;
      const result = await host.describeModelParameters({ ...request, cwd: resolved.cwd });
      await checkCurrent();
      if (target.refresh === true && !result.unavailable) {
        notifyModelCatalogUpdated(target.runtimeId, resolved, target.runtimeId === 'acp' ? result.providerId.slice(4) : undefined);
      }
      return result;
    } catch (error) {
      return failure(error instanceof Error ? error.message : t('模型参数发现来源不可用'));
    }
  });
  handle('agentSession:setModelParameters', (_e, args: { sessionId: string; changes: unknown }) => ctx.agentSessions?.setModelParameters(String(args?.sessionId), args?.changes) ?? { ok: false, error: 'Session host unavailable' });
  handle('agentSession:saveParameterProfiles', (_e, profiles: unknown) => ctx.agentSessions?.saveParameterProfiles(profiles) ?? { ok: false, error: 'Session host unavailable' });
  handle('agentSession:clear', (_e, sessionId: string) =>
    ctx.agentSessions
      ? ctx.agentSessions.clear(String(sessionId ?? '')).then(() => ({ ok: true }))
      : Promise.resolve({ ok: false })
  );
  // X4-F04：排队三通道改 {ok,error?} 合同——宿主未就绪带 error 文案（对齐同文件守护模式），
  // 不再返回裸 false（三义混淆：未就绪/消息不在队/被拒不可区分）。
  // host 侧 false（消息已不在队/顺序未变等）不带 error：渲染层经 busy 推送自然收敛，不算失败。
  handle(
    'agentSession:cancelQueued',
    (_e, args: { sessionId: string; messageId: string }): { ok: boolean; error?: string } =>
      ctx.agentSessions
        ? { ok: ctx.agentSessions.cancelQueued(String(args?.sessionId ?? ''), String(args?.messageId ?? '')) }
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle(
    'agentSession:editQueued',
    (_e, args: { sessionId: string; messageId: string; text: string }): { ok: boolean; error?: string } =>
      ctx.agentSessions
        ? { ok: ctx.agentSessions.editQueued(
            String(args?.sessionId ?? ''),
            String(args?.messageId ?? ''),
            String(args?.text ?? '')
          ) }
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle(
    'agentSession:reorderQueued',
    (_e, args: { sessionId: string; orderedIds: string[] }): { ok: boolean; error?: string } =>
      ctx.agentSessions
        ? { ok: ctx.agentSessions.reorderQueued(
            String(args?.sessionId ?? ''),
            Array.isArray(args?.orderedIds) ? args.orderedIds.map(String) : []
          ) }
        : { ok: false, error: t('GUI 会话宿主未就绪') }
  );
  handle(
    'agentSession:fork',
    (_e, args: { sessionId: string; uptoMessageId?: string }) =>
      ctx.agentSessions
        ? ctx.agentSessions.forkSession(
            String(args?.sessionId ?? ''),
            args?.uptoMessageId ? String(args.uptoMessageId) : undefined
          )
        : Promise.resolve({ ok: false, error: t('GUI 会话宿主未就绪') })
  );
}
