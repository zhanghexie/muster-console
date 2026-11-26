import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../../../../shared/i18n';
import { lookOnPath } from '../acp/agents';
import { boundedAcpRequest } from '../../processReclamation';
import { spawnOwnedProcess } from '../../process/owner';
import { createControlledChild } from '../../process/controlledChild';
import { NdjsonRpc } from '../acp/jsonRpc';
import { winCmdLaunchArgs } from '../../../encoding/winUtf8';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { resolveExecutableOverride } from '../executableOverride';
import { ModelCatalogRefreshOrder } from '../../modelCatalogRefreshOrder';
import { ModelCatalogCache } from '../../modelCatalogCache';
import type { JsonRpcMessage } from '../acp/jsonRpc';
import { zcodeNativeConfig } from './nativeConfig';
import type { NativeConfigState } from '../../../../shared/nativeSessionConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';

export type ZCodeRecord = Record<string, unknown>;
export const asZCodeRecord = (value: unknown): ZCodeRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ZCodeRecord : {};
export const zcodeString = (value: unknown): string => typeof value === 'string' ? value : '';

const modelError = (error: unknown): string => redactSafetyText((error as Error).message || String(error), collectEnvSecrets(process.env)).slice(0, 800);

type ZCodeLaunch = { executable: string; command: string; args: string[]; env?: NodeJS.ProcessEnv };

