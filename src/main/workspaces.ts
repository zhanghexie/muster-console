import { dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from './config';
import { defaultWorkspaceRoot } from './defaultWorkspaceRoot';
import { defaultCwdFor, normalizeWorkspaceRoots, sourcePathKey, sourceRootsFor } from './workspacePaths';
import { registeredControlRootFor } from '../shared/workspaceRoots';
import { pathKey } from './pathKey';
import type {
  WorkspaceInfo,
  WorkspaceOpenOptions,
  WorkspaceRoot,
  WorkspaceRootDependency,
  WorkspaceSwitchResult,
  WorkspaceUpdateOptions
} from '../shared/types';
import { t } from '../shared/i18n';
import { applyWorkspaceAccentPatch, hasAccentPatch } from '../shared/workspaceAccent';

function displayName(root: string): string {
  const base = path.basename(root.replace(/[\\/]+$/, ''));
  return base || root;
}

function normalizeOpenArg(
  arg?: string | WorkspaceOpenOptions
): WorkspaceOpenOptions {
  if (arg == null) return {};
  if (typeof arg === 'string') return { path: arg };
  return arg;
}

/** 已打开逻辑工作区登记 / 切换；config.workspace 始终投影为 active 的默认 cwd。 */
export class WorkspaceService {
  private rootRemovalGuard?: (workspace: WorkspaceInfo, removed: readonly WorkspaceRoot[]) => string | readonly WorkspaceRootDependency[] | undefined;

  constructor(private config: ConfigManager) {}

  /** 主进程接入会话/队列/隔离依赖检查；未接入时不能移除根。 */
  setRootRemovalGuard(guard: (workspace: WorkspaceInfo, removed: readonly WorkspaceRoot[]) => string | readonly WorkspaceRootDependency[] | undefined): void {
    this.rootRemovalGuard = guard;
  }

  list(): WorkspaceInfo[] {
    return this.config.get().workspaces.slice();
  }

  active(): WorkspaceInfo | undefined {
    const c = this.config.get();
    return c.workspaces.find((w) => w.id === c.activeWorkspaceId);
  }

  activePath(): string {
    const active = this.active();
    if (!active) throw new Error('workspace not found');
    return defaultCwdFor(active);
  }

  /** 仅选目录，不打开工作区 */
  async pickDirectory(multiple = false): Promise<{ ok: boolean; path?: string; paths?: string[]; message?: string }> {
    const r = await dialog.showOpenDialog({
      title: t('选择工作区目录'),
      properties: multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory']
    });
    if (r.canceled || !r.filePaths[0]) {
      return { ok: false, message: 'cancelled' };
    }
    const paths = r.filePaths.map((p) => path.resolve(p));
    return { ok: true, path: paths[0], ...(multiple ? { paths } : {}) };
  }

  /** 打开目录为工作区；已打开则切换过去。兼容旧调用 open(dirPath?) */
  async open(arg?: string | WorkspaceOpenOptions): Promise<WorkspaceSwitchResult> {
    const opts = normalizeOpenArg(arg);
    // 新建页的推荐根可能还不存在：只在提交时、且目标确实是推荐根时
    // 才落盘，避免首启凭空建目录，也不给任意路径开自动建目录的口子。
    if (opts.ensureRecommendedRoot) {
      const recommended = path.resolve(defaultWorkspaceRoot());
      const targets = opts.roots?.map((root) => root.path) ?? (opts.path?.trim() ? [opts.path.trim()] : []);
      if (targets.some((target) => pathKey(path.resolve(target)) === pathKey(recommended))) {
        try {
          fs.mkdirSync(recommended, { recursive: true });
          if (!fs.statSync(recommended).isDirectory()) {
            throw new Error(`not a directory: ${recommended}`);
          }
        } catch (err) {
          return { ok: false, message: t('无法创建推荐目录 {{path}}：{{err}}', { path: recommended, err: String(err) }) };
        }
      }
    }
    if (opts.roots !== undefined) {
      try {
        if (!Array.isArray(opts.roots) || !opts.roots.length) throw new Error(t('至少保留一个源文件夹'));
        for (const root of opts.roots) {
          if (!root || typeof root.id !== 'string' || !root.id || typeof root.path !== 'string' || !path.isAbsolute(root.path) || !fs.statSync(root.path).isDirectory()) {
            throw new Error(t('不是有效目录'));
          }
        }
      } catch (err) { return { ok: false, message: (err as Error).message }; }
    }
    let resolved = opts.roots?.length ? opts.roots[0].path : opts.path?.trim() ? path.resolve(opts.path.trim()) : '';
    if (!resolved) {
      const picked = await this.pickDirectory();
      if (!picked.ok || !picked.path) {
        return { ok: false, message: picked.message ?? 'cancelled' };
      }
      resolved = picked.path;
    }

    try {
      if (!fs.statSync(resolved).isDirectory()) {
        return { ok: false, message: t('不是有效目录') };
      }
    } catch {
      return { ok: false, message: t('目录不存在') };
    }

    const c = this.config.get();
    const controlRoot = opts.roots
      ? opts.roots.find((r) => r.id === (opts.controlRootId ?? opts.roots![0].id))?.path
      : resolved;
    if (!controlRoot) return { ok: false, message: t('管理根不在源文件夹列表中') };
    const key = sourcePathKey(controlRoot);
    const existing = c.workspaces.find((w) => !w.rootsError && sourcePathKey(registeredControlRootFor(w)) === key);
    if (existing) {
      if (opts.roots !== undefined) {
        return { ok: false, message: t('管理根已被其他工作区使用，请选择其他文件夹') };
      }
      // 已存在：可更新名称/头像后切过去
      const name = opts.name?.trim();
      const avatar = opts.avatar?.trim();
      if (name || avatar) {
        const workspaces = c.workspaces.map((w) => {
          if (w.id !== existing.id) return w;
          return {
            ...w,
            ...(name ? { name } : {}),
            ...(avatar ? { avatar } : {})
          };
        });
        this.config.update({ workspaces });
      }
      return this.switchTo(existing.id);
    }

    const closed = c.closedWorkspaces?.find(w => sourcePathKey(w.rootsError ? w.path : registeredControlRootFor(w)) === key);
    if (closed) {
      if (closed.rootsError) return { ok: false, message: closed.rootsError };
      const restored = { ...closed, ...(opts.name?.trim() ? { name: opts.name.trim() } : {}),
        ...(opts.avatar?.trim() ? { avatar: opts.avatar.trim() } : {}) };
      this.config.update({ workspaces: [...c.workspaces, restored],
        closedWorkspaces: c.closedWorkspaces?.filter(w => w.id !== closed.id),
        activeWorkspaceId: closed.id, workspace: defaultCwdFor(restored) });
      return this.snapshot(true);
    }

    let ws: WorkspaceInfo = {
      id: randomUUID(),
      path: resolved,
      name: opts.name?.trim() || displayName(resolved),
      openedAt: Date.now()
    };
    try {
      if (opts.roots) {
        ws = normalizeWorkspaceRoots({ ...ws, roots: opts.roots, defaultRootId: opts.defaultRootId ?? opts.roots[0].id, controlRoot });
      } else ws = normalizeWorkspaceRoots(ws);
    } catch (err) { return { ok: false, message: (err as Error).message }; }
    if (opts.avatar?.trim()) ws.avatar = opts.avatar.trim();
    if (hasAccentPatch(opts)) ws = applyWorkspaceAccentPatch(ws, opts);

    this.config.update({
      workspaces: [...c.workspaces, ws],
      activeWorkspaceId: ws.id,
      workspace: defaultCwdFor(ws)
    });
    return this.snapshot(true);
  }

  /** 更新元数据/源根，不切换 active，也不更改已有会话 cwd。 */
  updateMeta(id: string, opts: WorkspaceUpdateOptions): WorkspaceSwitchResult {
    const c = this.config.get();
    const ws = c.workspaces.find((w) => w.id === id);
    if (!ws) return { ok: false, message: t('工作区不存在') };
    if (opts.expectedRootsRevision !== undefined && opts.expectedRootsRevision !== (ws.rootsRevision ?? 0)) {
      return { ok: false, message: t('源文件夹已变更，请重新打开工作区设置') };
    }
    const name = opts.name?.trim();
    const avatar = opts.avatar?.trim();
    let sourcePatch: WorkspaceInfo | undefined;
    if (opts.roots !== undefined || opts.defaultRootId !== undefined) {
      if (opts.expectedRootsRevision !== (ws.rootsRevision ?? 0)) {
        return { ok: false, message: t('源文件夹已变更，请重新打开工作区设置') };
      }
      try {
        const previous = sourceRootsFor(ws);
        const roots = opts.roots ?? previous;
        const seen = new Set<string>();
        for (const root of roots) {
          const existing = previous.find((r) => r.id === root.id);
          if (existing && pathKey(existing.path) !== pathKey(root.path)) {
            throw new Error(t('不能直接修改源文件夹路径，请先解除关联再添加'));
          }
          if (!existing && (!path.isAbsolute(root.path) || !fs.statSync(root.path).isDirectory())) throw new Error(t('不是有效目录'));
          const key = sourcePathKey(root.path);
          if (seen.has(key)) throw new Error(t('源文件夹已在列表中'));
          seen.add(key);
        }
        const canonical = normalizeWorkspaceRoots(ws);
        sourcePatch = normalizeWorkspaceRoots({ ...canonical, roots: [...roots], defaultRootId: opts.defaultRootId ?? ws.defaultRootId });
        const removed = previous.filter((r) => !sourcePatch!.roots!.some((next) => next.id === r.id));
        if (removed.length) {
          const blocked = this.rootRemovalGuard ? this.rootRemovalGuard(ws, removed) : t('源文件夹依赖检查尚未就绪，暂不能移除');
          if (typeof blocked === 'string' && blocked) return { ok: false, message: blocked };
          if (Array.isArray(blocked) && blocked.length) {
            const dependencies = blocked as WorkspaceRootDependency[];
            const labels: Record<WorkspaceRootDependency['kind'], string> = {
              session: t('运行中会话'), worktree: t('隔离 worktree'), 'queued-task': t('排队任务'), service: t('定时服务'),
              'background-task': t('后台任务'), launch: t('正在创建会话'), 'open-file': t('打开的文件'), 'file-write': t('正在保存文件'), 'file-delete': t('正在删除文件')
            };
            const details = dependencies.slice(0, 20).map(use => `${labels[use.kind]}：${use.label}`).join('；');
            return { ok: false, rootDependencies: structuredClone(dependencies), message: t('源文件夹仍在使用，请先处理以下依赖：{{details}}', { details }) };
          }
        }
      } catch (err) { return { ok: false, message: (err as Error).message }; }
    }
    if (
      !name &&
      avatar === undefined &&
      !sourcePatch &&
      !hasAccentPatch(opts)
    ) {
      return this.snapshot(true);
    }
    const workspaces = c.workspaces.map((w) => {
      if (w.id !== id) return w;
      const base = sourcePatch ?? w;
      const next = hasAccentPatch(opts) ? applyWorkspaceAccentPatch(base, opts) : { ...base };
      if (name) next.name = name;
      if (opts.avatar !== undefined) {
        if (avatar) next.avatar = avatar;
        else delete next.avatar;
      }
      return next;
    });
    this.config.update({ workspaces });
    return this.snapshot(true);
  }

  switchTo(id: string): WorkspaceSwitchResult {
    const c = this.config.get();
    const ws = c.workspaces.find((w) => w.id === id);
    if (!ws) return { ok: false, message: t('工作区不存在') };
    if (c.activeWorkspaceId === id) {
      return this.snapshot(true);
    }
    this.config.update({
      activeWorkspaceId: id,
      workspace: defaultCwdFor(ws)
    });
    return this.snapshot(true);
  }

  /** 从已打开列表移除（不杀 pty）；允许删到零个，渲染层会重新常驻新建引导面板 */
  closeError(id: string): string | undefined {
    const workspaces = this.config.get().workspaces;
    if (!workspaces.some(workspace => workspace.id === id)) return t('工作区不存在');
    return undefined;
  }

  close(id: string): WorkspaceSwitchResult {
    const c = this.config.get();
    const error = this.closeError(id);
    if (error) return { ok: false, message: error };
    const next = c.workspaces.filter((w) => w.id !== id);
    let activeId = c.activeWorkspaceId;
    let workspace = c.workspace;
    if (activeId === id) {
      // 删掉最后一个：无活动区，cwd 投影保留原值供下次推荐/迁移参考。
      activeId = next[0]?.id ?? '';
      if (next[0]) workspace = defaultCwdFor(next[0]);
    }
    this.config.update({
      workspaces: next,
      closedWorkspaces: [...(c.closedWorkspaces ?? []), c.workspaces.find(w => w.id === id)!],
      activeWorkspaceId: activeId,
      workspace
    });
    return this.snapshot(true);
  }

  private snapshot(ok: boolean, message?: string): WorkspaceSwitchResult {
    const c = this.config.get();
    return {
      ok,
      message,
      workspaces: c.workspaces.slice(),
      activeWorkspaceId: c.activeWorkspaceId
    };
  }
}
