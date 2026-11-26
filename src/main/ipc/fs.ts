import { handle, ipcCaller } from './handle';
import { registerHistorySearchIpc } from './chatSearch';
import { app, clipboard } from 'electron';
import { promises as attachmentFs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { clipboardFilePaths } from '../attachments/clipboard';
import { convertMacClipboardPlist } from '../attachments/macClipboardPlist';
import path from 'node:path';
import { prepareAttachments } from '../attachments/service';
import { resolveLlmConfig } from '../config';
import { primePiCatalogSnapshot } from '../agent/piConfigSync';
import type { AppContext } from '../context';
import type { Orchestrator } from '../agent/orchestrator';
import { listAgentSkills } from '../agent/skillsList';
import { WorkspaceQueries } from '../workspaceQueries';
import { workspacePreviewsFor } from '../workspacePreview';
import { rankWorkspaceFiles } from '../../shared/workspaceQuery';
import { requireSourceRoot, requireWorkspace } from '../workspacePaths';
import { listDir, listTreeDir, readText, readTextExternal, removePath, statPath, writeText } from '../workspaceFs';
import { listPaths, searchText } from '../workspaceRg';
import type {
  ChatImageAttachment,
  FsListPathsOptions,
  FsSearchTextOptions,
  WorkspaceQueryOptions,
  WorkspaceFileRef
} from '../../shared/types';
import { errorMessage, isOutsideWorkspaceRootsError, OUTSIDE_WORKSPACE_ROOTS_REASON } from '../../shared/errors';
import { t } from '../../shared/i18n';
import { assertNoSourceRootDeletion, withWorkspaceFileTarget, withWorkspaceFileMutation, type WorkspaceFileTarget } from '../workspaceFileAccess';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { beginSchedulerWorkspaceContext, captureSchedulerWorkspaceContext } from '../agent/schedulerWorkspaceContext';
import { assertWorkspaceExecutionContextCurrent, captureWorkspaceExecutionContext } from '../workspaceExecutionContext';
import type { WorkspaceFsWatcher } from '../workspaceFsWatcher';

import type { CapabilityTargetId } from '../../shared/capabilityManagement';
import { sameReplySuggestions, type ClearReplySuggestionsRequest } from '../../shared/replySuggestions';

export function registerFsIpc(ctx: AppContext, orchestrator: Orchestrator, watcher?: WorkspaceFsWatcher): void {
  const modelSwitches = new Map<string, object>();
  handle('suggestions:clear', (_event, request: ClearReplySuggestionsRequest) => {
    if (!request || !['cli', 'gui', 'dispatch'].includes(request.kind) ||
        typeof request.targetId !== 'string' || !request.targetId ||
        typeof request.messageId !== 'string' || !request.messageId ||
        !Array.isArray(request.replies) || !request.replies.length || request.replies.length > 3 ||
        request.replies.some(reply => typeof reply !== 'string' || !reply))
      return { ok: false, error: t('建议数据无效，请刷新后重试') };
    try {
      if (request.kind === 'cli') {
        const session = ctx.sessions.get(request.targetId);
        if (!session || session.type !== 'terminal' || session.launchKind === 'shell' || ctx.sessions.isChatRuntime(session.runtime))
          return { ok: false, error: t('CLI 会话不可用') };
        if (!sameReplySuggestions(session.cliSuggestedReplies, request)) return { ok: true, cleared: false };
        ctx.sessions.clearCliSuggestedReplies(request.targetId, request.messageId);
        return { ok: true, cleared: true };
      }
      if (request.kind === 'gui') {
        if (!ctx.agentSessions) return { ok: false, error: t('GUI 会话宿主未就绪') };
        return { ok: true, cleared: ctx.agentSessions.clearSuggestedReplies(request.targetId, request) };
      }
      return { ok: true, cleared: orchestrator.clearSuggestedReplies(request.targetId, request) };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  handle('shell:clipboardFiles', async event => {
    if (!event?.sender || !ipcCaller(event).id.startsWith('desktop:')) throw new Error(t('仅本机粘贴可读取系统文件剪贴板'));
    const formats = clipboard.availableFormats();
    const cache = new Map<string, Buffer>();
    const read = (format: string): Buffer => {
      const hit = cache.get(format);
      if (hit) return hit;
      const data = clipboard.readBuffer(format);
      cache.set(format, data);
      return data;
    };
    const macList = process.platform === 'darwin' ? formats.find(format => format.toLowerCase() === 'nsfilenamespboardtype') : undefined;
    if (process.platform === 'darwin' && !macList && formats.some(format => format.toLowerCase() === 'public.file-url') &&
        !formats.some(format => format.toLowerCase() === 'text/uri-list'))
      throw new Error(t('系统文件剪贴板可能只提供部分文件，请拖入或选择文件'));
    if (macList && read(macList).subarray(0, 8).toString('ascii') === 'bplist00')
      cache.set(macList, await convertMacClipboardPlist(read(macList)));
    const paths = clipboardFilePaths(formats, read);
    return Promise.all(paths.map(async sourcePath => {
      const stat = await attachmentFs.stat(sourcePath);
      if (!stat.isFile()) throw new Error(t('暂不支持粘贴文件夹，请选择文件'));
      return { id: `file-${randomUUID()}`, sourcePath, name: path.basename(sourcePath), size: stat.size, data: '', mimeType: 'application/octet-stream' };
    }));
  });
  const queries = new WorkspaceQueries(() => ctx.config.get(), undefined, ctx.config.onChanged.bind(ctx.config));
  const views = workspaceRootUsesFor(ctx.config);
  const desktopOwners = new Set<number>();
  handle('fs:openFile', async (event, ref: WorkspaceFileRef, viewId: string) => {
    let undo: (() => void) | undefined;
    try {
      const caller = ipcCaller(event);
      if (!caller.isAlive()) throw new Error('file view client disconnected');
      if (typeof viewId !== 'string' || !viewId || viewId.length > 160) throw new Error('invalid file view identity');
      if (!ref || typeof ref !== 'object') throw new Error('invalid workspace file reference');
      // Register before path validation awaits. Invalid refs are removed on failure.
      const opening = views.openFile(caller.id, viewId, ref);
      undo = opening.undo;
      if (event?.sender && !desktopOwners.has(event.sender.id)) {
        desktopOwners.add(event.sender.id);
        event.sender.once('destroyed', () => { views.closeOwner(caller.id); desktopOwners.delete(event.sender.id); });
      }
      await withWorkspaceFileTarget(() => ctx.config.get(), ref, '', async () => undefined);
      if (!caller.isAlive()) throw new Error('file view client disconnected');
      opening.commit();
      return { ok: true };
    } catch (err) { undo?.(); return { ok: false, error: errorMessage(err) }; }
  });
  handle('fs:closeFile', (event, viewId: string) => {
    views.closeFile(ipcCaller(event).id, viewId); return { ok: true };
  });
  // 桌面调度对话框的输入永远只进调度 Agent；不跟随绑定转发（那是飞书侧消息的语义）。
  // 历史：这里曾按 paintBind 把桌面输入转给绑定终端，GUI 绑定可用后等于劫持调度输入框，已移除。
  handle(
    'chat:send',
    async (_e, text: string, workspaceId?: string, images?: ChatImageAttachment[]) => {
      const wsId = workspaceId?.trim() || undefined;
      // Bind the actual workspace and instruction before attachment processing
      // can yield; a stop during that work must invalidate this instruction.
      const desktopWorkspaceId = ctx.desktopTurns ? (wsId ?? orchestrator.workspaceId) : undefined;
      const desktopMessageId = desktopWorkspaceId ? randomUUID() : undefined;
      if (desktopMessageId) ctx.desktopTurns!().noteUserInstruction(`orchestrator:${desktopWorkspaceId}`, desktopMessageId);
      let imgs = Array.isArray(images) && images.length > 0 ? images : undefined;
      if (imgs) {
        try {
          const status = orchestrator.getContextStatus(wsId);
          const resolved = resolveLlmConfig(ctx.config.get(), { providerId: status.provider, modelId: status.modelId });
          const prepared = await prepareAttachments({ userData: app.getPath('userData'), scope: `scheduler:${wsId || 'default'}`,
            tools: ctx.config.get().attachmentTools,
            processing: ctx.config.get().attachmentProcessing,
            workerFile: path.join(app.getAppPath(), 'out/main/attachments/worker.mjs'),
            text, attachments: imgs, model: resolved.model, api: resolved.provider.api || 'openai-completions' });
          const latest = orchestrator.getContextStatus(wsId);
          if (JSON.stringify(resolveLlmConfig(ctx.config.get(), { providerId: latest.provider, modelId: latest.modelId })) !== JSON.stringify(resolved))
            return { accepted: false, error: t('附件处理期间模型配置已变化，请重新发送') };
          text = prepared.text; imgs = prepared.images;
        } catch (error) { return { accepted: false, error: (error as Error).message }; }
      }
      if (imgs) {
        const guard = orchestrator.checkSendImages(wsId, imgs);
        if (!guard.ok) return { accepted: false, error: guard.error };
      }
      // 回合是长任务，不能 await；错误由 runTurn 收口成 agent:done，这里只兜底记日志
      void orchestrator
        .send(text, desktopWorkspaceId ?? wsId, imgs,
          desktopMessageId ? { messageId: desktopMessageId, desktopInstructionNoted: true } : undefined)
        .catch((e) => console.error('[chat:send] turn failed', e));
      return { accepted: true };
    }
  );
  handle('chat:retry', (_e, workspaceId?: string) =>
    orchestrator.retry(workspaceId?.trim() || undefined)
  );
  handle('chat:recallAborted', (_e, messageId?: string, workspaceId?: string) =>
    orchestrator.recallAborted(
      workspaceId?.trim() || undefined,
      messageId?.trim() || undefined
    )
  );
  handle('chat:stop', (_e, workspaceId?: string) =>
    orchestrator.stop(workspaceId?.trim() || undefined)
  );
  handle('chat:compact', (_e, instructions?: string, workspaceId?: string) =>
    orchestrator.compactSession(
      workspaceId?.trim() || undefined,
      instructions?.trim() || undefined
    )
  );
  handle('chat:cancelQueued', (_e, messageId: string, workspaceId?: string) =>
    orchestrator.cancelQueued(messageId, workspaceId?.trim() || undefined)
  );
  handle('chat:sendNow', (_e, text: string, workspaceId?: string) =>
    orchestrator.sendNow(String(text ?? ''), workspaceId?.trim() || undefined)
  );
  handle('chat:editQueued', (_e, messageId: string, text: string, workspaceId?: string) =>
    orchestrator.editQueued(messageId, String(text ?? ''), workspaceId?.trim() || undefined)
  );
  handle('chat:reorderQueued', (_e, orderedIds: string[], workspaceId?: string) =>
    orchestrator.reorderQueued(
      Array.isArray(orderedIds) ? orderedIds.map(String) : [],
      workspaceId?.trim() || undefined
    )
  );
  handle('chat:getMode', (_e, workspaceId?: string) =>
    orchestrator.getAgentMode(workspaceId?.trim() || undefined)
  );
  handle('chat:setMode', (_e, mode: string, workspaceId?: string) =>
    orchestrator.setAgentMode(mode, workspaceId?.trim() || undefined)
  );
  handle('chat:planAction', (_e, action: string, workspaceId?: string) =>
    orchestrator.planAction(
      action === 'abandon' ? 'abandon' : 'execute',
      workspaceId?.trim() || undefined
    )
  );
  registerHistorySearchIpc('chat', (id, before, limit) => orchestrator.getHistoryRange(id, before, limit), id => `dispatch:${id}`);
  handle('chat:historyRange', (_e, workspaceId?: string, before?: number, limit?: number, targetMessageId?: string) =>
    orchestrator.getHistoryRange(workspaceId?.trim() || undefined, before, limit, targetMessageId)
  );
  handle('chat:state', (_e, workspaceId?: string) => ({
    busy: orchestrator.isBusy(workspaceId?.trim() || orchestrator.activeWorkspaceId)
  }));
  handle('chat:sessions:list', (_e, workspaceId?: string) =>
    orchestrator.listSessions(workspaceId?.trim() || undefined)
  );
  handle('chat:session:open', (_e, workspaceId: string, sessionFile: string) => {
    const wsId = workspaceId?.trim() || orchestrator.activeWorkspaceId;
    return orchestrator.openSession(wsId, String(sessionFile ?? ''));
  });
  handle(
    'chat:session:rename',
    (_e, workspaceId: string, sessionFile: string, name: string) => {
      const wsId = workspaceId?.trim() || orchestrator.activeWorkspaceId;
      return orchestrator.renameSession(wsId, String(sessionFile ?? ''), String(name ?? ''));
    }
  );
  handle('chat:session:delete', (_e, workspaceId: string, sessionFile: string) => {
    const wsId = workspaceId?.trim() || orchestrator.activeWorkspaceId;
    return orchestrator.deleteSession(wsId, String(sessionFile ?? ''));
  });
  handle('chat:fork', (_e, messageId: string, workspaceId?: string) =>
    orchestrator.forkSession(String(messageId ?? ''), workspaceId?.trim() || undefined)
  );
  handle('chat:context', async (_e, workspaceId?: string) => {
    // 仅载入随应用安装的 Pi 目录，不启动引擎或刷新外部模型列表。
    const wsId = workspaceId?.trim() || orchestrator.activeWorkspaceId;
    await primePiCatalogSnapshot();
    return orchestrator.getContextStatus(wsId);
  });
  handle(
    'chat:switchModel',
    async (_e, model: { providerId: string; modelId: string } | null, workspaceId?: string, options?: import('../../shared/harnessPicker').SetDispatchModelConfigurationOptions) => {
      const wsId = workspaceId?.trim() || orchestrator.activeWorkspaceId;
      const request = {};
      modelSwitches.set(wsId, request);
      await primePiCatalogSnapshot();
      if (modelSwitches.get(wsId) !== request) return { ok: false };
      modelSwitches.delete(wsId);
      if (options !== undefined) return orchestrator.setPickerConfiguration(wsId, model, options);
      if (!model) return { ok: false, error: t('模型信息不完整') };
      const result = orchestrator.switchModel(wsId, model);
      return { ok: true, ...result };
    }
  );
  handle(
    'chat:setThinking',
    (_e, level: string | null, workspaceId?: string) =>
      orchestrator.setThinking(level ?? null, workspaceId?.trim() || undefined)
  );
  handle('chat:clear', (_e, workspaceId?: string) => {
    const id = workspaceId?.trim() || orchestrator.activeWorkspaceId;
    if (orchestrator.isBusy(id)) throw new Error(t('Agent 正忙，稍后再清空'));
    orchestrator.clearHistory(id);
    return { cleared: true };
  });
  handle(
    'chat:respondUserQuestion',
    (
      _e,
      args: {
        workspaceId?: string;
        questionId: string;
        action: 'answer' | 'abort';
        answers?: Array<{ id: string; selected: string[]; custom?: string }>;
      }
    ) => {
      const wsId = args?.workspaceId?.trim() || orchestrator.activeWorkspaceId;
      const questionId = String(args?.questionId ?? '');
      const action = args?.action === 'abort' ? 'abort' : 'answer';
      if (!questionId) return { ok: false };
      return {
        ok: orchestrator.respondUserQuestion(wsId, questionId, action, args?.answers)
      };
    }
  );
  handle('agent:listSkills', async (_e, workspaceId?: string, target: CapabilityTargetId = 'pi-gui', sessionId?: string, rootId?: string) => {
    let release: (() => void) | undefined;
    try {
      if (!ctx.runtimes.list().some(runtime => runtime.enabled && runtime.integrations?.skillTargets?.some(endpoint => endpoint.id === target))) throw new Error(t('技能入口无效'));
      const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
      if (sessionId && (!session || session.workspaceId !== workspaceId || session.launchKind === 'shell' ||
          ctx.sessions.isChatRuntime(session.runtime) || !ctx.runtimes.list().some(runtime => runtime.id === session.runtime && runtime.enabled &&
            runtime.integrations?.skillTargets?.some(endpoint => endpoint.id === target && endpoint.kind === 'cli'))))
        throw new Error(t('当前 CLI 的技能入口不可用'));
      const selected = rootId ? requireSourceRoot(requireWorkspace(ctx.config.get(), workspaceId), rootId) : undefined;
      const context = session ? captureWorkspaceExecutionContext(ctx.config.get(), session, ctx.sessions.list())
        : captureSchedulerWorkspaceContext(ctx.config.get(), workspaceId, null, undefined, true,
          selected ? { rootId: selected.id, cwd: selected.path, path: selected.path } : undefined);
      if (!context) throw new Error(t('当前工作区不可用'));
      const sessionSnapshot = session ? { id: session.id, runtime: session.runtime, cwd: session.cwd, workspaceId: session.workspaceId } : undefined;
      release = beginSchedulerWorkspaceContext(ctx.config, context, { publish: false, id: `skills:${context.workspaceId}` });
      const skills = await listAgentSkills(context.cwd, context, target);
      assertWorkspaceExecutionContextCurrent(ctx.config.get(), context);
      if (sessionSnapshot) {
        const latest = ctx.sessions.get(sessionSnapshot.id);
        if (!latest || latest.runtime !== sessionSnapshot.runtime || latest.cwd !== sessionSnapshot.cwd || latest.workspaceId !== sessionSnapshot.workspaceId)
          throw new Error(t('会话已变化，请重新选择技能'));
      }
      return { skills };
    } catch (err) {
      console.error('[agent:listSkills]', err);
      return { skills: [], error: errorMessage(err) };
    } finally { release?.(); }
  });
  handle('workspace:listFiles', async (_e, workspaceId?: string, query?: string, requestId?: string) => {
    try {
      const id = requireWorkspace(ctx.config.get(), workspaceId).id;
      const result = await queries.list(id, { max: 2000, query, includeHidden: true, includeIgnored: true, requestId });
      const files = rankWorkspaceFiles(result.items, query ?? '', 40);
      const { items, ...metadata } = result;
      return { ...metadata, files, truncated: result.truncated || files.length < items.length };
    } catch (err) {
      console.error('[workspace:listFiles]', err);
      return { files: [], error: errorMessage(err) };
    }
  });
  handle('fs:listFiles', async (_e, workspaceId: string, opts?: WorkspaceQueryOptions) => {
    try { return await queries.list(workspaceId, opts); }
    catch (err) { return { items: [], roots: [], rootsRevision: 0, truncated: false, cancelled: false, error: errorMessage(err) }; }
  });
  handle('fs:searchFiles', async (_e, workspaceId: string, opts: WorkspaceQueryOptions) => {
    try { return await queries.search(workspaceId, opts ?? {}); }
    catch (err) { return { items: [], roots: [], rootsRevision: 0, truncated: false, cancelled: false, error: errorMessage(err) }; }
  });
  handle('fs:cancelQuery', (_e, workspaceId: string, requestId: string) => ({ cancelled: queries.cancel(workspaceId, requestId) }));
  handle('fs:openBrowserPreview', async (_event, ref: WorkspaceFileRef) => {
    try {
      const previews = ctx.extensionSystem?.exports;
      if (!ctx.browser || !previews || ctx.config.get().activeWorkspaceId !== ref.workspaceId) throw new Error('当前工作区的浏览器预览不可用');
      const url = await withWorkspaceFileTarget(() => ctx.config.get(), ref, '', async (_root, _ref, file) => previews.projectPreviewUrl(file));
      if (ctx.config.get().activeWorkspaceId !== ref.workspaceId) throw new Error('工作区已切换');
      ctx.browser.createTab(url, { workspaceId: ref.workspaceId, scope: 'workspace' }, { panelUserOpen: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: errorMessage(err) }; }
  });
  handle('fs:createPreview', async (_e, ref: WorkspaceFileRef) => {
    try { return { ok: true, ...await workspacePreviewsFor(ctx).create(ref) }; }
    catch (err) { return { ok: false, error: errorMessage(err) }; }
  });
  handle('fs:releasePreview', (_e, token: string) => { workspacePreviewsFor(ctx).release(token); return { ok: true }; });

  handle('fs:resolveRef', async (_e, workspaceId: WorkspaceFileTarget, filePath?: string) => {
    try { return await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, String(filePath ?? ''), async (_root, fileRef) => ({ ok: true, fileRef })); }
    catch (err) {
      // 区外路径带结构化 reason 回传：渲染层外部只读通道据此判定，不依赖英文报错文案（files-panel F-02）
      return isOutsideWorkspaceRootsError(err)
        ? { ok: false, error: errorMessage(err), reason: OUTSIDE_WORKSPACE_ROOTS_REASON }
        : { ok: false, error: errorMessage(err) };
    }
  });
  handle('fs:refreshWatch', (_e, workspaceId: string, rootId: string) => {
    try {
      if (!watcher) return { ok: false, error: 'file watcher unavailable' };
      const error = watcher.refreshRoot(workspaceId, rootId);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) { return { ok: false, error: errorMessage(err) }; }
  });
  handle('fs:listDir', async (_e, workspaceId: WorkspaceFileTarget, dirRel?: string) => {
    try {
      return await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, dirRel ?? '', async (root, ref) => ({
        watchError: watcher?.errorForRoot(ref.workspaceId, ref.rootId),
        entries: (await listDir(root, ref.relativePath)).map((entry) => ({ ...entry, fileRef: { ...ref, relativePath: entry.relativePath } }))
      }));
    } catch (err) {
      console.error('[fs:listDir]', err);
      return { entries: [], error: errorMessage(err) };
    }
  });
  handle('fs:listTreeDir', async (_e, workspaceId: WorkspaceFileTarget, dirRel?: string) => {
    try {
      return await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, dirRel ?? '', async (root, ref) => ({
        watchError: watcher?.errorForRoot(ref.workspaceId, ref.rootId),
        entries: (await listTreeDir(root, ref.relativePath)).map((entry) => ({ ...entry, fileRef: { ...ref, relativePath: entry.relativePath } }))
      }), false, true);
    } catch (err) {
      console.error('[fs:listTreeDir]', err);
      return { entries: [], error: errorMessage(err) };
    }
  });
  handle('fs:readText', async (_e, workspaceId: WorkspaceFileTarget, filePath?: string) => {
    try { return await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, String(filePath ?? ''), (root, ref) => readText(root, ref.relativePath)); }
    catch (err) { return { ok: false, error: errorMessage(err) }; }
  });
  // 工作区外文件的只读预览（绝对路径；无写通道，写权限仍圈在工作区根内）
  handle('fs:readExternal', (_e, absPath: string) => readTextExternal(String(absPath ?? '')));
  handle(
    'fs:writeText',
    async (
      _e,
      workspaceId: WorkspaceFileTarget,
      filePath: string,
      content: string,
      expectedMtimeMs?: number | null
    ) => {
      try { return await withWorkspaceFileMutation(ctx.config, workspaceId, String(filePath ?? ''), 'file-write', (root, ref) => writeText(root, ref.relativePath, String(content ?? ''), expectedMtimeMs ?? undefined)); }
      catch (err) { return { ok: false, error: errorMessage(err) }; }
    }
  );
  handle('fs:remove', async (_e, workspaceId: WorkspaceFileTarget, filePath?: string) => {
    try { return await withWorkspaceFileMutation(ctx.config, workspaceId, String(filePath ?? ''), 'file-delete', async (root, ref, abs) => {
      await assertNoSourceRootDeletion(ctx.config.get(), abs);
      return removePath(root, ref.relativePath);
    }); }
    catch (err) { return { ok: false, error: errorMessage(err) }; }
  });
  handle('fs:stat', async (_e, workspaceId: WorkspaceFileTarget, filePath?: string) => {
    try { return await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, String(filePath ?? ''), (root, ref) => statPath(root, ref.relativePath)); }
    catch (err) { return { ok: false, error: errorMessage(err) }; }
  });
  handle(
    'fs:listPaths',
    async (_e, workspaceId: string | undefined, opts?: FsListPathsOptions) => {
      try {
        const paths = await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, '.', root => listPaths(root, opts ?? {}));
        return { paths };
      } catch (err) {
        console.error('[fs:listPaths]', err);
        return { paths: [], error: errorMessage(err) };
      }
    }
  );
  handle(
    'fs:searchText',
    async (_e, workspaceId: string | undefined, opts: FsSearchTextOptions) => {
      try {
        const hits = await withWorkspaceFileTarget(() => ctx.config.get(), workspaceId, '.', root => searchText(root, opts ?? { query: '' }));
        return { hits };
      } catch (err) {
        console.error('[fs:searchText]', err);
        return { hits: [], error: errorMessage(err) };
      }
    }
  );
}
