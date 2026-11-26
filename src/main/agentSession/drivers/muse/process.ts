import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { winCmdLaunchArgs } from '../../../encoding/winUtf8';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { lookOnPath } from '../acp/agents';
import { NdjsonRpc } from '../acp/jsonRpc';
import type { AcpModelListResult } from '../acp/models';
import { boundedAcpRequest } from '../../processReclamation';
import { spawnOwnedProcess, type OwnedProcess } from '../../process/owner';
import { resolveExecutableOverride } from '../executableOverride';
import { ModelCatalogRefreshOrder } from '../../modelCatalogRefreshOrder';
import { ModelCatalogCache } from '../../modelCatalogCache';
import { museNativeConfig, readMuseProfiles } from './nativeConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';

export function musePath(preferred?: string): string | null {
  if (preferred?.trim()) return resolveExecutableOverride(preferred);
  const found = lookOnPath(['muse']);
  if (found) return found;
  const roots = [path.join(os.homedir(), '.local', 'bin')];
  if (process.platform === 'win32' && process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'));
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return lookOnPath(roots.flatMap(root => extensions.map(ext => path.join(root, `muse${ext}`))));
}

export function museLaunch(executable: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    if ([executable, ...args].some(value => value.includes('%'))) throw new Error('Muse 可执行路径或参数包含 %，无法安全启动 cmd 包装器');
    return { command: 'cmd.exe', args: winCmdLaunchArgs([executable, ...args]) };
  }
  return { command: executable, args };
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 512 && !/[\u0000-\u001f]/.test(v);
const catalogCache = new ModelCatalogCache<Extract<AcpModelListResult, { ok: true }>>('muse');
const refreshOrder = new ModelCatalogRefreshOrder();
const museCatalogKey = (cwd: string, override?: string, executable = musePath(override)) => JSON.stringify([cwd, override ?? '', nativeExecutableVersion(executable, 'muse-msp')]);
export function museModelCatalogRevision(cwd: string, override?: string): number { return catalogCache.revision(museCatalogKey(cwd, override)); }

/** User-initiated metadata discovery only: no session or inference is started. */
export async function listMuseModels(options: { cwd: string; executableOverride?: string; signal?: AbortSignal; refresh?: boolean }): Promise<AcpModelListResult> {
  const executable = musePath(options.executableOverride);
  const key = museCatalogKey(options.cwd, options.executableOverride, executable);
  if (!options.refresh) return structuredClone(catalogCache.get(key) ?? { ok: false, error: '尚未读取模型目录，请手动刷新' });
  const isCurrentRefresh = refreshOrder.begin(key);
  try { if (!fs.statSync(options.cwd).isDirectory()) throw new Error('not a directory'); }
  catch { return { ok: false, error: 'Muse 工作目录不存在或不可访问' }; }
  if (!executable) return { ok: false, error: options.executableOverride?.trim() ? '指定的 Muse 可执行路径无效，请修正或清除设置' : '未找到 Muse Code，请先安装并登录' };
  let owner: OwnedProcess<ChildProcessWithoutNullStreams> | undefined;
  let rpc: NdjsonRpc | undefined;
  let result: AcpModelListResult;
  const secrets = collectEnvSecrets(process.env);
  const diagnostic = (error: unknown): string => redactSafetyText(error instanceof Error ? error.message : String(error), secrets).slice(0, 800);
  try {
    const cmd = museLaunch(executable, ['serve']);
    owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
      command: cmd.command,
      args: cmd.args,
      windows: { kind: 'taskkill' },
      spawnOptions: { cwd: options.cwd, env: { ...genericWorkerEnvironment(), MUSE_LOGIN: '0' },
        windowsVerbatimArguments: process.platform === 'win32' && path.basename(cmd.command).toLowerCase() === 'cmd.exe',
        stdio: ['pipe', 'pipe', 'pipe'] }
    });
    const child = owner.child;
    rpc = new NdjsonRpc(child.stdin, child.stdout);
    child.on('error', error => rpc?.failExternal(error));
    child.stderr.resume();
    rpc.on('message', message => { if (message.id != null) rpc?.respondError(message.id, '模型目录发现不支持交互请求'); });
    rpc.on('parse-error', () => rpc?.failExternal(new Error('Muse 模型目录返回无效 JSON')));
    await boundedAcpRequest(owner.ready, 20_000, 'Muse 模型发现进程启动', options.signal);
    if (owner.state !== 'ready') throw new Error('Muse 模型发现进程已退出或正在回收');
    await boundedAcpRequest(rpc.request('initialize', { clientInfo: { name: 'muster-workbench', title: 'muster Workbench', version: '0.1' },
      capabilities: { experimentalApi: true, requestedCapabilities: [] } }), 20_000, 'Muse 初始化', options.signal);
    rpc.notify('initialized');
    const wire = rpc;
    const profiles = await readMuseProfiles((method, params) => boundedAcpRequest(wire.request(method, params), 5000, `Muse ${method}`, options.signal));
    const data = record(await boundedAcpRequest(rpc.request('model/list', {}), 20_000, 'Muse 模型目录', options.signal));
    if (!Array.isArray(data.models) || data.models.length > 1000) throw new Error('Muse 返回的模型目录无效');
    const seen = new Set<string>();
    const items: Array<{ id: string; name: string }> = [];
    for (const value of data.models) {
      const row = record(value);
      if (!validId(row.modelId)) throw new Error('Muse 模型目录包含无效标识');
      const id = row.modelId.trim();
      if (seen.has(id)) continue;
      seen.add(id);
      const name = typeof row.displayLabel === 'string' && row.displayLabel.trim() && !/[\u0000-\u001f]/.test(row.displayLabel)
        ? row.displayLabel.trim().slice(0, 200) : id;
      items.push({ id, name });
    }
    result = { ok: true, items, nativeConfig: museNativeConfig(undefined, undefined, profiles) };
  } catch (error) { result = { ok: false, error: diagnostic(error) }; }
  finally {
    if (owner) {
      try { await owner.reclaim(); }
      catch (error) { result = { ok: false, error: `Muse 模型发现进程回收未确认：${diagnostic(error)}`, cleanupFailed: true }; }
    }
    rpc?.close();
  }
  if (result.ok && !isCurrentRefresh()) return { ok: false, error: '模型目录已被较新的刷新替代，请重新读取' };
  if (result.ok && !options.signal?.aborted) {
    catalogCache.set(key, result);
  }
  return result;
}
