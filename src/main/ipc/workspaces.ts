import path from 'node:path';
import { app, shell } from 'electron';
import { handle } from './handle';
import { readWaitingTips } from '../waitingTips';
import type { AppContext } from '../context';
import {closeMemoryCurator,refreshMemoryCurators,restoreMemoryCurators} from '../memory/curatorBindings';
import type { Orchestrator } from '../agent/orchestrator';
import type {
  AppConfig,
  SandboxInfo,
  UpdateRuntimeArgs,
  RegisterRuntimeManifestArgs,
  WorkspaceOpenOptions,
  WorkspaceUpdateOptions
} from '../../shared/types';
import { testLlmConnection } from '../agent/openaiClient';
import { resolveLlmConfig } from '../config';
import { primePiCatalogSnapshot, getPiCatalogForUi } from '../agent/piConfigSync';
import { ProviderModelCatalogStore } from '../agent/providerModelCatalog';
import type { ProviderModelCatalogRequest, ProviderModelCatalogResult } from '../../shared/providerModelCatalog';
import { getCatalogInfo } from '../capabilities/catalog';
import { catalogWithSettingsPaths } from '../capabilities/catalog/settingsPaths';
import { SKILL_ROOT } from '../capabilities/catalog/runFactory';
import { resolveHostSkillRootDir } from '../metaAgent/hostDomainSkills';
import { getCapabilitiesView } from '../agent/capabilitiesView';
import { confirmRuntimeRegistration, runtimesHost } from '../capabilities/hosts/runtimes';
import { preflightAllRuntimes, preflightRuntime } from '../runtime/preflight';
import { invalidateRuntimeAvailability, readRuntimeAvailability } from '../runtime/availability';
import {
  ensureMetaAgentScaffold,
  patchWorkspaceFile,
  readWorkspaceFile
} from '../metaAgent/scaffold';
import { defaultWorkspaceFileConfig } from '../../shared/metaAgent';
import type { WorkspaceFileConfig, WorkspaceFileGetResult, WorkspaceFilePatchResult } from '../../shared/metaAgent';
import type { BookmarkChange, WorkspaceBookmarksResult } from '../../shared/bookmarks';
import { WorkspaceBookmarksStore } from '../metaAgent/workspaceBookmarks';
import { errorMessage } from '../../shared/errors';
import { closeWorkspaceCoordinated } from '../workspaceClose';
import { requestRendererOnce } from './rendererRequest';
import { getMemoryService } from '../memory/runtime';
import { applyLocaleSetting, t } from '../../shared/i18n';
import { RECOMMENDED_WORKSPACE_NAME, defaultWorkspaceRoot } from '../defaultWorkspaceRoot';
import { isConfirmed } from '../../shared/confirmDialog';
import { applyWorkspaceActivation, resolveWorkspaceControlRoot } from './helpers';
import { reapplyActiveTheme } from './themes';
import { assertConfigWorkspaceUnchanged } from '../workspaceConfigPatch';
import { readWorktreePreparation, saveWorktreePreparation } from '../git/worktreePreparationSettings';
import {
  getDevSandboxInfo,
  isDevSandboxEnabled,
  preCleanDevSandboxWorkspaces,
  resetDevSandbox,
  saveDevSandboxAsTemplate
} from '../devSandbox';

