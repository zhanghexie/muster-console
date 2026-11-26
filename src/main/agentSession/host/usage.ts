/**
 * AgentSessionHost 用量视图：实时/陈旧上下文用量的取数、落盘与推送。
 * 原则：实时用量优先；连接未建或引擎未加载时回落 lastUsage（标 stale）。
 */
import {
  isPersistableUsage,
  liveUsageView,
  normalizeContextUsage,
  staleUsageView,
  toLastUsage
} from '../../../shared/guiContextUsage';
import type { GuiUsageView } from '../../../shared/guiContextUsage';
// 别名导入：本模块的宿主函数 providerThinkingConfigured(host, entry) 与共享同名纯函数共存
import { providerThinkingConfigured as providerThinkingConfiguredImpl } from '../../../shared/thinkingLevels';
import { rejectImagesIfModelLacksSupport } from '../../../shared/modelCapabilities';
import type { GuiContextUsage, GuiSendImage } from '../types';
import type { SessionMeta } from '../../../shared/types';
import { resolveLlmConfig } from '../../config';
import { app } from 'electron';
import { readPiMode } from '../drivers/pi/modes';
import type { HostCore, SessionEntry } from './internal';
import { persistEntry, push, scheduleStreamingPersist } from './base';

export function usageModelSelectionKey(model: { providerId?: string; modelId?: string } | null | undefined): string {
  return JSON.stringify([model?.providerId?.trim() || '', model?.modelId?.trim() || '']);
}

/** 生效服务商（会话覆盖 > 全局激活）是否配置了思考档映射 */
export function providerThinkingConfigured(host: HostCore, entry: SessionEntry): boolean {
  const session = host.ctx.sessions.get(entry.sessionId);
  return providerThinkingConfiguredFor(host, session?.modelOverride?.providerId, session);
}

export function providerThinkingConfiguredFor(
  host: HostCore,
  overrideProviderId: string | undefined,
  session: SessionMeta | undefined
): boolean {
  const llm = resolveLlmConfig(host.ctx.config.get());
  const providerId = overrideProviderId || session?.modelOverride?.providerId || llm.provider.id;
  return providerThinkingConfiguredImpl(host.ctx.config.get().llm?.providers ?? [], providerId);
}

/** 原生实时事件或回合收口时推送上下文；数据为未知时可回落陈旧快照。 */
export function pushContext(host: HostCore, entry: SessionEntry, reported?: GuiContextUsage | null): void {
  if (entry.pendingUsageModelKey !== undefined) {
    push(host, { kind: 'context', sessionId: entry.sessionId, usage: null });
    return;
  }
  // An explicit unknown supersedes a previously persisted reading. Do not
  // resurrect that old value while this engine can no longer report usage.
  if (reported === null) {
    if (entry.lastUsage) {
      entry.lastUsage = null;
      if (entry.busy) scheduleStreamingPersist(host, entry);
      else persistEntry(host, entry, []);
    }
    push(host, { kind: 'context', sessionId: entry.sessionId, usage: null });
    return;
  }
  let live: GuiContextUsage | null = reported ?? null;
  if (reported === undefined && entry.connection?.getContextUsage) {
    try {
      live = entry.connection.getContextUsage();
    } catch {
      live = null;
    }
  }
  live = live ? normalizeContextUsage(live.tokens, live.contextWindow) : null;
  rememberUsage(host, entry, live);
  // Keep the event's own snapshot: a driver can receive several updates before
  // the event queue is consumed, so its getter may already contain a later one.
  const usage = live && !(entry.skipUsagePersistUntilTurn && live.tokens === 0)
    ? liveUsageView(live, entry.lastUsage?.ts)
    : historyUsage(host, entry);
  push(host, {
    kind: 'context',
    sessionId: entry.sessionId,
    usage: usage ?? null
  });
}

/** 把可持久化的实时用量写入 entry + 转写；fork 占位 / 种子回放期不写 */
export function rememberUsage(
  host: HostCore,
  entry: SessionEntry,
  live: { tokens: number | null; contextWindow: number } | null
): void {
  if (entry.skipUsagePersistUntilTurn) return;
  // A new zero reading must not revive an older nonzero snapshot after restart.
  // Zero itself remains unpersisted because Pi fork seeds also use it as a placeholder.
  if (live?.tokens === 0 && entry.lastUsage) {
    entry.lastUsage = null;
    if (entry.busy) scheduleStreamingPersist(host, entry);
    else persistEntry(host, entry, []);
    return;
  }
  if (!isPersistableUsage(live)) return;
  const next = toLastUsage(live);
  if (!next) return;
  const prev = entry.lastUsage;
  if (
    prev &&
    prev.tokens === next.tokens &&
    prev.contextWindow === next.contextWindow
  ) {
    return;
  }
  entry.lastUsage = next;
  if (entry.busy) scheduleStreamingPersist(host, entry);
  else persistEntry(host, entry, []);
}

/** 实时用量优先；连接未建或引擎未加载时回落 lastUsage（标 stale） */
export function historyUsage(host: HostCore, entry: SessionEntry): GuiUsageView | null | undefined {
  if (entry.pendingUsageModelKey !== undefined) return null;
  // Older Cursor snapshots contain per-turn SDK usage, not context occupancy.
  if (entry.runtimeId === 'cursor') return undefined;
  if (entry.connection?.getContextUsage) {
    try {
      const live = entry.connection.getContextUsage();
      const valid = live && normalizeContextUsage(live.tokens, live.contextWindow);
      if (valid && !(entry.skipUsagePersistUntilTurn && valid.tokens === 0)) {
        return liveUsageView(valid, entry.lastUsage?.ts);
      }
    } catch {
      /* 回落 lastUsage */
    }
  }
  const stale = staleUsageView(entry.lastUsage);
  return stale ?? undefined;
}

/**
 * Pi GUI：按会话生效模型（modelOverride > 全局）做多模态守卫。
 * Cursor/Claude/ACP/Codex 不走本仓 LLM 配置，只拦 runtime 能力位。
 */
export function rejectImagesForSessionModel(
  host: HostCore,
  entry: SessionEntry,
  images: GuiSendImage[]
): { ok: false; error: string } | null {
  if (entry.runtimeId !== 'pi') return null;
  const session = host.ctx.sessions.get(entry.sessionId);
  const resolved = resolveLlmConfig(host.ctx.config.get(), session?.modelOverride ??
    (session?.piModeId ? readPiMode(app.getPath('userData'), session.piModeId)?.model : undefined));
  const r = rejectImagesIfModelLacksSupport({
    images,
    modelId: resolved.model.id,
    modelName: resolved.model.name || resolved.model.id,
    explicitMultimodal: resolved.model.multimodal
  });
  return r.ok ? null : { ok: false, error: r.error };
}
