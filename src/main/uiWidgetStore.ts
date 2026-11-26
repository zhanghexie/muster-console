import { userDataStorage } from './runtimeKernel/storageRootResolver';
import { readFile, writeFile, rename, stat, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { uiWidgetSessionDirectory, uiWidgetSessionFromDirectory } from '../shared/uiWidgetSession';
import { randomUUID } from 'node:crypto';
import {
  emptyUiWidgetState, mergeUiWidgetState, uiWidgetIdentity, compactUiWidgetState, sanitizeUiWidgetDiagnostics,
  type UiWidgetReceipt, type UiWidgetSnapshot, type UiWidgetState
} from '../shared/uiWidgetProtocol';
import { buildUiArtifactHtml, UI_ARTIFACT_MAX_BYTES } from './uiArtifacts';
import { validateUiRender, type UiRenderParams } from '../shared/uiRender';

interface StoredWidget { state: UiWidgetState; receipt: UiWidgetReceipt; }

/** Windows may briefly deny replacement while an indexer/reader holds the destination. */
export async function replaceUiWidgetFile(temporary: string, destination: string, replace = rename): Promise<void> {
  try {
    for (let attempt = 0; ; attempt++) {
      try { await replace(temporary, destination); return; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/** This store only accepts artifacts inside the calling app's session UI directory. */
export class UiWidgetStore {
  private queues = new Map<string, Promise<unknown>>();
  /** Live presentation receipts are isolated per surface and never persisted as live instances. */
  private receipts = new Map<string, Map<string, UiWidgetReceipt>>();
  constructor(private readonly userData: string) {}

  private async resolve(filePath: string): Promise<string> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('部件路径无效');
    const root = userDataStorage(this.userData).resolve('app', 'agent-sessions');
    const target = path.resolve(filePath);
    const parts = path.relative(root, target).split(path.sep);
    let validSessionDirectory = false;
    try { validSessionDirectory = uiWidgetSessionDirectory(uiWidgetSessionFromDirectory(parts[0]!)) === parts[0]; } catch { /* reject invalid directory */ }
    if (parts.length !== 3 || !validSessionDirectory || parts[1] !== 'ui' ||
      !/^\d+-.+\.(inline|browser)\.html$/i.test(parts[2]!)) throw new Error('部件不属于当前应用的会话目录');
    const [actualRoot, actualTarget] = await Promise.all([realpath(root), realpath(target)]);
    const relative = path.relative(actualRoot, actualTarget);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('部件实际路径越界');
    if (uiWidgetIdentity(relative) !== uiWidgetIdentity(parts.join(path.sep))) throw new Error('部件实际路径越界（跨会话或文件别名）');
    if (!(await stat(actualTarget)).isFile()) throw new Error('部件文件不存在');
    return target;
  }

  private statePath(filePath: string): string { return `${filePath}.state.json`; }

  private async readStored(filePath: string): Promise<StoredWidget> {
    try {
      const raw = JSON.parse(await readFile(this.statePath(filePath), 'utf8')) as StoredWidget;
      const state = mergeUiWidgetState(emptyUiWidgetState(), {
        modelContent: raw.state.modelContent, privateContent: raw.state.privateContent,
        presentation: raw.state.presentation
      });
      state.revision = Number.isSafeInteger(raw.state.revision) && raw.state.revision >= 0 ? raw.state.revision : 0;
      const receipt = raw.receipt;
      if (!receipt || !['generated', 'mounted', 'rendered', 'degraded', 'failed'].includes(receipt.status)) {
        throw new Error('部件回执数据无效');
      }
      // Visibility is a live-process fact; a persisted receipt alone cannot
      // prove that its former presentation still exists after a restart.
      const live = [...(this.receipts.get(uiWidgetIdentity(filePath))?.values() ?? [])];
      return { state, receipt: [...live].reverse().find(item => item.visible) ?? live.at(-1) ?? { ...receipt, visible: false } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { state: emptyUiWidgetState(), receipt: { status: 'generated', visible: false, updatedAt: Date.now() } };
    }
  }

  private async serial<T>(filePath: string, run: () => Promise<T>): Promise<T> {
    const key = uiWidgetIdentity(filePath);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.queues.set(key, next);
    try { return await next; }
    finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }

  private async persist(filePath: string, value: StoredWidget): Promise<void> {
    const destination = this.statePath(filePath);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    // A late state write must not recreate a deleted session's UI directory.
    await writeFile(temporary, JSON.stringify({ ...value, state: compactUiWidgetState(value.state) }), { encoding: 'utf8', flag: 'wx' });
    await replaceUiWidgetFile(temporary, destination);
  }

  private async snapshot(filePath: string, value: StoredWidget): Promise<UiWidgetSnapshot> {
    const html = await readFile(filePath, 'utf8');
    let title = path.basename(filePath), artifactVersion = 1;
    const match = html.match(/<meta name="muster-ui" content='([^']*)'/);
    if (match) {
      const meta = JSON.parse(match[1]!.replace(/&#39;/g, "'").replace(/&lt;/g, '<')) as { title?: string; revision?: number };
      if (typeof meta.title === 'string') title = meta.title;
      if (typeof meta.revision === 'number') artifactVersion = meta.revision;
    }
    return { path: filePath.replace(/\\/g, '/'), title, artifactVersion, ...value };
  }

  async read(filePath: string): Promise<UiWidgetSnapshot> {
    const target = await this.resolve(filePath);
    return this.serial(target, async () => this.snapshot(target, await this.readStored(target)));
  }

  async list(sessionId: string): Promise<UiWidgetSnapshot[]> {
    const dir = path.join(userDataStorage(this.userData).resolve('app', 'agent-sessions'), uiWidgetSessionDirectory(sessionId), 'ui');
    let names: string[];
    try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const snapshots = [];
    for (const name of names.filter(name => /^\d+-.+\.(inline|browser)\.html$/i.test(name)).sort()) snapshots.push(await this.read(path.join(dir, name)));
    return snapshots;
  }

  async updateArtifact(filePath: string, params: unknown): Promise<UiWidgetSnapshot> {
    const target = await this.resolve(filePath);
    const issues = validateUiRender(params);
    if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
    return this.serial(target, async () => {
      const stored = await this.readStored(target), current = await this.snapshot(target, stored);
      const input = params as UiRenderParams;
      if (!target.endsWith(`.${input.mode ?? 'inline'}.html`)) throw new Error('更新须保留原部件的展示方式');
      const html = await readFile(target, 'utf8');
      const built = buildUiArtifactHtml(input, html.includes('data-theme="light"') ? 'light' : 'dark', current.artifactVersion + 1);
      if (Buffer.byteLength(built.html) > UI_ARTIFACT_MAX_BYTES) throw new Error(`更新内容超出 ${UI_ARTIFACT_MAX_BYTES / 1024} KiB`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, built.html, { encoding: 'utf8', flag: 'wx' }); await replaceUiWidgetFile(temporary, target);
      stored.receipt = { status: 'generated', visible: false, updatedAt: Date.now() };
      this.receipts.delete(uiWidgetIdentity(target));
      await this.persist(target, stored);
      return this.snapshot(target, stored);
    });
  }

  async writeState(filePath: string, patch: unknown): Promise<UiWidgetSnapshot> {
    const target = await this.resolve(filePath);
    return this.serial(target, async () => {
      const stored = await this.readStored(target);
      stored.state = mergeUiWidgetState(stored.state, patch);
      await this.persist(target, stored);
      return this.snapshot(target, stored);
    });
  }

  async writeReceipt(filePath: string, receipt: Omit<UiWidgetReceipt, 'updatedAt'>, source = 'legacy'): Promise<UiWidgetSnapshot> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('部件路径无效');
    const target = path.resolve(filePath);
    if (typeof source !== 'string' || !source || source.length > 200) throw new Error('部件回执来源无效');
    if (!receipt || !['generated', 'mounted', 'rendered', 'degraded', 'failed'].includes(receipt.status) || typeof receipt.visible !== 'boolean') {
      throw new Error('部件回执无效');
    }
    return this.serial(target, async () => {
      await this.resolve(target);
      const stored = await this.readStored(target);
      const key = uiWidgetIdentity(target), sources = this.receipts.get(key) ?? new Map<string, UiWidgetReceipt>();
      const previous = sources.get(source) ?? (source === 'legacy' ? stored.receipt : undefined);
      // Visibility/load callbacks may repeat a failure without its diagnostic payload.
      // Keep the original cause until an explicit recovery or a new artifact version.
      const error = typeof receipt.error === 'string' && receipt.error ? receipt.error :
        receipt.status === previous?.status && ['failed', 'degraded'].includes(receipt.status) ? previous.error : undefined;
      const next: UiWidgetReceipt = {
        status: receipt.status, visible: receipt.visible, updatedAt: Date.now(),
        ...(error ? { error: error.slice(0, 1000) } : {}),
        ...(['degraded', 'failed'].includes(receipt.status) ? { diagnostics: receipt.diagnostics ? sanitizeUiWidgetDiagnostics(receipt.diagnostics) : previous?.status === receipt.status ? previous.diagnostics ?? [] : [] } : {})
      };
      sources.delete(source); sources.set(source, next); this.receipts.set(key, sources);
      const rows = [...sources.values()];
      stored.receipt = [...rows].reverse().find(item => item.visible) ?? next;
      await this.persist(target, stored);
      return this.snapshot(target, stored);
    });
  }

  async releaseReceipt(filePath: string, source: string): Promise<void> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('部件路径无效');
    const target = path.resolve(filePath);
    if (typeof source !== 'string' || !source || source.length > 200) throw new Error('部件回执来源无效');
    await this.serial(target, async () => {
      const key = uiWidgetIdentity(target), sources = this.receipts.get(key);
      try { await this.resolve(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        sources?.delete(source);
        if (!sources?.size) this.receipts.delete(key);
        return;
      }
      if (!sources?.has(source)) return;
      const stored = await this.readStored(target);
      sources.delete(source);
      const rows = [...sources.values()];
      if (!rows.length) this.receipts.delete(key);
      stored.receipt = [...rows].reverse().find(item => item.visible) ?? rows.at(-1) ?? { ...stored.receipt, visible: false, updatedAt: Date.now() };
      await this.persist(target, stored);
    });
  }
}

const stores = new Map<string, UiWidgetStore>();
export function getUiWidgetStore(userData: string): UiWidgetStore {
  const key = uiWidgetIdentity(path.resolve(userData));
  let store = stores.get(key);
  if (!store) { store = new UiWidgetStore(userData); stores.set(key, store); }
  return store;
}
