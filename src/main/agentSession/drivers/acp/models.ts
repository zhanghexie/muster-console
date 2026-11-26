import fs from 'node:fs';
import path from 'node:path';
import { t } from '../../../../shared/i18n';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { getAcpPresets, resolveAcpLaunch } from './agents';
import { NdjsonRpc, NdjsonRpcResponseError } from './jsonRpc';
import { acpModelSelection, parseAcpModelList, parseAcpReasoningOption, type AcpModelItem, type AcpReasoningOption } from './modelOptions';
import { boundedAcpRequest, BoundedAcpRequestError } from '../../processReclamation';
import { createControlledChild, type ControlledChild } from '../../process/controlledChild';
import { ModelCatalogRefreshOrder } from '../../modelCatalogRefreshOrder';
import { ModelCatalogCache } from '../../modelCatalogCache';
import type { CatalogModelCoverage, CatalogModelProgress } from '../../../../shared/harnessCatalogRefresh';
import type { NativeConfigState } from '../../../../shared/nativeSessionConfig';
import { acpConfigCapabilities, acpNativeConfig, acpNativeId } from './nativeConfig';
import { acpLaunchEnvironment } from './launchPolicy';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import { createDshModelDiscovery, type DshModelDiscovery } from './dshModelDiscovery';

export { boundedAcpRequest } from '../../processReclamation';

export type AcpModelListResult =
  | { ok: true; items: AcpModelItem[]; currentModelId?: string; reasoning?: AcpReasoningOption; parametersUnknown?: true; coverage?: CatalogModelCoverage; nativeConfig?: NativeConfigState }
  | { ok: false; error: string; cleanupFailed?: true };

type AcpCatalog = { items: AcpModelItem[]; currentModelId?: string; parameters: Array<[string, AcpReasoningOption | null]>; nativeConfig?: NativeConfigState };
const catalogCache = new ModelCatalogCache<AcpCatalog>('acp');
const refreshOrder = new ModelCatalogRefreshOrder();

