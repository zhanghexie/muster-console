import { desktopTurnGrants } from '../desktop/turnGrant';
import { sendSessionMail } from '../messages/assignment';
import { isolationRecommendation } from '../sessions/isolationPolicy';
import { app, ipcMain, Notification } from 'electron';
import { handle, ipcCaller } from './handle';
import type { AppContext } from '../context';
import { t } from '../../shared/i18n';
import { listShellProfiles } from '../shell/profiles';
import { pickBgShellProfile } from '../shell/bgLaunch';
import type { ShellEnvInfo } from '../../shared/types';
import { detectGitBashPath, getManualGitBashPath } from '../shell/profiles';
import { openExternalUrl, openSystemPath, revealPath } from '../shell/reveal';
import { statPaths } from '../shell/pathStat';
import { delegateTask, recommendIsolate } from '../tasks/delegate';
import { sessionsHost } from '../capabilities/hosts/sessions';
import type { SessionMessageIpcResult, TerminalRestartIntent } from '../../shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { createCliComposerSubmitter } from '../pty/composerSubmit';
import { snapshotTaskAttachments } from '../attachments/taskDraft';
import { attachmentDir, clearAttachments, prepareAttachments } from '../attachments/service';
import type { ChatImageAttachment } from '../../shared/types';
import { beginHandoverSubmission, finishHandoverSubmission } from '../handover/documents';
import { canvasHandoverTask } from '../../shared/canvasHandover';
import { localizeSessionUserOperation } from '../sessions/userErrors';
import { localizeMailboxUserText } from '../../shared/mailboxUserErrors';