export function registerWorkspaceIpc(
  ctx: AppContext,
  orchestrator: Orchestrator,
  syncFsWatches: () => void,
  stopFsWatches: () => void = () => {}
): void {
  const closingWorkspaces = new Set<string>();
  const bookmarks = new WorkspaceBookmarksStore();
  const bookmarkOwner = (workspaceId: string) => {
    if (!workspaceId || ctx.config.get().activeWorkspaceId !== workspaceId) throw new Error(t('收藏夹尚未就绪'));
    const root = resolveWorkspaceControlRoot(ctx, workspaceId);
    const checkOwner = () => {
      if (closingWorkspaces.has(workspaceId) || resolveWorkspaceControlRoot(ctx, workspaceId) !== root) throw new Error(t('收藏夹尚未就绪'));
    };
    return { root, checkOwner };
  };
  handle('workspaceBookmarks:read', async (_e, workspaceId: string): Promise<WorkspaceBookmarksResult> => {
    try {
      const { root, checkOwner } = bookmarkOwner(workspaceId);
      return { ok: true, ...await bookmarks.read(root, checkOwner) };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  handle('workspaceBookmarks:change', async (_e, workspaceId: string, change: BookmarkChange): Promise<WorkspaceBookmarksResult> => {
    try {
      const { root, checkOwner } = bookmarkOwner(workspaceId);
      return { ok: true, snapshot: await bookmarks.change(root, checkOwner, change) };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  let openingWorkspace = false;
  handle('services:list', (_e, workspaceId?: string) => ({
    services: ctx.tasks.list(workspaceId ?? ctx.config.get().activeWorkspaceId)
  }));
  handle('services:get', (_e, serviceId: string) => ctx.tasks.get(serviceId));
  handle('services:runs', (_e, serviceId: string) => ({ runs: ctx.tasks.listRuns(serviceId) }));
  handle('services:create', (_e, opts: Parameters<typeof ctx.tasks.create>[0]) => ctx.tasks.create(opts));
  handle('services:update', (_e, serviceId: string, patch: Parameters<typeof ctx.tasks.update>[1]) => {
    const task = ctx.tasks.get(serviceId);
    if (!task) throw new Error(t('任务已不存在'));
    return ctx.tasks.update(serviceId, patch);
  });
  handle('services:runNow', (_e, serviceId: string) => ctx.tasks.runNow(serviceId));
  handle('services:enable', (_e, serviceId: string) => ctx.tasks.enable(serviceId));
  handle('services:disable', (_e, serviceId: string) => ctx.tasks.disable(serviceId));
  handle('services:delete', (_e, serviceId: string) => ctx.tasks.delete(serviceId));

  handle('config:get', () => ctx.config.get());
  handle('config:waitingTips', () => readWaitingTips(app.getPath('userData'), app.isPackaged
    ? path.join(process.resourcesPath, 'waiting-tips.json')
    : path.resolve(__dirname, '../../resources/waiting-tips.json')));
  handle('config:update', async (_e, patch: Partial<AppConfig>) => {
    const current = ctx.config.get();
    const { workerRoutingDefault, workerRoutingByWorkspace, workerRoutingWorkspaceRevisions, ...ordinaryPatch } = patch;
    for (const key of ['workerRoutingDefault', 'workerRoutingByWorkspace', 'workerRoutingWorkspaceRevisions'] as const) {
      if (Object.hasOwn(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(current[key])) {
        throw new Error('Use Worker routing settings to update tiers.');
      }
    }
    patch = ordinaryPatch;
    assertConfigWorkspaceUnchanged(current, patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'externalPi') && JSON.stringify(patch.externalPi) !== JSON.stringify(current.externalPi)) {
      throw new Error(t('请在 Harness 接入设置中更改外部 Pi 程序路径'));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'externalHarness') && JSON.stringify(patch.externalHarness) !== JSON.stringify(current.externalHarness)) {
      throw new Error(t('请在 Harness 接入设置中更改外部引擎程序路径'));
    }
    const prevLocale = current.locale;
    if (patch.modelParameterProfiles !== undefined) {
      if (!ctx.agentSessions) throw new Error('Session host unavailable');
      const profiles = await ctx.agentSessions.validateParameterProfiles(patch.modelParameterProfiles);
      patch = { ...patch, modelParameterProfiles: profiles };
    }
    // Model/provider settings are consumed by the next turn's connection identity.
    // Persisting them must not dispose a session that is still executing a turn.
    const sessionConfig = (value: AppConfig) => JSON.stringify({ ...value, llm: undefined, openai: undefined });
    const previousSessionConfig = sessionConfig(current);
    const next = ctx.config.update(patch);
    if(patch.memoryConsolidation!==undefined)await refreshMemoryCurators(ctx);
    if (['llm', 'openai', 'cursor', 'claude', 'defaultRuntime', 'disabledAcpAgents'].some(key => Object.prototype.hasOwnProperty.call(patch, key))) {
      ctx.getWindow()?.webContents.send('runtimes:availabilityChanged', {});
    }
    if (patch.mcp !== undefined || patch.mcpByWorkspace !== undefined) {
      ctx.getWindow()?.webContents.send('capabilityManagement:changed', { kind: 'mcp' });
    }
    if (patch.modelParameterProfiles !== undefined) await ctx.agentSessions!.refreshModelParameters();
    if (patch.workspaceAccentDefault !== undefined) {
      ctx.getWindow()?.webContents.send('workspaces:changed', {
        workspaces: next.workspaces,
        activeWorkspaceId: next.activeWorkspaceId,
        workspaceAccentDefault: next.workspaceAccentDefault
      });
    }
    if (previousSessionConfig !== sessionConfig(next)) orchestrator.invalidatePiSession();
    if (patch.tasksKeepAwake !== undefined) ctx.tasks.syncKeepAwake();
    // 语言变更：主进程自身文案同步 + 推送渲染层（他窗/后续水合保持一致）
    if (patch.locale !== undefined && patch.locale !== prevLocale) {
      applyLocaleSetting(next.locale, app.getLocale());
      ctx.getWindow()?.webContents.send('locale:changed', { locale: next.locale ?? 'system' });
    }
    return next;
  });
  handle(
    'config:testLlm',
    (_e, provider: { baseUrl: string; apiKey: string; model?: string; api?: import('../../shared/types').LlmApiProtocol; }) =>
      testLlmConnection(provider)
  );
  // pi-ai 内置目录（添加供应商/模型徽章数据源）；首开设置页时 prime，目录模块不可用返回 null（UI 回落静态 preset）
  handle('config:piCatalog', async () => {
    await primePiCatalogSnapshot();
    return getPiCatalogForUi();
  });
  handle('config:coreModelInput', async (_e, selection: { providerId: string; modelId: string }) => {
    await primePiCatalogSnapshot();
    const { model } = resolveLlmConfig(ctx.config.get(), selection);
    return { supportsImages: model.multimodal === true };
  });
  const providerCatalogs = new ProviderModelCatalogStore(app.getPath('userData'));
  handle('config:providerModelCatalog', async (_e, provider: ProviderModelCatalogRequest, refresh?: boolean): Promise<ProviderModelCatalogResult> => {
    try {
      if (!provider || typeof provider.id !== 'string' || typeof provider.baseUrl !== 'string' || typeof provider.apiKey !== 'string'
        || (provider.api !== undefined && typeof provider.api !== 'string')) throw new Error(t('模型目录请求无效'));
      return { ok: true, snapshot: refresh === true ? await providerCatalogs.refresh(provider) : providerCatalogs.read(provider) };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  handle('catalog:get', () => catalogWithSettingsPaths(getCatalogInfo(), SKILL_ROOT, resolveHostSkillRootDir()));
  handle('capabilities:get', () => getCapabilitiesView(ctx));

  // ---------- Agent Runtime 注册表（与 Catalog runtimes.* 同一 RuntimeHost）----------
  handle('runtimes:list', () => ctx.runtimes.list());
  handle('runtimes:register', async (_e, raw: RegisterRuntimeManifestArgs) => {
    try {
      const entry = await confirmRuntimeRegistration(ctx, raw);
      return entry ? { ok: true, entry } : { ok: false, cancelled: true };
    }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  handle('runtimes:availability', async (_e, force?: boolean) => {
    const snapshot = await readRuntimeAvailability(ctx, { force: force === true });
    if (force === true) ctx.getWindow()?.webContents.send('runtimes:availabilityChanged', {});
    return snapshot;
  });
  handle('runtimes:get', (_e, id: string) =>
    runtimesHost['runtimes.get'](ctx, { id: String(id ?? '') })
  );
  handle('runtimes:update', async (_e, args: UpdateRuntimeArgs) => {
    try {
      const { id, ...patch } = args;
      const entry = await ctx.runtimes.update(id, patch);
      return { ok: true, entry };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('runtimes:remove', async (_e, id: string) => {
    const existing = ctx.runtimes.get(id);
    const detail = [
      `id=${id}`,
      existing?.label ? `label=${existing.label}` : '',
      t('将删除条目与脚本文件')
    ]
      .filter(Boolean)
      .join('\n');
    const ok = await ctx.ui.confirm(t('删除 Agent Runtime'), detail);
    if (!isConfirmed(ok)) return { ok: false, cancelled: true };
    try {
      const removed = ctx.runtimes.remove(id);
      return { ok: true, ...removed };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('runtimes:restoreBuiltins', async (_e, ids?: string[]) => {
    const detail = ids?.length
      ? `ids=${ids.join(', ')}\n${t('将覆盖 userData 中对应脚本与条目')}`
      : `${t('全部开箱种子')}\n${t('将覆盖 userData 中对应脚本与条目')}`;
    const ok = await ctx.ui.confirm(t('恢复开箱 Agent Runtime'), detail);
    if (!isConfirmed(ok)) return { ok: false, cancelled: true };
    try {
      const entries = ctx.runtimes.restoreBuiltins(ids);
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  // 可用性预检（只读，无确认门）：设置页徽标与「检测」按钮用
  handle('runtimes:preflight', async (_e, args?: { id?: string; }) => {
    const id = typeof args?.id === 'string' ? args.id.trim() : '';
    try {
      if (id) {
        if (!ctx.runtimes.get(id)) return { ok: false, error: t('不存在: {{id}}', { id }) };
        return { ok: true, results: [await preflightRuntime(ctx, id)] };
      }
      return { ok: true, results: await preflightAllRuntimes(ctx) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('runtimes:setExternalPiExecutable', async (_e, args: { id?: unknown; executable?: unknown }) => {
    try {
      const id = args?.id;
      if ((id !== 'pi-external' && id !== 'omp') || typeof args?.executable !== 'string') throw new Error(t('外部 Pi 配置无效'));
      const executable = args.executable.trim();
      if (executable.length > 4096 || /[\u0000-\u001f]/.test(executable) || (executable && !path.isAbsolute(executable))) {
        throw new Error(t('请输入绝对路径，或留空使用自动发现'));
      }
      const current = ctx.config.get().externalPi;
      if ((current?.[id]?.executable ?? '') === executable) return { ok: true as const, externalPi: current };
      const next = { ...(ctx.config.get().externalPi ?? {}) };
      if (executable) next[id] = { executable };
      else delete next[id];
      const externalPi = ctx.config.update({ externalPi: next }).externalPi;
      ctx.runtimes.changed();
      ctx.getWindow()?.webContents.send('runtimes:availabilityChanged', {});
      return { ok: true as const, externalPi };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message || String(error) };
    }
  });
  handle('runtimes:setExternalHarnessExecutable', async (_e, args: { id?: unknown; executable?: unknown }) => {
    try {
      const id = args?.id;
      if ((id !== 'muse-gui' && id !== 'zcode-gui') || typeof args?.executable !== 'string') throw new Error(t('外部引擎配置无效'));
      const executable = args.executable.trim();
      if (executable.length > 4096 || /[\u0000-\u001f]/.test(executable) || (executable && !path.isAbsolute(executable))) {
        throw new Error(t('请输入绝对路径，或留空使用自动发现'));
      }
      const current = ctx.config.get().externalHarness;
      if ((current?.[id]?.executable ?? '') === executable) return { ok: true as const, externalHarness: current };
      const next = { ...(ctx.config.get().externalHarness ?? {}) };
      if (executable) next[id] = { executable };
      else delete next[id];
      const externalHarness = ctx.config.update({ externalHarness: next }).externalHarness;
      invalidateRuntimeAvailability(ctx.runtimes);
      ctx.runtimes.changed();
      ctx.getWindow()?.webContents.send('runtimes:availabilityChanged', {});
      return { ok: true as const, externalHarness };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message || String(error) };
    }
  });
  // P2：清除各工作区由宿主安装的状态检测 hooks（只删带 muster-hook-v1 标记的条目）
  handle('runtimes:clearDetectHooks', async () => {
    const ok = await ctx.ui.confirm(
      t('清除检测 hooks'),
      t('将移除各工作区 .claude/settings.local.json、.cursor/hooks.json 与 .gemini/settings.json 中由 Muster Console 安装的状态 hooks。\n用户自己的 hooks 保留；下次拉起会话时会重新安装。')
    );
    if (!isConfirmed(ok)) return { ok: false, cancelled: true };
    let removed = 0;
    const files: string[] = [];
    try {
      for (const w of ctx.config.get().workspaces) {
        if (!w.path) continue;
        for (const rt of ctx.runtimes.listEnabled()) {
          try {
            const res = await ctx.runtimes.uninstallDetectHooks(rt.id, w.path);
            removed += res.removed;
            if (res.removed > 0 && res.file) files.push(res.file);
          } catch {
            /* 该 runtime 无 hooks 能力或文件不可写，跳过 */
          }
        }
      }
      return { ok: true, removed, files };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle('workspaces:list', () => ({
    workspaces: ctx.workspaces.list(),
    activeWorkspaceId: ctx.config.get().activeWorkspaceId,
    recommendedRoot: defaultWorkspaceRoot(),
    recommendedName: RECOMMENDED_WORKSPACE_NAME
  }));
  handle('workspaces:getWorktreePreparation', (_e, workspaceId: string) => readWorktreePreparation(ctx.config.get(), workspaceId));
  handle('workspaces:saveWorktreePreparation', (_e, input: import('../../shared/worktreePreparation').WorktreePreparationUpdate) => saveWorktreePreparation(ctx.config.get(), input));
  handle('workspaces:pickDir', async (_e, multiple?: boolean) => ctx.workspaces.pickDirectory(multiple === true));
  handle('workspaces:open', async (_e, arg?: string | WorkspaceOpenOptions) => {
    if (openingWorkspace || closingWorkspaces.size) return { ok: false, message: 'Workspace transition is pending' };
    openingWorkspace = true;
    try {
      const res = await ctx.workspaces.open(arg);
      if(res.ok)restoreMemoryCurators(ctx);
      if (res.ok) ctx.sessions.broadcast();
      // 新开即激活：走统一激活入口（含 extensions.setActiveWorkspace 重绑，勿再手抄序列）
      return applyWorkspaceActivation(ctx, orchestrator, syncFsWatches, res);
    } finally { openingWorkspace = false; }
  });
  handle('workspaces:switch', (_e, id: string) => {
    if (closingWorkspaces.size) return { ok: false, message: 'Workspace close is pending' };
    const res = ctx.workspaces.switchTo(id);
    return applyWorkspaceActivation(ctx, orchestrator, syncFsWatches, res);
  });
  handle(
    'workspaces:update',
    (
      _e,
      id: string,
      opts: WorkspaceUpdateOptions
    ) => {
      if (closingWorkspaces.has(id)) return { ok: false, message: 'Workspace close is pending' };
      const before = ctx.config.get().workspaces.find(workspace => workspace.id === id);
      const identity = (workspace: typeof before): string => JSON.stringify(workspace && [workspace.path, workspace.controlRoot, workspace.rootsRevision, workspace.defaultRootId, workspace.roots]);
      const previousIdentity = identity(before);
      const res = ctx.workspaces.updateMeta(id, opts ?? {});
      if (res.ok) {
        if (identity((res.workspaces ?? ctx.config.get().workspaces).find(workspace => workspace.id === id)) !== previousIdentity) ctx.extensionSystem?.refresh();
        ctx.getWindow()?.webContents.send('workspaces:changed', {
          workspaces: res.workspaces,
          activeWorkspaceId: res.activeWorkspaceId
        });
      }
      return res;
    }
  );
  handle('workspaces:close', async (_e, id: string) => {
    if (openingWorkspace) return { ok: false, message: 'Workspace open is pending' };
    if (closingWorkspaces.has(id)) return { ok: false, message: 'Workspace close is already pending' };
    closingWorkspaces.add(id);
    let prevActive = ctx.config.get().activeWorkspaceId;
    let preparedWindow: import('electron').BrowserWindow | undefined;
    try {
    const res = await closeWorkspaceCoordinated(ctx, id, async workspaceId => {
      const win = ctx.getWindow();
      if (!win || win.isDestroyed()) throw new Error('Workspace renderer is unavailable');
      let preparationId = '';
      const response = await requestRendererOnce(win, { requestChannel: 'workspace:close-prepare-request', prefix: 'workspace:close-prepare',
        payload: { workspaceId }, timeoutMs: 30000, requireSource: true, requireMainFrame: true,
        closedChannel: 'workspace:close-prepare-closed', onTimeout: () => ({ ok: false, error: 'Workspace file preparation timed out' }),
        map: (payload, requestId) => {
          const value = payload as { ok?: unknown; error?: unknown } | null;
          if (value?.ok === true) { preparationId = requestId; return { ok: true }; }
          return { ok: false, error: typeof value?.error === 'string' ? value.error : 'Invalid workspace preparation reply' };
        } });
      if (!response.ok || !preparationId) throw new Error(response.error ?? 'Workspace file preparation failed');
      const finish = async (committed: boolean): Promise<void> => {
        try {
          const result = await requestRendererOnce(win, { requestChannel: 'workspace:close-finish-request', prefix: 'workspace:close-finish',
            payload: { workspaceId, preparationId, committed }, timeoutMs: 30000, requireSource: true, requireMainFrame: true,
            onTimeout: () => ({ ok: false, error: 'Workspace file cleanup timed out' }), map: payload => {
              const value = payload as { ok?: unknown; error?: unknown } | null;
              return value?.ok === true ? { ok: true } : { ok: false, error: typeof value?.error === 'string' ? value.error : 'Invalid workspace cleanup reply' };
            } });
          if (!result.ok) throw new Error(result.error);
        } catch (error) {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('workspace:close-abort', { preparationId });
          throw error;
        }
      };
      if (ctx.getWindow() !== win || win.isDestroyed()) { await finish(false); throw new Error('Workspace renderer changed during preparation'); }
      preparedWindow = win;
      return { rollback: () => finish(false), commit: async result => {
        let postCloseError: unknown;
        try { applyClosedWorkspace(result, win); } catch (error) { postCloseError = error; }
        await finish(true);
        if (postCloseError) throw postCloseError;
      } };
    }, () => {
      if (!preparedWindow || preparedWindow.isDestroyed() || ctx.getWindow() !== preparedWindow) throw new Error('Workspace renderer changed during preparation');
      prevActive = ctx.config.get().activeWorkspaceId;
    });
    return res;
    } finally { closingWorkspaces.delete(id); }

    function applyClosedWorkspace(res: import('../../shared/types').WorkspaceSwitchResult, win: import('electron').BrowserWindow): void {
      try {
      void closeMemoryCurator(ctx,id).catch(error=>console.error('[memory-curator] 工作区关闭失败',id,error));
      ctx.schedulerStatus.remove(id);
    if (res.activeWorkspaceId) {
      if (res.activeWorkspaceId !== prevActive) {
        // 关掉的是活跃区：回退区同样要重绑 extensions（与 applyWorkspaceActivation 同步）
        ctx.extensionSystem?.refresh();
        ctx.sessions.adoptActiveForWorkspace(res.activeWorkspaceId);
        try {
          orchestrator.bindWorkspace(res.activeWorkspaceId);
        } catch (err) {
          console.error('[workspace close] scheduler rebind failed', err);
          throw new Error(errorMessage(err));
        }
      }
      reapplyActiveTheme(ctx);
    }
    // 删到零个也要同步：否则最后关闭的工作区仍留着文件监听句柄。
    syncFsWatches();
    ctx.extensionSystem?.refresh();
    ctx.sessions.broadcast();
      } finally {
        // 零工作区同样必须广播，否则渲染层停在旧列表，新建引导面板不会回来。
        const payload = {
          workspaces: res.workspaces ?? ctx.workspaces.list(),
          activeWorkspaceId: res.activeWorkspaceId ?? ''
        };
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('workspaces:changed', payload);
        const current = ctx.getWindow();
        if (current && current !== win && !current.isDestroyed()) current.webContents.send('workspaces:changed', payload);
      }
    }
  });

  handle('workspaceFile:get', (): WorkspaceFileGetResult => {
    const workspaceId = ctx.config.get().activeWorkspaceId;
    // 零工作区时没有管理根，返回缺省配置而不是抛错：渲染层挂载即拉该文件，
    // 让 requireWorkspace 抛错会留下永远 pending 的 ready 态和未处理拒绝。
    if (!workspaceId) return { workspaceId: '', config: defaultWorkspaceFileConfig() };
    const root = resolveWorkspaceControlRoot(ctx, workspaceId);
    try {
      ensureMetaAgentScaffold(root);
    } catch (err) {
      console.error('[workspaceFile:get] scaffold failed', root, err);
    }
    return { workspaceId, config: readWorkspaceFile(root) };
  });
  handle('workspaceFile:get-for-workspace', (_e, workspaceId: string): WorkspaceFileGetResult => {
    if (!workspaceId) throw new Error('Workspace id is required');
    const root = resolveWorkspaceControlRoot(ctx, workspaceId);
    try {
      ensureMetaAgentScaffold(root);
    } catch (err) {
      console.error('[workspaceFile:get-for-workspace] scaffold failed', root, err);
    }
    return { workspaceId, config: readWorkspaceFile(root) };
  });
  handle(
    'workspaceFile:patch',
    (_e, patch: Partial<WorkspaceFileConfig>, workspaceId: string): WorkspaceFilePatchResult => {
      const activeId = ctx.config.get().activeWorkspaceId;
      if (!workspaceId || workspaceId !== activeId) {
        return { ok: false, stale: true };
      }
      const root = resolveWorkspaceControlRoot(ctx, activeId);
      try {
        ensureMetaAgentScaffold(root);
      } catch (err) {
        console.error('[workspaceFile:patch] scaffold failed', root, err);
      }
      const config = patchWorkspaceFile(root, patch);
      return { ok: true, workspaceId: activeId, config };
    }
  );

  // ---------- Dev Sandbox 隔离沙箱 ----------
  handle('sandbox:getInfo', (): SandboxInfo => {
    const info = getDevSandboxInfo();
    if (!info || !isDevSandboxEnabled()) {
      return { enabled: false };
    }
    return {
      enabled: true,
      rootDir: info.rootDir,
      userDataDir: info.userDataDir,
      workspacesDir: info.workspacesDir,
      templateDir: info.templateDir,
      hasTemplate: info.hasTemplate
    };
  });

  handle('sandbox:save', async () => {
    const info = getDevSandboxInfo();
    if (!info || !isDevSandboxEnabled()) {
      return { ok: false, message: t('当前未处于 Dev Sandbox 沙箱模式') };
    }
    return saveDevSandboxAsTemplate();
  });

  handle('sandbox:reset', async (_e, opts?: { cleanWorkspaces?: boolean; cleanUserData?: boolean; }) => {
    const info = getDevSandboxInfo();
    if (!info || !isDevSandboxEnabled()) {
      return { ok: false, message: t('当前未处于 Dev Sandbox 沙箱模式') };
    }

    // 终止正在运行的全部终端子进程，并取消待执行的会话落盘防抖
    await ctx.pty.killAllAndWait();
    ctx.sessions.cancelPersist();
    // Windows 上 recursive fs.watch 句柄会锁住工作区目录，不停 watcher 则
    // 还原时 rmSync 直接 EPERM、重置静默失败（test/e2e/sandbox-fixture.spec.ts 拦截）。
    // 预清理走 fs.promises.rm 的 maxRetries（杀软/索引器短暂锁新文件同样致 EPERM）
    stopFsWatches();
    // A2-3-1：沙箱工作区里的记忆库 SQLite 句柄同样锁文件（WAL 模式）——先关库
    // 再清理（对齐 index.ts before-quit 的 closeAll 同款；close 自带 WAL checkpoint，
    // 同线程同步写不存在在途写跨关）。preClean 加 30s 看门狗：卡死显式报错不再静默挂死
    getMemoryService()?.closeAll();
    let watchdog: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        preCleanDevSandboxWorkspaces(),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error(t('沙箱工作区预清理超时（30s），已中止本次重置'))),
            30_000
          );
        })
      ]);
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    } finally {
      clearTimeout(watchdog);
    }

    const res = resetDevSandbox(opts);
    if (!res.ok) return res;

    // 重新加载配置并激活 default 工作区
    ctx.config.reloadFromDisk();
    const cfg = ctx.config.get();
    const primaryId = cfg.workspaces[0]?.id || cfg.activeWorkspaceId;
    const switchRes = ctx.workspaces.switchTo(primaryId);
    applyWorkspaceActivation(ctx, orchestrator, syncFsWatches, switchRes);

    // 重新同步内存中的会话，并向渲染层广播（通知已是纯内存 toast 账本，无盘态可重载）
    ctx.sessions.reloadFromDisk();

    ctx.getWindow()?.webContents.send('workspaces:changed', {
      workspaces: switchRes.workspaces,
      activeWorkspaceId: switchRes.activeWorkspaceId
    });

    return { ok: true };
  });

  handle('sandbox:openDir', async () => {
    const info = getDevSandboxInfo();
    if (!info?.rootDir) {
      return { ok: false, error: t('沙箱目录不存在') };
    }
    try {
      await shell.openPath(info.rootDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
