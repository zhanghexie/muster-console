import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyClaudeConfigDir, resolveClaudeConfigDir } from '../../../../shared/claudeGui';
import { t } from '../../../../shared/i18n';
import { boundedAcpRequest } from '../../processReclamation';
import { createControlledChild, type ControlledChild } from '../../process/controlledChild';
import { loadClaudeSdk, resolveClaudeExecutable, resolveUserClaudeExecutable } from './claudeSdk';
import { scrubClaudeSpawnEnv } from './env';
import { ModelCatalogRefreshOrder } from '../../modelCatalogRefreshOrder';
import { ModelCatalogCache } from '../../modelCatalogCache';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';

export interface ClaudeModelItem {
  id: string;
  name: string;
  resolvedModel?: string;
  effortLevels: string[];
}
export type ClaudeModelCatalog =
  | { ok: true; items: ClaudeModelItem[] }
  | { ok: false; error: string; cleanupFailed?: true };

export interface ClaudeModelDiscovery {
  cwd: string;
  userDataDir: string;
  isolateConfig: boolean;
  signal?: AbortSignal;
  refresh?: boolean;
}

const cache = new ModelCatalogCache<ClaudeModelItem[]>('claude');
const refreshOrder = new ModelCatalogRefreshOrder();
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SAFE_DISCOVERY_ERRORS = new Set([
  'Claude 模型发现已取消', '找不到用户安装的 Claude Code，请先安装并登录',
  'Claude 模型发现进程身份未确认', 'Claude 配置在读取期间变化，请重试',
  'Claude 未返回有效的模型目录', 'Claude 模型目录包含无效或重复的模型身份',
  'Claude 模型发现 超时', 'Claude 模型发现 已取消', 'Claude 进程身份确认 超时', 'Claude 进程身份确认 已取消'
]);

function discoveryError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return t('Claude 模型发现已取消');
  const message = error instanceof Error ? error.message : '';
  return SAFE_DISCOVERY_ERRORS.has(message) ? t(message) : t('Claude 模型目录读取失败，请检查本机 Claude 配置和登录后重试');
}

export function claudeConfigDirectory(userDataDir: string, isolateConfig: boolean): string {
  return resolveClaudeConfigDir({ isolate: isolateConfig, userDataDir, isolatedConfigDir: isolateConfig ? userDataStorage(userDataDir).resolve('app', 'claude-gui-home') : undefined, homedir: os.homedir(),
    envConfigDir: process.env.CLAUDE_CONFIG_DIR, join: path.join });
}