export function registerSessionIpc(ctx: AppContext): void {
  const extensionLaunchMeta = (source: import('../../shared/boardTodo').ExtensionTaskSource, workspaceId?: string, rootId?: string, runtime?: string) => {
    if (!ctx.extensionSystem) throw new Error('扩展宿主尚未就绪');
    return ctx.extensionSystem.extensionHost.taskLaunchMeta(source, workspaceId, rootId, runtime);
  };
  handle('sessions:setConfigurePermissions', async (_event, sessionId: string, enabled: boolean) => {
    if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') return { ok: false, error: 'Invalid permission configuration.' };
    if (ctx.agentSessions) return ctx.agentSessions.setConfigurePermissions(sessionId, enabled);
    return { ok: false, error: t('GUI 会话宿主未就绪') };
  });
  handle('sessions:list', () => ({
    sessions: ctx.sessions.list(),
    activeId: ctx.sessions.activeId,
    schedulerByWs: ctx.schedulerStatus.list()
  }));
  handle(
    'sessions:create',
    (
      _e,
      opts: {
        extensionSource?: import('../../shared/boardTodo').ExtensionTaskSource;
        activate?: boolean;
        name?: string;
        runtime?: string;
        cliLaunchOptions?: import('../../shared/cliLaunchOptions').CliLaunchOptions;
        cwd?: string;
        workspaceId?: string;
        rootId?: string;
        rootsRevision?: number;
        shellProfileId?: string;
        isolate?: boolean;
        isolationGroups?: import('../../shared/types').WorkspaceWorktreeGroupSelection[];
        /** GUI（chat surface）会话初始态；仅 chat runtime 生效 */
        guiMode?: import('../../shared/types').GuiWorkerMode;
        configurePermissions?: boolean;
        nativeConfig?: import('../../shared/nativeSessionConfig').NativeConfigIntent;
        piModeId?: string;
        model?: { providerId: string; modelId: string };
        thinking?: 'off' | 'low' | 'medium' | 'high' | 'max';
        /** 预检逃生门：true=跳过 runtime 可用性预检强创 */
        force?: boolean;
      }
    ) => {
      const {
        name,
        runtime,
        cliLaunchOptions,
        configurePermissions,
        cwd,
        workspaceId,
        rootId,
        rootsRevision,
        shellProfileId,
        isolate,
        isolationGroups,
        guiMode,
        nativeConfig,
        piModeId,
        model,
        thinking,
        force
      } = opts ?? {};
      return localizeSessionUserOperation(async () => ctx.sessions.createTerminal({
        ...(opts?.extensionSource ? { meta: await extensionLaunchMeta(opts.extensionSource, workspaceId, rootId, runtime) } : {}),
        activate: opts?.activate,
        name,
        runtime,
        cwd,
        cliLaunchOptions,
        configurePermissions,
        workspaceId,
        rootId,
        rootsRevision,
        shellProfileId,
        isolate,
        isolationGroups,
        ...(force === true ? { force: true } : {}),
        ...(guiMode || nativeConfig || piModeId || model || thinking
          ? {
              inheritMeta: {
                ...(guiMode ? { guiMode } : {}),
                ...(nativeConfig ? { nativeConfig } : {}),
                ...(piModeId?.trim() ? { piModeId: piModeId.trim() } : {}),
                ...(model?.providerId && model?.modelId
                  ? { modelOverride: { providerId: model.providerId, modelId: model.modelId } }
                  : {}),
                ...(thinking ? { thinkingLevel: thinking } : {})
              }
            }
          : {})
      }));
    }
  );
  handle('sessions:discardWorktree', (_e, sessionId: string) =>
    ctx.sessions.discardWorktree(sessionId)
  );
  handle('sessions:previewForceRemoveUnregistered', (_e, sessionId: string, path: string) => ctx.sessions.previewForceRemoveUnregistered(sessionId, path));
  handle('sessions:forceRemoveUnregistered', (_e, sessionId: string, token: string) => ctx.sessions.forceRemoveUnregistered(sessionId, token));
  // P4：UI「＋新建任务」统一派活管线（含异步通知调度 Agent）
  handle(
    'tasks:delegate',
    (
      _e,
      input: {
        select?: boolean;
        task: string;
        runtime?: string;
        cliLaunchOptions?: import('../../shared/cliLaunchOptions').CliLaunchOptions;
        workspaceId?: string;
        rootId?: string;
        rootsRevision?: number;
        isolate: boolean;
        cwd?: string;
        isolationGroups?: import('../../shared/types').WorkspaceWorktreeGroupSelection[];
        name?: string;
        /** GUI（chat surface）会话初始态；仅 chat runtime 生效 */
        guiMode?: import('../../shared/types').GuiWorkerMode;
        configurePermissions?: boolean;
        nativeConfig?: import('../../shared/nativeSessionConfig').NativeConfigIntent;
        piModeId?: string;
        model?: { providerId: string; modelId: string };
        thinking?: 'off' | 'low' | 'medium' | 'high' | 'max';
        modelParameters?: import('../../shared/modelParameters').ModelParameterValues;
        extensionSource?: import('../../shared/boardTodo').ExtensionTaskSource;
        handoverDraftId?: string;
        handoverSupplement?: string;
        attachments?: ChatImageAttachment[];
        submissionId?: string;
      }
    ) => localizeSessionUserOperation(async () => {
      const { task, runtime, workspaceId, rootId, rootsRevision, cwd, isolationGroups, isolate, name,
        guiMode, configurePermissions, nativeConfig, piModeId, model, thinking, modelParameters, cliLaunchOptions } = input ?? { task: '' };
      const attachments = input?.attachments?.length
        ? await snapshotTaskAttachments(input.attachments, ipcCaller(_e).id.startsWith('desktop:')) : undefined;
      const creationKey = input?.submissionId && /^[a-f0-9-]{36}$/i.test(input.submissionId)
        ? 'desktop-task:' + input.submissionId : undefined;
      const firstTurn = { ...(attachments ? { attachments } : {}), ...(creationKey ? { creationKey } : {}) };
      if (input?.handoverDraftId) {
        const draft = beginHandoverSubmission(app.getPath('userData'), input.handoverDraftId, workspaceId ?? '');
        const supplement = typeof input.handoverSupplement === 'string' ? input.handoverSupplement : '';
        return delegateTask(ctx, { ...firstTurn, task: canvasHandoverTask(draft.lockedTask, supplement), runtime, workspaceId,
          rootId, rootsRevision, cwd, isolationGroups, isolate, name, select: input.select, guiMode, configurePermissions, nativeConfig, piModeId,
          model, thinking, modelParameters, cliLaunchOptions, notifyOrchestrator: true, desktopUserInstruction: true, reservedSessionId: draft.id })
          .then(result => { finishHandoverSubmission(draft.id, true); return result; })
          .catch(error => { finishHandoverSubmission(draft.id, !!ctx.sessions.get(draft.id)); throw error; });
      }
      return delegateTask(ctx, { ...firstTurn, task, runtime, workspaceId, rootId, rootsRevision, cwd, isolationGroups, isolate, name,
        ...(input?.extensionSource ? { extensionMeta: await extensionLaunchMeta(input.extensionSource, workspaceId, rootId, runtime) } : {}),
        select: input?.select,
        guiMode, configurePermissions, nativeConfig, piModeId, model, thinking, modelParameters, cliLaunchOptions, notifyOrchestrator: true, desktopUserInstruction: true });
    })
  );
  // 新建任务对话框：隔离勾选框的自动推荐预填（目标仓 dirty → true）
  handle('sessions:recommendIsolate', (_e, workspaceId?: string) =>
    recommendIsolate(ctx, workspaceId?.trim() || ctx.resolveBubbleWorkspaceId())
  );
  // 新建任务对话框预检：隔离推荐 + 主仓 dirty（一次往返；dirty=null 表示 git 不可用未知）
  handle(
    'sessions:precheck',
    async (_e, workspaceId?: string, rootId?: string, rootsRevision?: number): Promise<{ isolate: boolean; dirty: boolean | null }> => {
      const wid = workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
      const { isolate, dirty } = await isolationRecommendation(ctx, wid, undefined, rootId, rootsRevision);
      return { isolate, dirty };
    }
  );
  handle('sessions:select', (_e, id: string) => ctx.sessions.select(id));
  handle('sessions:continueArchived', (_e, id: string) => ctx.sessions.continueArchived(id));
  handle('sessions:deselect', (_e, id: string) => ctx.sessions.deselect(id));
  handle('sessions:archivedTerminalHistory', (_e, id: string) => ctx.sessions.archivedTerminalHistory(id));
  handle('sessions:deletePreview', (_e, id: string) => ctx.sessions.previewPermanentDeletion(id));
  handle('sessions:cleanupArchivedWorktree', (_e, id: string) => ctx.sessions.cleanupArchivedWorktree(id));
  handle('sessions:close', (_e, id: string, options?: import('../../shared/sessionLifecycle').SessionDeleteOptions) =>
    ctx.sessions.deletePermanently([id], 'human', options));
  handle('sessions:rename', (_e, id: string, name: string) => ctx.sessions.rename(id, name));
  handle('sessions:setPinned', (_e, id: string, pinned: boolean) =>
    ctx.sessions.setPinned(id, pinned)
  );
  const archiveConfirmation = (id: string, confirmed?: string[]) => {
    const active = ctx.sessions.archiveExecutionIds(id);
    if (active.some(sessionId => !Array.isArray(confirmed) || !confirmed.includes(sessionId))) return { archiveConfirmation: active };
  };
  handle('sessions:setArchived', (_e, id: string, archived: boolean, selectionHint?: import('../../shared/workspaceActiveSession').ArchiveSelectionHint, confirmed?: string[]) =>
    (archived ? archiveConfirmation(id, confirmed) : undefined) ?? ctx.sessions.setArchived(id, archived, selectionHint));
  // 用户手动标记看板三档（source=user，粘性：model/llm 不得回退）
  handle('sessions:setPhase', (_e, id: string, phase: { value: string }) => {
    const value = phase?.value;
    if (value !== 'idle' && value !== 'needs_you' && value !== 'done') {
      throw new Error(t('phase 必须是 idle | needs_you | done'));
    }
    return ctx.sessions.setPhase(id, { value, source: 'user' });
  });
  handle('sessions:markProcessed', (_e, id: string, confirmed?: string[]) =>
    archiveConfirmation(id, confirmed) ?? ctx.sessions.markProcessed(id, { source: 'user' }));
  handle(
    'sessions:review',
    async (
      _e,
      args: { sessionId: string; decision: string; note?: string; skipDimensionGate?: boolean }
    ) => {
      return sessionsHost['sessions.review'](ctx, args, { initiatedBy: 'human' });
    }
  );
  handle(
    'sessions:completeAndArchive',
    (
      _e,
      args: { sessionIds: string[]; workspaceId?: string }
    ) => sessionsHost['sessions.completeAndArchive'](ctx, args)
  );
  handle('sessions:respawn', (_e, id: string, intent?: TerminalRestartIntent) => {
    if (intent !== undefined && intent !== 'resume' && intent !== 'new') throw new Error(t('无效的终端启动操作'));
    return ctx.sessions.respawn(id, intent);
  });
  handle('sessions:resumeInterrupted', async (_e, sessionId: string) => {
    const r = await ctx.sessions.resumeInterrupted(String(sessionId ?? '').trim());
    try {
      const delivery = (await sendSessionMail(ctx, {
        sessionId: r.session.id,
        text: r.brief
      }));
      return { ...r, messageStored: true, messageId: delivery.messageId };
    } catch (err) {
      return {
        ...r,
        messageStored: false,
        error: localizeMailboxUserText(err instanceof Error ? err.message : String(err))
      };
    }
  });
  // T1.7：Git 页 diff 评论回注。统一先存信，由邮箱唤醒层提醒读信。
  handle('sessions:sendMessage', async (_event, args: { sessionId: string; text: string; idempotencyKey?: string }): Promise<SessionMessageIpcResult> => {
    try {
      const mail = await sendSessionMail(ctx, { sessionId: String(args?.sessionId ?? '').trim(), text: String(args?.text ?? ''), from: 'human', idempotencyKey: args.idempotencyKey });
      return { ok: true, ...mail };
    } catch (error) {
      const message = (error as Error).message;
      return { ok: false, message: typeof message === 'string' ? localizeMailboxUserText(message) : message };
    }
  });
  handle('shell:listProfiles', () => listShellProfiles());
  // 设置页与后台任务共用选档逻辑，Git Bash 路径仅在 Windows 上检查。
  handle('shell:getInfo', (): ShellEnvInfo => {
    const isWindows = process.platform === 'win32';
    const manual = isWindows ? getManualGitBashPath() ?? '' : '';
    const profiles = listShellProfiles();
    const bgShellMode = ctx.config.get().shell?.bgShellMode ?? 'auto';
    return {
      platform: process.platform,
      profiles,
      gitBashPath: isWindows ? detectGitBashPath() : null,
      manualGitBashPath: manual,
      manualGitBashPathExists: manual ? fs.existsSync(manual) : false,
      bgShellMode,
      bgShellProfile: pickBgShellProfile(profiles, bgShellMode)
    };
  });
  handle('shell:openExternal', (_e, url: string) => openExternalUrl(String(url ?? '')));
  handle('shell:openPath', (_e, absPath: string) => openSystemPath(String(absPath ?? '')));
  handle('shell:revealPath', (_e, absPath: string) => revealPath(String(absPath ?? '')));
  handle('shell:statPaths', (_e, absPaths: string[]) =>
    statPaths(Array.isArray(absPaths) ? absPaths.map((p) => String(p ?? '')) : [])
  );
  ipcMain.on('shell:startPathDrag', (event, absPath: string | string[]) => {
    try {
      // 多选拖出：startDrag 的 file 接受路径数组（单路径保持原样，行为不变）
      const raw = Array.isArray(absPath) ? absPath : [absPath];
      const files = raw
        .map((p) => path.resolve(String(p ?? '')))
        .filter((p) => p && fs.existsSync(p));
      if (files.length === 0) return;
      // 多路径走 files 字段（Electron 以 files 覆盖 file）；icon 须非空（macOS）
      event.sender.startDrag({
        file: files[0]!,
        files: files.length > 1 ? files : undefined,
        icon: nativeImage.createEmpty()
      });
    } catch (err) {
      console.error('[shell:startPathDrag]', err);
    }
  });

  // 只读调试口（e2e 用它验证去重/同键条目）；应用内通知面板已移除，无清空入口
  handle('notify:list', (_e, workspaceId: string) =>
    ctx.notify.list(workspaceId?.trim() || ctx.config.get().activeWorkspaceId)
  );
  // 系统通知能力只读探测（notification F-01 应用内兜底）：设置页「通知」节据此提示
  // 「本机无系统通知能力」——needs_you 在此环境依赖左栏胶囊与看板列。
  handle('notify:capability', () => Notification.isSupported());
  // 输入区（composer）失败/被拒提示：输入框上方 hint 条已按用户要求移除，成功确认不再
  // 提示；失败不静默（工作区规约）→ 系统桌面 toast（docs/features/notification-system.md）。
  // sessionId 用 notify: 合成前缀：点击只切工作区，不 sessions.select。
  handle('notify:toast', (_e, input?: { text?: string; workspaceId?: string; label?: string }) => {
    const text = String(input?.text ?? '').trim();
    const workspaceId = String(input?.workspaceId ?? '').trim() || ctx.config.get().activeWorkspaceId;
    if (!text || !workspaceId) return { ok: false };
    ctx.notify.push({
      workspaceId,
      sessionId: `notify:composer:${workspaceId}`,
      sessionName: t('输入区'),
      label: String(input?.label ?? '').trim() || undefined,
      text,
      toast: true
    });
    return { ok: true };
  });

  ipcMain.on('pty:input', (_e, sessionId: string, data: string) => {
    // 注意：此通道含 xterm 自动应答（DA1 等设备查询响应），不能当用户输入
    const written = ctx.pty.write(sessionId, data);
    const session = ctx.sessions.get(sessionId);
    if (written && !data.startsWith('\x1b[200~') && (data.endsWith('\r') || data === '\n')) {
      if (!data.startsWith('\x1b')) desktopTurnGrants.nextUserMessage(sessionId);
      ctx.sessions.clearCliSuggestedReplies(sessionId);
    }
    // 只认提交输入，忽略方向键/鼠标等终端控制序列；不保存输入内容。
    if (session && /[\r\n]/.test(data)) ctx.usage.recordSessionActivity(session.id, {
      name: session.name || session.id, runtime: session.runtime || 'shell', workspaceId: session.workspaceId || '' });
  });
  const submitCliComposer = createCliComposerSubmitter(ctx, async (sessionId, text, attachments) => {
    const prepared = await prepareAttachments({ userData: app.getPath('userData'), scope: `cli:${sessionId}`,
      text, attachments, supportsImages: false, tools: ctx.config.get().attachmentTools,
      processing: ctx.config.get().attachmentProcessing,
      workerFile: path.join(app.getAppPath(), 'out/main/attachments/worker.mjs') });
    return prepared.text;
  });
  ctx.sessions.onSessionRemoved(session => {
    if (session.type !== 'terminal' || ctx.sessions.isChatRuntime(session.runtime)) return;
    const scope = `cli:${session.id}`, userData = app.getPath('userData');
    try { clearAttachments(userData, scope); }
    catch (error) {
      ctx.notify.push({ workspaceId: session.workspaceId || 'app', sessionId: session.id, sessionName: session.name,
        kind: 'error', toast: true, text: t('会话附件清理失败，请检查 {{path}}：{{error}}',
          { path: attachmentDir(userData, scope), error: String(error) }) });
    }
  });
  handle('pty:submitComposer', (event, sessionId: string, text: string, attachments?: ChatImageAttachment[]) => {
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some(item => !item ||
        typeof item.id !== 'string' || typeof item.data !== 'string' || typeof item.mimeType !== 'string' ||
        item.sourcePath !== undefined && (typeof item.sourcePath !== 'string' || !path.isAbsolute(item.sourcePath)))))
      return { ok: false, error: t('附件数据无效，请重新添加') };
    if (attachments?.some(item => item?.sourcePath) && !ipcCaller(event).id.startsWith('desktop:'))
      return { ok: false, error: t('远程附件不能引用宿主本地路径，请重新选择文件') };
    return submitCliComposer(sessionId, text, attachments);
  });
  ipcMain.on('sessions:touch-used', (_e, sessionId: string) => {
    ctx.sessions.touchUsed(sessionId);
  });
  ipcMain.on('pty:resize', (_e, sessionId: string, cols: number, rows: number) => {
    ctx.pty.resize(sessionId, cols, rows);
  });
  handle('pty:getBuffer', (_e, sessionId: string) => ctx.pty.getBuffer(sessionId));
}
