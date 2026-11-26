import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
/** Built-in Pi GUI driver: lifecycle and configuration stay in the host; SDK runs in a managed worker. */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../../context';
import { resolveLlmConfig, resolveLlmConfigWithReload } from '../../../config';
import { t } from '../../../../shared/i18n';
import { GUI_THINKING_LEVELS } from '../../../../shared/thinkingLevels';
import { getConfiguredCoreReasoning, getConfiguredPiThinkingLevels, syncPiConfigFromApp, primePiCatalogSnapshot } from '../../../agent/piConfigSync';
import { describeCoreReasoning, supportsCoreReasoning } from '../../../agent/piReasoning';
import { llmConnectionIdentity } from '../../../agent/llmConnectionIdentity';
import { resolvePiShellEnv } from './shellEnv';
import type { GuiDriverConnectInput, GuiDriverPurgeInput, GuiDriverSweepKeep, GuiRuntimeConnection, GuiRuntimeDriver, GuiRuntimeProbeResult } from '../../types';
import { listPiModes, piModeConnectExtras, isPiCreatorMode, readPiMode } from './modes';
import { buildPiModeTools } from '../../tools/piModes';
import { detectGitBashPath } from '../../../shell/profiles';
import { createPiWorkerConnection, resolvePiWorkerFile } from './workerHost';
import { desktopEngineDeliveryFromContext } from '../../../desktop/globalEngineDelivery';

/** Validate persisted Pi tokens before constructing or deleting session paths. */
function isValidPiToken(token: string): boolean {
  return token === path.basename(token) && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(token);
}

export class PiRuntimeDriver implements GuiRuntimeDriver {
  readonly runtimeId = 'pi';
  readonly deliveryCapabilities = { interject: true, snapshot: true } as const;
  /** session.prompt 原生带 images（ImageContent） */
  readonly supportsImages = true;
  /** SessionManager.appendMessage 可回放 fork 种子为真实消息历史 */
  readonly supportsSeed = true;
  /** 权限/工具面 fire-time 热读，切档不拆连接 */
  readonly modeSwitchReconnects = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'hot' as const;

  constructor(
    private ctx: AppContext,
    private opts: { userDataDir: string }
  ) {}

  /** 内置 SDK 不等于模型已配置；与 connect 共用激活配置解析，不联网检查余额/鉴权。 */
  async probe(input: { piModeId?: string; modelOverride?: GuiDriverConnectInput['modelOverride'] } = {}): Promise<GuiRuntimeProbeResult> {
    try {
      if (!resolvePiWorkerFile()) return {
        status: 'not_installed',
        problems: [{ code: 'script_missing', message: t('内置引擎进程文件缺失'), fix: t('请重新构建或重新安装工作台') }]
      };
      const mode = input.piModeId ? readPiMode(this.opts.userDataDir, input.piModeId) : null;
      this.resolveModelConfig(input.modelOverride ?? mode?.model);
      return { status: 'available', problems: [] };
    } catch (e) {
      return {
        status: 'not_configured',
        problems: [{
          code: 'config_missing',
          message: (e as Error).message,
          fix: t('请在设置 → 大模型设置中配置并启用服务商、API Key 与模型')
        }]
      };
    }
  }

  /** Reject a stale explicit identity instead of accepting the resolver's fallback. */
  private assertModelSelection(
    resolved: ReturnType<typeof resolveLlmConfig>,
    requested?: GuiDriverConnectInput['modelOverride'] | null
  ): void {
    const providerId = requested?.providerId?.trim();
    const modelId = requested?.modelId?.trim();
    if (providerId && resolved.provider.id !== providerId) {
      throw new Error(t('指定的 Pi 服务商「{{id}}」已不存在，请重新选择模型', { id: providerId }));
    }
    if (modelId && resolved.model.id !== modelId) {
      throw new Error(t('指定的 Pi 模型「{{id}}」在所选服务商中不可用，请重新选择模型', { id: modelId }));
    }
  }