function statStamp(file: string): string {
  try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}:${stat.ino}`; }
  catch { return 'absent'; }
}

/** Fingerprint public filesystem identities only; no credentials or settings contents leave the host. */
export function claudeModelEnvironmentVersion(userDataDir: string, isolateConfig: boolean): string {
  const configDir = claudeConfigDirectory(userDataDir, isolateConfig);
  const executable = resolveUserClaudeExecutable() ?? 'sdk-default';
  const files = ['settings.json', 'settings.local.json', '.credentials.json', '.claude.json'];
  const identity = [configDir, isolateConfig, executable, statStamp(executable), statStamp(path.join(os.homedir(), '.claude.json')),
    ...files.map(file => statStamp(path.join(configDir, file)))];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('base64url');
}

function normalizeModels(raw: unknown): ClaudeModelItem[] {
  if (!Array.isArray(raw) || raw.length > 1024) throw new Error('Claude 未返回有效的模型目录');
  const seen = new Set<string>();
  return raw.map(value => {
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const id = typeof row.value === 'string' ? row.value.trim() : '';
    if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) throw new Error('Claude 模型目录包含无效或重复的模型身份');
    seen.add(id);
    const name = typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim().slice(0, 512) : id;
    const resolved = typeof row.resolvedModel === 'string' ? row.resolvedModel.trim() : '';
    const effortLevels = row.supportsEffort === false || !Array.isArray(row.supportedEffortLevels) ? []
      : [...new Set(row.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && EFFORT_LEVELS.has(level)))];
    return { id, name, ...(resolved && resolved.length <= 512 && !/[\u0000-\u001f\u007f]/.test(resolved) ? { resolvedModel: resolved } : {}), effortLevels };
  });
}

export function selectClaudeModel(items: readonly ClaudeModelItem[], id: string): ClaudeModelItem {
  const exact = items.find(item => item.id === id);
  if (exact) return exact;
  const matching = items.filter(item => item.resolvedModel === id);
  if (matching.length === 1) return matching[0];
  throw new Error(matching.length ? t('Claude 模型身份不唯一，请刷新目录并重新选择') : t('所选模型不在当前 Claude 模型目录中，请刷新目录并重新选择'));
}

/** Initialize the user's own CLI without sending an inference prompt or running tools. */
export async function listClaudeModels(input: ClaudeModelDiscovery): Promise<ClaudeModelCatalog> {
  const key = claudeCatalogKey(input);
  const cached = cache.get(key);
  if (!input.refresh) return cached && !input.signal?.aborted
    ? { ok: true, items: structuredClone(cached) }
    : { ok: false, error: t('尚未读取模型目录，请手动刷新') };
  const isCurrentRefresh = refreshOrder.begin(key);
  try { if (!fs.statSync(input.cwd).isDirectory()) return { ok: false, error: t('模型发现工作目录不存在') }; }
  catch { return { ok: false, error: t('模型发现工作目录不存在或无法访问') }; }
  const version = claudeModelEnvironmentVersion(input.userDataDir, input.isolateConfig);
  let owner: ControlledChild | undefined;
  const getOwner = (): ControlledChild | undefined => owner;
  let handle: ReturnType<Awaited<ReturnType<typeof loadClaudeSdk>>['query']> | undefined;
  let closing = false;
  let endFeed!: () => void;
  const ended = new Promise<void>(resolve => { endFeed = resolve; });
  async function* idlePrompt(): AsyncGenerator<SDKUserMessage> { await ended; }
  let result: ClaudeModelCatalog = { ok: false, error: t('Claude 模型目录读取失败') };
  try {
    if (input.signal?.aborted) throw new Error('Claude 模型发现已取消');
    const [sdk, executable] = await Promise.all([loadClaudeSdk(), resolveClaudeExecutable()]);
    if (!executable.ok) throw new Error('找不到用户安装的 Claude Code，请先安装并登录');
    if (input.signal?.aborted) throw new Error('Claude 模型发现已取消');
    const configDir = claudeConfigDirectory(input.userDataDir, input.isolateConfig);
    const env = applyClaudeConfigDir(scrubClaudeSpawnEnv(process.env), configDir);
    const options: Options = {
      cwd: input.cwd, env: env as Options['env'], tools: [], strictMcpConfig: true,
      persistSession: false, permissionMode: 'dontAsk', settings: { disableAllHooks: true },
      ...(executable.executable ? { pathToClaudeCodeExecutable: executable.executable } : {}),
      spawnClaudeCodeProcess: ({ command, args, cwd, env: childEnv }) => {
        if (closing || input.signal?.aborted || owner) throw new Error('Claude 模型发现已取消');
        owner = createControlledChild(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: input.signal });
        owner.child.stderr.resume();
        return owner.child;
      }
    };
    handle = sdk.query({ prompt: idlePrompt(), options });
    const rows = await boundedAcpRequest(handle.supportedModels(), 15_000, 'Claude 模型发现', input.signal);
    const started = getOwner();
    if (!started) throw new Error('Claude 模型发现进程身份未确认');
    await boundedAcpRequest(started.ready, 5_000, 'Claude 进程身份确认', input.signal);
    if (input.signal?.aborted) throw new Error('Claude 模型发现已取消');
    if (version !== claudeModelEnvironmentVersion(input.userDataDir, input.isolateConfig)) throw new Error('Claude 配置在读取期间变化，请重试');
    result = { ok: true, items: normalizeModels(rows) };
  } catch (error) {
    result = { ok: false, error: discoveryError(error, input.signal) };
  } finally {
    closing = true;
    try { await getOwner()?.reclaim(); }
    catch (error) {
      const detail = redactSafetyText(error instanceof Error ? error.message : String(error), collectEnvSecrets(process.env)).slice(0, 800);
      result = { ok: false, cleanupFailed: true, error: `${t('Claude 模型发现进程回收未确认，请检查相关进程后重试')}: ${detail}` };
    }
    endFeed();
    try { await boundedAcpRequest(Promise.resolve(handle?.close()), 5_000, 'Claude 模型发现关闭'); }
    catch { result = { ok: false, cleanupFailed: true, error: t('Claude 模型发现关闭未确认，请检查相关进程后重试') }; }
  }
  if (result.ok && !isCurrentRefresh()) return { ok: false, error: t('模型目录已被较新的刷新替代，请重新读取') };
  if (result.ok && !input.signal?.aborted) {
    cache.set(key, structuredClone(result.items));
  }
  return result;
}

const claudeCatalogKey = (input: ClaudeModelDiscovery) => JSON.stringify([input.cwd, claudeConfigDirectory(input.userDataDir, input.isolateConfig), input.isolateConfig]);
export function claudeModelCatalogRevision(input: ClaudeModelDiscovery): number { return cache.revision(claudeCatalogKey(input)); }