function desktopKeyringArgs(resources: string, entry: string): string[] {
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) return [];
  const packagedKeyring = path.join(archive, 'node_modules', '@napi-rs', 'keyring');
  // In run-as-Node mode the standalone bundle cannot see the desktop archive
  // through normal package resolution. Resolve only the bundled keyring fallback.
  const preload = `
import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';
const require = nodeModule.createRequire(pathToFileURL(${JSON.stringify(entry)}));
nodeModule.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier !== '@napi-rs/keyring' || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return nextResolve(pathToFileURL(require.resolve(${JSON.stringify(packagedKeyring)})).href, context);
    }
  }
});`;
  return ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`];
}

/** A desktop bundle is a CLI script plus its matching Electron runtime, not the GUI executable alone. */
function desktopBundle(entry: string): ZCodeLaunch | null {
  const glm = path.dirname(entry);
  const resources = path.dirname(glm);
  if (path.basename(entry).toLowerCase() !== 'zcode.cjs' || path.basename(glm).toLowerCase() !== 'glm' ||
      path.basename(resources).toLowerCase() !== 'resources') return null;
  const metadataPath = path.join(glm, '.node-bundle-meta.json');
  const providerConfig = path.join(resources, 'config', 'provider', 'zcode-builtin.json');
  try {
    if (!fs.statSync(entry).isFile() || !fs.statSync(providerConfig).isFile() ||
        fs.statSync(metadataPath).size > 8192) return null;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { runtime?: unknown; entry?: unknown; platform?: unknown };
    if (metadata.runtime !== 'electron-node' || metadata.entry !== 'zcode.cjs' ||
        (typeof metadata.platform === 'string' && !metadata.platform.startsWith(`${process.platform}-`))) return null;
  } catch { return null; }
  const installRoot = path.dirname(resources);
  const binaries = process.platform === 'win32' ? [path.join(installRoot, 'ZCode.exe')]
    : process.platform === 'darwin' ? [path.join(installRoot, 'MacOS', 'ZCode')]
      : [path.join(installRoot, 'zcode'), path.join(installRoot, 'ZCode')];
  const command = binaries.map(resolveExecutableOverride).find((value): value is string => !!value);
  if (!command) return null;
  const dataRoot = process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || providerConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ||
      path.join(dataRoot, '.zcode', 'v2', 'provider_config.json')
  };
  return { executable: entry, command, args: [...desktopKeyringArgs(resources, entry), entry, 'app-server', '--stdio'], env };
}

function desktopEntryFromHint(hint: string): string {
  if (path.basename(hint).toLowerCase() === 'zcode.cjs') return hint;
  const parent = path.dirname(hint);
  return process.platform === 'darwin' && path.basename(parent) === 'MacOS'
    ? path.join(path.dirname(parent), 'Resources', 'glm', 'zcode.cjs')
    : path.join(parent, 'resources', 'glm', 'zcode.cjs');
}

function desktopEntries(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => !!root)
      .map(root => path.join(root, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  }
  if (process.platform === 'darwin') return ['/Applications', path.join(home, 'Applications')]
    .map(root => path.join(root, 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'));
  return ['/opt/ZCode', '/opt/zcode', '/usr/lib/zcode', '/usr/local/lib/zcode', path.join(home, '.local', 'share', 'ZCode')]
    .map(root => path.join(root, 'resources', 'glm', 'zcode.cjs'));
}

function directLaunch(executable: string): ZCodeLaunch | null {
  const name = path.basename(executable).toLowerCase();
  if (name === 'zcode' || name === 'zcode.exe' || name === 'zcode.cjs') {
    const entry = desktopEntryFromHint(executable);
    const bundled = desktopBundle(entry);
    if (bundled) return bundled;
    const resources = path.dirname(path.dirname(entry));
    // Never launch the desktop GUI as an app-server when its bundle is incomplete.
    if (fs.existsSync(entry) || fs.existsSync(path.join(resources, 'app.asar'))) return null;
  }
  // An unpacked JS entry is not itself a standalone executable on Windows.
  if (/\.(?:cjs|mjs|js)$/i.test(executable)) return null;
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  if (shim && executable.includes('%')) return null;
  return { executable, command: shim ? 'cmd.exe' : executable,
    args: shim ? winCmdLaunchArgs([executable, 'app-server']) : ['app-server'] };
}

function resolveZCodeLaunch(preferred?: string): ZCodeLaunch | null {
  if (preferred?.trim()) {
    const hint = preferred.trim();
    if (!path.isAbsolute(hint) || /[\u0000-\u001f\u007f]/.test(hint)) return null;
    if (path.basename(hint).toLowerCase() === 'zcode.cjs') return desktopBundle(hint);
    const executable = resolveExecutableOverride(hint);
    return executable ? directLaunch(executable) : null;
  }
  const home = os.homedir();
  const found = lookOnPath(['zcode']);
  if (found) {
    const launch = directLaunch(found);
    if (launch) return launch;
  }
  const roots = process.platform === 'win32'
    ? [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), path.join(home, '.local', 'bin')].filter((value): value is string => !!value)
    : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin'];
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const common = lookOnPath(roots.flatMap(root => extensions.map(extension => path.join(root, `zcode${extension}`))));
  if (common) {
    const launch = directLaunch(common);
    if (launch) return launch;
  }
  for (const entry of desktopEntries()) {
    const bundled = desktopBundle(entry);
    if (bundled) return bundled;
  }
  return null;
}

export function resolveZCodeExecutable(preferred?: string): string | null {
  return resolveZCodeLaunch(preferred)?.executable ?? null;
}

/** Answer the native bootstrap request without auto-answering user questions. */
export function respondZCodeRuntimePreferences(rpc: NdjsonRpc, message: JsonRpcMessage): boolean {
  if (message.id == null || message.method !== 'session/requestRuntimePreferences') return false;
  rpc.respond(message.id, { nativeSearchEnhancementsEnabled: true, askUserQuestionAutoResolutionEnabled: false });
  return true;
}

type ZCodeMonitor = { workspaceId?: string; workspaceName?: string; sessionId?: string; sessionName?: string; taskId?: string };

/** ZCode's app-server speaks JSON-RPC-like line frames. */
export function startZCodeProcess(cwd: string, executableOverride?: string, monitor?: ZCodeMonitor) {
  return openZCodeProcess(cwd, executableOverride, monitor, false);
}

function openZCodeProcess(cwd: string, executableOverride: string | undefined, monitor: ZCodeMonitor | undefined, discovery: boolean): {
  rpc: NdjsonRpc;
  executable: string;
  waitReady(): Promise<void>;
  close(): Promise<void>;
} {
  const launch = resolveZCodeLaunch(executableOverride);
  if (!launch) throw new Error(executableOverride?.trim() ? '指定的 ZCode 可执行路径无效，请修正或清除设置' : '找不到 ZCode；请先安装 ZCode CLI 并登录');
  const { executable, command, args, env } = launch;
  const spawnOptions: SpawnOptions = { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: command === 'cmd.exe', env };
  const owner = discovery
    ? createControlledChild(command, args, spawnOptions)
    : spawnOwnedProcess<ChildProcessWithoutNullStreams>({ command, args, windows: { kind: 'taskkill' }, spawnOptions,
      monitor: { businessLabel: 'ZCode 会话引擎', role: 'AI 会话工作进程', ...monitor } });
  const child = owner.child;
  let stderr = '';
  if (discovery) {
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  } else child.stderr.resume();
  const discoveryExit = () => {
    // ZCode prints a single `Error:` line for app-server startup failures.
    const diagnostic = stderr.split(/\r?\n/).reverse().find(line => /^Error:\s+\S/.test(line.trimStart()));
    if (diagnostic) {
      const detail = modelError(diagnostic.trim().replace(/^Error:\s+/, '')).slice(0, 500);
      if (/\blisten (?:EPERM|EACCES|ENAMETOOLONG)\b/i.test(detail)) {
        return new Error(t('ZCode 无法创建本地通信端点，请检查临时目录和本地套接字权限。{{detail}}', { detail }));
      }
      return new Error(t('ZCode 在返回模型目录前退出：{{detail}}', { detail }));
    }
    if (child.exitCode !== null) {
      return new Error(t('ZCode 在返回模型目录前退出，状态码 {{code}}。请检查 CLI 启动路径和配置。', { code: child.exitCode }));
    }
    return new Error(t('ZCode 在返回模型目录前断开连接，请检查 CLI 启动路径和配置。'));
  };
  const rpc = new NdjsonRpc(child.stdin, child.stdout, { omitJsonRpcVersion: true, unexpectedEof: discovery ? discoveryExit : undefined });
  child.on('error', error => rpc.failExternal(error));
  rpc.on('parse-error', () => rpc.failExternal(new Error('ZCode 协议输出不是有效 JSON')));
  let closed: Promise<void> | undefined;
  return { rpc, executable, async waitReady() {
    await owner.ready;
    const ready = 'started' in owner ? owner.started && child.exitCode === null && !child.killed : owner.state === 'ready';
    if (!ready) throw discovery ? discoveryExit() : new Error('ZCode 进程已退出或正在回收');
  }, close() {
    if (closed) return closed;
    const attempt = (async () => { rpc.close(); await owner.reclaim(); })();
    closed = attempt;
    void attempt.catch(() => { if (closed === attempt) closed = undefined; });
    return attempt;
  } };
}

export function zcodeWorkspace(cwd: string): ZCodeRecord {
  return { workspacePath: cwd, workspaceKey: cwd };
}

export interface ZCodeModelItem { id: string; name: string; legacyLabels: string[]; group?: import('../../../../shared/harnessPicker').HarnessModelGroup }
export interface ZCodeSnapshotModel extends ZCodeModelItem { ref: ZCodeRecord }
export type ZCodeModelListResult = { ok: true; items: ZCodeModelItem[]; nativeConfig?: NativeConfigState } | { ok: false; error: string; cleanupFailed?: true };

/** Encoding the pair, rather than the display label, keeps identity unambiguous. */
export function zcodeModelId(providerId: string, modelId: string): string {
  return `zcode:v1:${Buffer.from(JSON.stringify([providerId, modelId]), 'utf8').toString('base64url')}`;
}

export function parseZCodeModelId(value: string): { providerId: string; modelId: string } | null {
  if (!value.startsWith('zcode:v1:') || !/^[A-Za-z0-9_-]+$/.test(value.slice(9))) return null;
  try {
    const pair: unknown = JSON.parse(Buffer.from(value.slice(9), 'base64url').toString('utf8'));
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') return null;
    const [providerId, modelId] = pair;
    return providerId && modelId && zcodeModelId(providerId, modelId) === value ? { providerId, modelId } : null;
  } catch { return null; }
}

/** Legacy labels can resolve only when exactly one identity owns the label. */
export function selectZCodeModel<T extends ZCodeModelItem>(items: readonly T[], selected: string): T {
  const exact = items.find(item => item.id === selected);
  const labels = items.filter(item => item.legacyLabels.includes(selected));
  if (exact && labels.some(item => item.id !== exact.id)) throw new Error('ZCode 旧模型名称与其他模型标识冲突，请刷新目录并重新选择');
  if (exact) return exact;
  if (labels.length > 1) throw new Error('ZCode 旧模型名称对应多个模型，请刷新目录并重新选择');
  if (labels.length === 1) return labels[0]!;
  throw new Error('ZCode 当前模型目录没有所选模型，请刷新目录并重新选择');
}

export function assertZCodeDefaultUnambiguous(items: readonly ZCodeModelItem[]): void {
  if (items.some(item => item.legacyLabels.includes('default'))) {
    throw new Error('ZCode 模型名称 default 与引擎默认选项冲突，请清除模型覆盖或重新选择模型');
  }
}

export function zcodeSnapshotModels(snapshot: unknown): ZCodeSnapshotModel[] {
  const settings = asZCodeRecord(asZCodeRecord(snapshot).settings);
  const available = asZCodeRecord(settings.model).available;
  if (!Array.isArray(available) || available.length > 1024) throw new Error('ZCode 未返回有效的模型目录');
  const result: ZCodeSnapshotModel[] = [];
  const seen = new Map<string, ZCodeSnapshotModel>();
  for (const raw of available) {
    const item = asZCodeRecord(raw), ref = asZCodeRecord(item.ref);
    const label = zcodeString(item.label).trim(), providerId = zcodeString(ref.providerId).trim(), modelId = zcodeString(ref.modelId).trim();
    if (!label || !providerId || !modelId || [label, providerId, modelId].some(value => value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) continue;
    const id = zcodeModelId(providerId, modelId), previous = seen.get(id);
    if (previous) { if (!previous.legacyLabels.includes(label)) previous.legacyLabels.push(label); continue; }
    const model = { id, name: label, legacyLabels: [label], ref: { providerId, modelId }, group: { id: providerId, label: providerId } };
    seen.set(id, model);
    result.push(model);
  }
  return result;
}

const catalogCache = new ModelCatalogCache<Extract<ZCodeModelListResult, { ok: true }>>('zcode');
const refreshOrder = new ModelCatalogRefreshOrder();
const emptyCatalogError = 'ZCode 未返回可用模型，请检查 ZCode CLI 的账号和服务商配置后再刷新';
const zcodeCatalogKey = (cwd: string, override?: string) => JSON.stringify([cwd, override ?? '', process.env.ZCODE_DATA_BASE_DIR,
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
  nativeExecutableVersion(resolveZCodeExecutable(override), 'zcode-protocol-v1')]);
export function zcodeModelCatalogRevision(cwd: string, override?: string): number { return catalogCache.revision(zcodeCatalogKey(cwd, override)); }
export async function listZCodeModels(options: { cwd: string; executableOverride?: string; signal?: AbortSignal; refresh?: boolean }): Promise<ZCodeModelListResult> {
  const key = zcodeCatalogKey(options.cwd, options.executableOverride);
  if (!options.refresh) {
    const cached = catalogCache.get(key);
    if (!cached) return { ok: false, error: '尚未读取模型目录，请手动刷新' };
    return Array.isArray(cached.items) && cached.items.length ? cached : { ok: false, error: emptyCatalogError };
  }
  const isCurrentRefresh = refreshOrder.begin(key);
  try { if (!fs.statSync(options.cwd).isDirectory()) return { ok: false, error: '模型发现工作目录不存在' }; }
  catch { return { ok: false, error: '模型发现工作目录不存在或无法访问' }; }
  let processHandle: ReturnType<typeof startZCodeProcess> | undefined;
  let result: ZCodeModelListResult;
  try {
    processHandle = openZCodeProcess(options.cwd, options.executableOverride, undefined, true);
    const { rpc } = processHandle;
    rpc.on('message', (message: JsonRpcMessage) => {
      if (respondZCodeRuntimePreferences(rpc, message)) return;
      if (message.id != null) rpc.respondError(message.id, '模型发现不支持交互请求', -32601);
    });
    await boundedAcpRequest(processHandle.waitReady(), 30_000, 'ZCode 模型发现进程启动', options.signal);
    const snapshot = await boundedAcpRequest(rpc.request('session/create', { workspace: zcodeWorkspace(options.cwd),
      persistence: 'deferred', titleGenerationEnabled: false }), 30_000, 'ZCode 模型目录', options.signal);
    const items = zcodeSnapshotModels(snapshot).map(({ id, name, legacyLabels, group }) => ({ id, name, legacyLabels, group }));
    const protocol = asZCodeRecord(asZCodeRecord(snapshot).protocol);
    result = items.length ? { ok: true, items, nativeConfig: zcodeNativeConfig(snapshot, protocol.name === 'ZCode Protocol') }
      : { ok: false, error: emptyCatalogError };
  } catch (error) { result = { ok: false, error: modelError(error) }; }
  finally {
    if (processHandle) {
      try { await processHandle.close(); }
      catch (error) { result = { ok: false, error: modelError(error), cleanupFailed: true }; }
    }
  }
  if (result.ok && !isCurrentRefresh()) return { ok: false, error: '模型目录已被较新的刷新替代，请重新读取' };
  if (result.ok && !options.signal?.aborted) {
    catalogCache.set(key, result);
  }
  return result;
}