  private resolveModelConfig(
    target?: GuiDriverConnectInput['modelOverride'],
    requested: GuiDriverConnectInput['modelOverride'] | null = target ?? null
  ) {
    let config: ReturnType<typeof resolveLlmConfigWithReload>;
    try {
      config = resolveLlmConfigWithReload(this.ctx.config, target);
    } catch (error) {
      // A missing identity can otherwise be reported as the fallback provider's
      // missing key. Reuse the reloaded config to report the actual problem.
      if (requested) this.assertModelSelection(resolveLlmConfig(this.ctx.config.get(), target), requested);
      throw error;
    }
    this.assertModelSelection(config.resolved, requested);
    const { provider, model } = config.resolved;
    if (provider.enabled === false) {
      throw new Error(t('Pi 服务商「{{name}}」已禁用，请在设置 → 大模型设置中启用', { name: provider.name }));
    }
    if (!provider.baseUrl?.trim() || !provider.models.some((m) => m.id === model.id)) {
      throw new Error(t('Pi 服务商「{{name}}」缺少 Base URL 或模型，请检查设置 → 大模型设置', { name: provider.name }));
    }
    return config;
  }

  async validateModelOverride({ model }: { model: NonNullable<GuiDriverConnectInput['modelOverride']> }): Promise<void> {
    this.resolveModelConfig(model);
  }

  /** Pi 自定义模式名单（内置创造模式 + userData 用户模式；渲染层模式菜单用） */
  listPresets() {
    return listPiModes(this.opts.userDataDir);
  }

  async describeModelParameters(input: Parameters<NonNullable<GuiRuntimeDriver['describeModelParameters']>>[0]):
    ReturnType<NonNullable<GuiRuntimeDriver['describeModelParameters']>> {
    await primePiCatalogSnapshot();
    const mode = input.piModeId ? readPiMode(this.opts.userDataDir, input.piModeId) : null;
    const { resolved: { provider, model } } = this.resolveModelConfig(input.modelOverride ?? mode?.model);
    if (this.ctx.coreReasoningCatalog && /^ollama(?:_\d+)?$/.test(provider.id) && (!provider.api || provider.api === 'openai-completions')) {
      await this.ctx.coreReasoningCatalog.refreshOllamaModel({ providerId: provider.id, baseUrl: provider.baseUrl, modelId: model.id }, AbortSignal.timeout(2000));
    }
    const coreReasoning = getConfiguredCoreReasoning(this.ctx.coreReasoningCatalog?.snapshot, provider, model);
    const context = { runtimeId: this.runtimeId, providerId: provider.id, modelId: model.id,
      ...(input.legacyThinkingLevel ? { legacyValues: { reasoning: input.legacyThinkingLevel } } : {}) };
    if (coreReasoning) return {
      ...context, coreReasoning,
      parameters: [describeCoreReasoning(coreReasoning, mode?.thinkingLevel)],
      ...(input.legacyThinkingLevel && !supportsCoreReasoning(coreReasoning, input.legacyThinkingLevel)
        ? { warning: t('当前模型不支持该思考档') } : {})
    };
    const levels = getConfiguredPiThinkingLevels(provider, model) ?? [];
    const requestedDefault = mode?.thinkingLevel ?? 'medium';
    const labels = [t('关闭'), t('低'), t('中'), t('高'), t('最高')];
    return { ...context,
      parameters: levels.length ? [{ id: 'reasoning', semantic: 'reasoning', label: t('思考强度'), apply: 'next-turn', supportsDefault: true,
        ...(levels.some(level => level === requestedDefault) ? { defaultValue: requestedDefault } : {}),
        options: levels.map(value => ({ value, label: labels[GUI_THINKING_LEVELS.indexOf(value)] })) }] : [] };
  }

