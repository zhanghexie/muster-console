import fs from 'node:fs';
import { externalPiModelKey, parseExternalPiModelKey, type ExternalPiModelIdentity } from '../../../../shared/externalPiModel';
import type { AcpModelListResult } from '../acp/models';
import { boundedAcpRequest } from '../acp/models';
import { externalPiLaunchArgs, externalPiLaunchEnvironment, resolveExternalPiExecutable, type ExternalPiId } from './executable';
import { ExternalPiRpc } from './rpc';
import { ModelCatalogRefreshOrder } from '../../modelCatalogRefreshOrder';
import { ModelCatalogCache } from '../../modelCatalogCache';

type Frame = Record<string, unknown>;
const record = (value: unknown): Frame => value && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {};
const id = (value: unknown): string => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';

export interface ExternalPiModelItem { id: string; name: string; group?: import('../../../../shared/harnessPicker').HarnessModelGroup }
const catalogCache = new ModelCatalogCache<Extract<AcpModelListResult, { ok: true }>>('pi-rpc');
const refreshOrder = new ModelCatalogRefreshOrder();
type ExternalPiCatalogSource = { cwd: string; runtimeId: ExternalPiId; executableOverride?: string };
const externalPiCatalogKey = (options: ExternalPiCatalogSource) => JSON.stringify([options.cwd, options.runtimeId, options.executableOverride ?? '',
  options.runtimeId === 'pi-external' ? process.env.PI_CODING_AGENT_DIR ?? '' : '']);
export function externalPiModelCatalogRevision(options: ExternalPiCatalogSource): number { return catalogCache.revision(externalPiCatalogKey(options)); }

/** Reject incomplete directories: truncation or malformed entries makes a legacy key's uniqueness unknowable. */
export function externalPiModels(data: unknown): ExternalPiModelItem[] {
  const models = record(data).models;
  if (!Array.isArray(models) || models.length > 1024) throw new Error('外部 Pi 未返回完整有效的模型目录');
  const seen = new Set<string>();
  const items: ExternalPiModelItem[] = [];
  for (const raw of models) {
    const entry = record(raw), provider = id(entry.provider), modelId = id(entry.id);
    if (!provider || !modelId) throw new Error('外部 Pi 模型目录包含无效身份');
    const value = externalPiModelKey(provider, modelId);
    if (seen.has(value)) continue;
    seen.add(value);
    items.push({ id: value, name: id(entry.name) || modelId, group: { id: provider, label: provider } });
  }
  return items;
}

/** Legacy provider/model keys are accepted only when the full current directory identifies one pair. */
export function selectExternalPiModel(items: readonly ExternalPiModelItem[], selected: string): ExternalPiModelIdentity {
  const exact = items.find(item => item.id === selected);
  const legacy = items.filter(item => {
    const pair = parseExternalPiModelKey(item.id);
    return pair && `${pair.providerId}/${pair.modelId}` === selected;
  });
  if (exact && legacy.some(item => item.id !== exact.id)) throw new Error('外部 Pi 旧模型名称与其他模型身份冲突，请重新选择');
  if (exact) return parseExternalPiModelKey(exact.id)!;
  if (legacy.length > 1) throw new Error('外部 Pi 旧模型名称对应多个模型，请刷新目录并重新选择');
  if (legacy.length === 1) return parseExternalPiModelKey(legacy[0].id)!;
  throw new Error('所选模型不在当前外部 Pi 模型目录中，请刷新目录并重新选择');
}

/** Explicit discovery reads the user's Pi model registry without sending a prompt. */
export async function listExternalPiModels(options: {
  cwd: string;
  runtimeId: ExternalPiId;
  executableOverride?: string;
  signal?: AbortSignal;
  refresh?: boolean;
}): Promise<AcpModelListResult> {
  const key = externalPiCatalogKey(options);
  if (!options.refresh) return structuredClone(catalogCache.get(key) ?? { ok: false, error: '尚未读取模型目录，请手动刷新' });
  const isCurrentRefresh = refreshOrder.begin(key);
  try { if (!fs.statSync(options.cwd).isDirectory()) return { ok: false, error: '模型发现工作目录不存在' }; }
  catch { return { ok: false, error: '模型发现工作目录不存在或无法访问' }; }
  const executable = resolveExternalPiExecutable(options.runtimeId, options.executableOverride);
  if (!executable) return { ok: false, error: options.executableOverride?.trim() ? '指定的外部 Pi 可执行路径无效' : '找不到用户安装的外部 Pi' };
  let rpc: ExternalPiRpc | undefined;
  let readyResolve!: (frame: Frame) => void;
  const ready = new Promise<Frame>(resolve => { readyResolve = resolve; });
  let result: AcpModelListResult;
  try {
    const launch = externalPiLaunchArgs(executable, ['--mode', 'rpc', '--no-session',
      ...(options.runtimeId === 'pi-external' ? ['--no-extensions'] : [])]);
    rpc = new ExternalPiRpc({ ...launch, cwd: options.cwd, env: externalPiLaunchEnvironment(executable),
      onFrame(frame) {
        if (frame.type === 'ready') readyResolve(frame);
        else if (frame.type === 'extension_ui_request' && typeof frame.id === 'string' && ['confirm', 'select', 'input', 'editor'].includes(String(frame.method))) {
          rpc?.send({ type: 'extension_ui_response', id: frame.id, cancelled: true });
        }
      },
      onFailure() {}, log() {} });
    await boundedAcpRequest(rpc.waitReady(), 30_000, '外部 Pi 模型发现进程启动', options.signal);
    if (options.runtimeId === 'omp') {
      const greeting = await boundedAcpRequest(ready, 30_000, 'Oh My Pi 启动', options.signal);
      if (Array.isArray(greeting.supportedProtocolVersions) && greeting.supportedProtocolVersions.includes(2)) {
        await boundedAcpRequest(rpc.request('negotiate_protocol', { protocolVersion: 2 }), 30_000, 'Oh My Pi 协议协商', options.signal);
      }
    }
    const response = await boundedAcpRequest(rpc.request('get_available_models'), 30_000, '外部 Pi 模型目录', options.signal);
    const items = externalPiModels(response.data);
    const state = record((await boundedAcpRequest(rpc.request('get_state'), 30_000, '外部 Pi 状态', options.signal)).data);
    const current = record(state.model), provider = id(current.provider), modelId = id(current.id);
    result = { ok: true, items, ...(provider && modelId ? { currentModelId: externalPiModelKey(provider, modelId) } : {}) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message.slice(0, 800) : '外部 Pi 模型目录读取失败' };
  } finally {
    if (rpc) {
      try { await rpc.close(); }
      catch (error) { result = { ok: false, error: rpc.sanitize(error instanceof Error ? error.message : '外部 Pi 探测进程未能回收'), cleanupFailed: true }; }
    }
  }
  if (result.ok && !isCurrentRefresh()) return { ok: false, error: '模型目录已被较新的刷新替代，请重新读取' };
  if (result.ok && !options.signal?.aborted) {
    catalogCache.set(key, result);
  }
  return result;
}