function acpCatalogResult(catalog: AcpCatalog, selectedModel: string): AcpModelListResult {
  const { items, currentModelId, parameters } = catalog;
  const requested = selectedModel && selectedModel !== 'default' ? selectedModel : currentModelId ?? '';
  const reasoning = parameters.find(([id]) => id === requested)?.[1];
  return { ok: true, items, currentModelId, nativeConfig: catalog.nativeConfig, ...(reasoning ? { reasoning } : {}),
    ...(reasoning === undefined ? { parametersUnknown: true } : {}) };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Grok uses an explicit cached-login method even when the CLI is already signed in. */
export async function authenticateAcpIfNeeded(agentId: string, init: unknown, rpc: NdjsonRpc, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (agentId !== 'grok') return;
  const response = record(init);
  const methods = Array.isArray(response.authMethods) ? response.authMethods.map(record) : [];
  const advertised = new Set(methods.map(method => typeof method.id === 'string' ? method.id : ''));
  // Discovery and connection must never initiate a device/browser login.
  const methodId = advertised.has('cached_token') ? 'cached_token' : '';
  if (!methodId) throw new Error('Grok Build 未提供可用的已登录认证方式，请先在其 CLI 中登录');
  await boundedAcpRequest(rpc.request('authenticate', { methodId }), timeoutMs, 'ACP 认证', signal);
}

export function acpLoginHint(agentId: string, error: unknown): string | undefined {
  if (agentId === 'antigravity' && error instanceof NdjsonRpcResponseError && error.code === -32000 && /^Authentication required\b/i.test(error.message)) {
    return t('请在终端运行 agy acp --login。Google 授权后，将授权码粘回终端完成登录，再重试。');
  }
}

function diagnostic(error: unknown): string {
  const secrets = collectEnvSecrets(process.env);
  const raw = error instanceof Error ? error.message : String(error);
  return redactSafetyText(raw, secrets).slice(0, 800);
}

function modelDiscoveryError(agentId: string, error: unknown): string {
  const loginHint = acpLoginHint(agentId, error);
  if (loginHint) return loginHint;
  if (agentId === 'hermes' && error instanceof NdjsonRpcResponseError && error.code === -32603) {
    const details = record(error.data).details;
    if (typeof details === 'string' && details.trim()) {
      const detail = diagnostic(details).split(/\r?\n/, 1)[0].trim().slice(0, 500);
      if (/permission denied|operation not permitted|\b(?:EACCES|EPERM|WinError 5)\b/i.test(detail)) {
        return t('Hermes Agent 访问受限，请检查配置和日志目录的权限。{{detail}}', { detail });
      }
      if (detail) return t('Hermes Agent 模型发现失败：{{detail}}', { detail });
    }
  }
  return diagnostic(error);
}

function acpCatalogSource(cwd: string, agentId: string, userDataDir?: string) {
  const presets = getAcpPresets(userDataDir);
  const preset = presets.find(preset => preset.id === agentId);
  const launch = resolveAcpLaunch(agentId, undefined, presets);
  const key = JSON.stringify([cwd, agentId, userDataDir, preset,
    nativeExecutableVersion('error' in launch ? null : launch.executable ?? launch.command, 'acp-v1')]);
  return { key, launch, preset };
}

export function acpModelCatalogRevision(cwd: string, agentId: string, userDataDir?: string): number {
  return catalogCache.revision(acpCatalogSource(cwd, agentId, userDataDir).key);
}

/**
 * Explicit user-initiated discovery: initialize and create an empty ACP session,
 * but never send a prompt or inference request. The selection is limited to
 * trusted presets returned by getAcpPresets.
 */
export async function listAcpModels(opts: {
  cwd: string;
  agentId: string;
  userDataDir?: string;
  signal?: AbortSignal;
  /** When describing model parameters, discover options after selecting this model. */
  modelId?: string;
  /** Explicit batch refresh probes each advertised model on the same empty session. */
  allModels?: boolean;
  onProgress?: (progress: CatalogModelProgress) => void;
  refresh?: boolean;
}): Promise<AcpModelListResult> {
  const agentId = opts.agentId?.trim();
  if (!agentId) return { ok: false, error: '请先选择 ACP 引擎' };
  const { key, launch, preset } = acpCatalogSource(opts.cwd, agentId, opts.userDataDir);
  const selectedModel = opts.modelId?.trim() ?? '';
  if (!opts.refresh) {
    const catalog = catalogCache.get(key);
    return catalog ? acpCatalogResult(catalog, selectedModel) : { ok: false, error: '尚未读取模型目录，请手动刷新' };
  }
  const isCurrentRefresh = refreshOrder.begin(key);
  try {
    if (!fs.statSync(opts.cwd).isDirectory()) return { ok: false, error: '模型发现工作目录不存在' };
  } catch { return { ok: false, error: '模型发现工作目录不存在或无法访问' }; }
  if ('error' in launch) return { ok: false, error: launch.error };

  let owner: ControlledChild | undefined;
  let rpc: NdjsonRpc | undefined;
  let result: AcpModelListResult;
  let catalog: AcpCatalog | undefined;
  let discovery: DshModelDiscovery | undefined;
  try {
    const env = acpLaunchEnvironment(agentId, process.env);
    if (agentId === 'deepseek') discovery = createDshModelDiscovery(launch, preset?.args ?? launch.args);
    const command = discovery?.launch ?? launch;
    owner = createControlledChild(command.command, command.args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: process.platform === 'win32' && path.basename(command.command).toLowerCase() === 'cmd.exe'
    });
    const child = owner.child;
    rpc = new NdjsonRpc(child.stdin, child.stdout);
    child.on('error', error => rpc?.failExternal(error));
    const storageReady = discovery?.verify(child.stderr);
    // Startup can fail before ready settles; keep early proof rejection handled.
    void storageReady?.catch(() => {});
    child.stderr.resume();
    let discoverySessionId = '';
    let updatedOptions: unknown[] | undefined;
    let currentModeId: string | undefined;
    const earlyConfig = new Map<string, Record<string, unknown>>();
    rpc.on('message', message => {
      if (message.method === 'session/update') {
        const params = record(message.params);
        const update = record(params.update);
        const id = acpNativeId(params.sessionId ?? params.session_id);
        if (id && (update.sessionUpdate === 'config_option_update' || update.sessionUpdate === 'current_mode_update')) {
          if (!discoverySessionId && (earlyConfig.size < 8 || earlyConfig.has(id))) earlyConfig.set(id, { ...earlyConfig.get(id), ...update });
          if (discoverySessionId === id && Array.isArray(update.configOptions)) updatedOptions = update.configOptions;
          if (discoverySessionId === id && update.sessionUpdate === 'current_mode_update') currentModeId = acpNativeId(update.currentModeId);
        }
      }
      if (message.id != null) rpc?.respondError(message.id, '模型目录探测不支持交互请求');
    });
    await boundedAcpRequest(owner.ready, 30_000, 'ACP 模型发现进程启动', opts.signal);
    if (!owner.started || child.exitCode !== null || child.killed) throw new Error('ACP 模型发现进程已退出或正在回收');
    // A DSH overlay can be ignored by an incompatible/custom profile. Require
    // live backend identity proof before session/new can materialize anything.
    if (storageReady) await boundedAcpRequest(storageReady, 30_000, 'DeepSeek 临时探测存储确认', opts.signal);
    const init = record(await boundedAcpRequest(rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'muster-workbench', version: '0.1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: acpConfigCapabilities }
    }), 30_000, 'ACP 初始化', opts.signal));
    await authenticateAcpIfNeeded(agentId, init, rpc, 30_000, opts.signal);
    const session = record(await boundedAcpRequest(rpc.request('session/new', { cwd: opts.cwd, mcpServers: [] }, reply => {
      const response = record(reply);
      discoverySessionId = acpNativeId(response.sessionId ?? response.session_id) ?? '';
      const early = earlyConfig.get(discoverySessionId);
      if (Array.isArray(early?.configOptions)) updatedOptions = early.configOptions;
      currentModeId = acpNativeId(early?.currentModeId);
    }), 30_000, 'ACP 模型目录', opts.signal));
    if (updatedOptions) session.configOptions = updatedOptions;
    if (currentModeId) session.modes = { ...record(session.modes), currentModeId };
    const nativeConfig = acpNativeConfig(session);
    const models = parseAcpModelList(session);
    const available = new Set(models.items.map(model => model.id));
    const parameters = new Map((catalogCache.get(key)?.parameters ?? []).filter(([id]) => available.has(id)));
    const initialOptionsKnown = Array.isArray(session.configOptions);
    if (!opts.allModels || initialOptionsKnown) {
      parameters.set(models.currentModelId ?? '', parseAcpReasoningOption(session) ?? null);
    }
    const discoveryRpc = rpc;
    const readModelParameters = async (modelId: string, timeout: number): Promise<boolean> => {
      const sessionId = session.sessionId ?? session.session_id;
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('ACP 模型目录未返回会话标识');
      discoverySessionId = sessionId.trim();
      const selection = acpModelSelection(session, discoverySessionId, modelId);
      updatedOptions = undefined;
      const response = record(await boundedAcpRequest(discoveryRpc.request(selection.method, selection.params), timeout, 'ACP 模型参数发现', opts.signal));
      const confirmed = parseAcpModelList(response).currentModelId;
      if (confirmed && confirmed !== modelId) throw new Error('ACP 引擎未确认模型参数所属模型');
      const notifiedModel = updatedOptions && parseAcpModelList({ configOptions: updatedOptions }).currentModelId;
      const options = Array.isArray(response.configOptions) ? response.configOptions
        : !opts.allModels || notifiedModel === modelId ? updatedOptions : undefined;
      if (!options) return false;
      parameters.set(modelId, parseAcpReasoningOption({ configOptions: options }) ?? null);
      return true;
    };
    let coverage: CatalogModelCoverage | undefined;
    if (opts.allModels) {
      const pending = models.items.filter(model => model.id !== models.currentModelId);
      const total = models.items.length;
      let completed = total - pending.length;
      let read = initialOptionsKnown ? completed : 0;
      let detail: string | undefined;
      const deadline = Date.now() + 80_000;
      for (const model of pending) {
        if (opts.signal?.aborted) throw new BoundedAcpRequestError('ACP 模型参数发现', 'cancelled');
        const remaining = deadline - Date.now();
        if (remaining <= 0) { detail = 'ACP 模型参数发现 超时'; break; }
        opts.onProgress?.({ completed, total, model: model.name });
        try {
          if (await readModelParameters(model.id, Math.min(8_000, remaining))) read++;
        } catch (error) {
          if (opts.signal?.aborted) throw error;
          detail ??= modelDiscoveryError(agentId, error);
          // A timed-out request can still deliver an update; do not attribute it to another model.
          if (error instanceof BoundedAcpRequestError) break;
        }
        completed++;
      }
      opts.onProgress?.({ completed, total });
      coverage = { total, read, ...(detail ? { detail } : {}) };
    } else if (selectedModel && selectedModel !== 'default' && selectedModel !== models.currentModelId) {
      await readModelParameters(selectedModel, 30_000);
    }
    catalog = { ...models, parameters: [...parameters], nativeConfig };
    result = acpCatalogResult(catalog, selectedModel);
    if (result.ok && coverage) result.coverage = coverage;
  } catch (error) {
    result = { ok: false, error: modelDiscoveryError(agentId, error) };
  } finally {
    rpc?.close();
    let reclaimed = true;
    if (owner) {
      try { await owner.reclaim(); }
      catch (error) { reclaimed = false; result = { ok: false, error: diagnostic(error), cleanupFailed: true }; }
    }
    try { discovery?.dispose(reclaimed); }
    catch (error) { result = { ok: false, error: diagnostic(error), cleanupFailed: true }; }
  }
  if (result.ok && !isCurrentRefresh()) return { ok: false, error: '模型目录已被较新的刷新替代，请重新读取' };
  if (result.ok && catalog && !opts.signal?.aborted) catalogCache.set(key, catalog);
  return result;
}