  /** 模式解析：persona + connect 附加段 + 工具面裁剪（宿主经 driver 合同调用，不感知 pi 细节） */
  resolveMode(modeId: string) {
    const mode = readPiMode(this.opts.userDataDir, modeId);
    if (!mode) return null;
    const connectExtras = piModeConnectExtras(mode);
    return {
      persona: mode.persona,
      connectExtras,
      extraHostTools: isPiCreatorMode(modeId)
        ? buildPiModeTools(this.opts.userDataDir, {
            // extensions 确认卡通道：modes.create/update 携带扩展路径时的强制门（piModes.ts 内），
            // 与 catalog dangerous 门同一 UiBridge.confirm 确认框
            confirmExtensions: (title, detail, confirmOpts) =>
              this.ctx.ui.confirm(title, detail, confirmOpts)
          })
        : undefined,
      hostToolDeny: mode.tools?.hostDeny,
      // 模式裁剪引擎原生工具时，政策层目录同步收敛（宿主只透传，不认识 pi 工具名）
      defaultGuiMode: mode.defaultGuiMode
    };
  }

  /**
   * 会话删除/清空：清引擎侧落盘——转录 `*_<sessionId>.jsonl` 与 trim-cache 目录。
   * 后台子代理会话（同目录的 `bg-<taskId>`）随父会话一并清；幂等，缺文件不算失败。
   * 注意：全程同步 fs 操作（async 只是合同形状）——clear 后同 id 会立即建新引擎
   * 会话文件，异步间隙会把新文件误删。
   */
  async purge(input: GuiDriverPurgeInput): Promise<void> {
    const tokens = [input.sessionId];
    // pi 会话 id 可能漂移（扩展 newSession/fork/switchSession 会换 id 写新文件）：
    // 删除/作废前的旧 token 一并清，否则残留到下次启动清扫才被扫掉
    if (input.runtimeResumeToken) tokens.push(input.runtimeResumeToken);
    if (input.externalSessionId) tokens.push(input.externalSessionId);
    for (const id of this.ctx.bgTasks?.taskIdsForSession(input.sessionId) ?? []) {
      tokens.push(`bg-${id}`);
    }
    this.purgePiTokens(tokens);
  }

  /** 启动孤儿清扫：转录/trim-cache 里 token 不在保留集的即删（早期版本删除会话不清引擎数据的遗留） */
  async sweepOrphans(keep: GuiDriverSweepKeep): Promise<void> {
    const live = new Set<string>();
    for (const m of keep.metas) {
      if (m.runtime !== this.runtimeId) continue;
      live.add(m.id);
      // 同上：id 漂移后活会话的转录文件名带的是旧 pi id，必须一并保留
      if (m.runtimeResumeToken) live.add(m.runtimeResumeToken);
      if (m.externalSessionId) live.add(m.externalSessionId);
    }
    for (const t of keep.bgTokens) live.add(t);
    // 时效护栏（契约：创建晚于快照的数据一律不动）：按 mtime 判——创建晚于快照
    // 的文件 mtime 必然晚于快照，多拦进的只是「快照后被写过的」，宁可漏删不可
    // 误删。pi 文件名前缀是 ISO 时刻串（非数字），不作解析依赖
    const snapshotAt =
      typeof keep.snapshotAt === 'number' && keep.snapshotAt > 0 ? keep.snapshotAt : 0;
    const createdAfterSnapshot = (full: string): boolean => {
      if (!snapshotAt) return false;
      try {
        return fs.statSync(full).mtimeMs >= snapshotAt;
      } catch {
        return true; // stat 不了就当新数据
      }
    };
    const sessionDir = userDataStorage(this.opts.userDataDir).resolve('app', 'pi-native-sessions');
    try {
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.includes('_') && entry.name.endsWith('.jsonl')) {
            // 文件名 `<时间戳>_<token>.jsonl`；无下划线的非会话文件不动
            const token = entry.name.slice(0, -'.jsonl'.length).split('_').pop() ?? '';
            if (isValidPiToken(token) && !live.has(token) && !createdAfterSnapshot(full)) {
              try {
                fs.rmSync(full, { force: true });
              } catch {
                /* 单文件失败跳过 */
              }
            }
          }
        }
      };
      walk(sessionDir);
    } catch (e) {
      console.warn('[pi] 孤儿清扫失败（转录）', e);
    }
    try {
      const trimRoot = userDataStorage(this.opts.userDataDir).resolve('app', 'trim-cache');
      for (const name of fs.readdirSync(trimRoot)) {
        if (live.has(name) || createdAfterSnapshot(path.join(trimRoot, name))) continue;
        // 单目录失败（EBUSY 等）只跳过，不中止剩余目录
        try {
          fs.rmSync(path.join(trimRoot, name), { recursive: true, force: true });
        } catch {
          /* 下次启动清扫重试 */
        }
      }
    } catch {
      /* 目录不存在等情况忽略 */
    }
  }

  /** 按会话 token（sessionId / bg-<taskId>）删转录与 trim-cache；幂等 */
  private purgePiTokens(tokens: string[]): void {
    const sessionDir = userDataStorage(this.opts.userDataDir).resolve('app', 'pi-native-sessions');
    for (const token of tokens) {
      if (!isValidPiToken(token)) continue;
      try {
        const walk = (dir: string): void => {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(`_${token}.jsonl`)) {
              // 单文件失败（如 Windows 下句柄未释 EBUSY）只跳过该文件，不中止整轮
              try {
                fs.rmSync(full, { force: true });
              } catch {
                /* 留给下次启动清扫兜底 */
              }
            }
          }
        };
        walk(sessionDir);
      } catch (e) {
        console.warn(`[pi] purge 转录失败 (${token})`, e);
      }
      try {
        fs.rmSync(path.join(userDataStorage(this.opts.userDataDir).resolve('app', 'trim-cache'), token), {
          recursive: true,
          force: true
        });
      } catch (e) {
        console.warn(`[pi] purge trim-cache 失败 (${token})`, e);
      }
    }
  }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const agentDir = userDataStorage(this.opts.userDataDir).resolve('app', 'muster-core');
    const sessionDir = userDataStorage(this.opts.userDataDir).resolve('app', 'pi-native-sessions');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    // Keep model configuration and credentials on the host side. The worker reads
    // the private Muster Core files and receives only provider/model IDs.
    const requested = input.modelSelectionIntent === undefined ? input.modelOverride ?? null : input.modelSelectionIntent;
    const { resolved } = this.resolveModelConfig(input.modelOverride, requested);
    const llmIdentity = llmConnectionIdentity(resolved);
    await primePiCatalogSnapshot();
    const current = this.resolveModelConfig(input.modelOverride, requested);
    if (llmConnectionIdentity(current.resolved) !== llmIdentity) {
      throw new Error(t('模型连接配置在准备期间变化，请重试'));
    }
    const synced = syncPiConfigFromApp(current.fullConfig, agentDir);
    const shellEnv = resolvePiShellEnv({ piSettings: input.piSettings, agentDir, detect: () => detectGitBashPath() });
    const secrets = [resolved.provider.apiKey, ...Object.values(input.providerHeaders ?? {})]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const globalDelivery = desktopEngineDeliveryFromContext(this.ctx);
    const coreReasoning = input.coreReasoning === undefined
      ? getConfiguredCoreReasoning(this.ctx.coreReasoningCatalog?.snapshot, current.resolved.provider, current.resolved.model)
      : input.coreReasoning;
    return createPiWorkerConnection({ ...input, coreReasoning }, {
      ctx: this.ctx, userDataDir: this.opts.userDataDir,
      providerId: resolved.provider.id, modelId: resolved.model.id, shellEnv, secrets,
      providerDefaultOutput: synced.providerDefaultOutput,
      ...(globalDelivery ? { globalDelivery } : {})
    });
  }
}
