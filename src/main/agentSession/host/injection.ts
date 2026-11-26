/**
 * AgentSessionHost Harness 透明·注入快照：连接级快照入信封与逐轮注入变化换代。
 * 旁路纪律：任何异常吞掉，透明模式故障不影响连接建立与回合。
 */
import {
  buildInjectionSnapshot,
  hashInjectionText,
  injectionSnapshotsEqual,
  type GuiEngineCapture,
  type GuiInjectionSnapshot
} from '../../../shared/guiWorker';
import { t } from '../../../shared/i18n';
import type { SessionMeta } from '../../../shared/types';
import { guiTurnHasProgress } from '../../agent/turnRetry';
import type { GuiHostIntroDelivery } from '../persist';
import type { HostCore, SessionEntry } from './internal';
import { log, push } from './base';

export function prepareHostIntro(host: HostCore, entry: SessionEntry, session?: SessionMeta): GuiHostIntroDelivery {
  const attempt = session?.workerRouting?.attempts.at(-1)?.attempt ?? 0;
  if (entry.hostIntroDelivery?.attempt === attempt) return entry.hostIntroDelivery;
  try {
    const saved = host.store.loadHostIntroDelivery(entry.sessionId);
    if (saved?.attempt === attempt) return entry.hostIntroDelivery = saved;
    // Migrate existing native conversations using prior model activity. A resume
    // token alone can be assigned before any prompt has reached the engine.
    const delivered = !saved && !!session?.runtimeResumeToken && !entry.workerRouteHandoff &&
      !entry.forkSeed && !entry.forkTranscript && !entry.forkTranscriptSource &&
      entry.messages.some(message => message.role === 'assistant' && message.id !== entry.assistant?.id &&
        (!!message.harness || guiTurnHasProgress(message)));
    return saveHostIntroDelivery(host, entry, { attempt, delivered });
  } catch (error) {
    log(host, entry, 'warn', `宿主说明投递记录读取失败：${String(error)}`);
    return entry.hostIntroDelivery = { attempt, delivered: false };
  }
}

function saveHostIntroDelivery(host: HostCore, entry: SessionEntry, delivery: GuiHostIntroDelivery): GuiHostIntroDelivery {
  entry.hostIntroDelivery = delivery;
  try {
    host.store.saveHostIntroDelivery(entry.sessionId, delivery);
  } catch (error) {
    log(host, entry, 'warn', `宿主说明投递记录保存失败：${String(error)}`);
  }
  return delivery;
}

export function acknowledgeHostIntro(host: HostCore, entry: SessionEntry): void {
  const delivery = entry.hostIntroDelivery;
  const assistantId = entry.pendingHostIntro?.assistantMessageId;
  if (!delivery || delivery.delivered || !assistantId || entry.assistant?.id !== assistantId) return;
  entry.pendingHostIntro = undefined;
  saveHostIntroDelivery(host, entry, { ...delivery, delivered: true });
}

/** 当前回合用户消息时刻（忙时取最后一条用户消息；空闲/找不到回 undefined） */
export function currentTurnUserTs(entry: SessionEntry): number | undefined {
  if (!entry.busy) return undefined;
  for (let i = entry.messages.length - 1; i >= 0; i--) {
    const m = entry.messages[i]!;
    if (m.role === 'user') return m.ts;
  }
  return undefined;
}

/**
 * 注入快照记入会话信封（连接级；内容与上一代逐段一致则不追加——重连同内容不换代）。
 * 分段 = 政策层基底 / 记忆段（仅非 pi：pi 记忆走逐轮钩子，连接时预记会过时说谎）/
 * 模式 persona；capture 为引擎真身（系统提示词/工具目录，pi 提供）。
 * at：快照生效时刻（冷启动连接回填当前回合用户消息 ts；缺省 now）。
 * 旁路纪律：任何异常吞掉，透明模式故障不影响连接建立。
 */
export function recordInjectionSnapshot(
  host: HostCore,
  entry: SessionEntry,
  basePrompt: string,
  memorySection: string,
  persona?: string,
  capture?: GuiEngineCapture,
  at?: number,
  workspaceSection?: string
): void {
  try {
    if(entry.closed||entry.clearing||host.entries.get(entry.sessionId)!==entry)return;
    const sources: Array<{ source: string; text: string }> = [
      { source: t('政策层（材料化）'), text: basePrompt }
    ];
    if (workspaceSection?.trim()) sources.push({ source: t('工作区目录范围'), text: workspaceSection });
    // 非 pi 的记忆并进首次宿主说明；pi 由 modeHooks 逐轮注入并经
    // injection-update 报到（真实渲染文本），这里不再预记记忆段
    if (entry.runtimeId !== 'pi' && memorySection.trim()) {
      sources.push({ source: t('记忆段'), text: memorySection.trim() });
    }
    if (persona?.trim()) {
      sources.push({ source: t('模式段'), text: persona.trim() });
    }
    // 逐轮注入段（injection-update 已报到的）合并进连接快照：重连换代时连接级段
    // 重建，但逐轮段仍生效——不合并会造成「记忆段被移除」的假代际
    for (const [source, text] of entry.injectionUpdates) {
      const idx = sources.findIndex((s) => s.source === source);
      if (idx >= 0) sources[idx] = { source, text };
      else sources.push({ source, text });
    }
    const snap = buildInjectionSnapshot(at ?? Date.now(), sources, capture);
    if (!snap) return;
    const last = entry.injections[entry.injections.length - 1] ?? null;
    if (injectionSnapshotsEqual(last, snap)) return;
    const summary=host.store.recordInjection(entry.sessionId,snap);
    entry.injections.push(snap);
    // 运行期换代推送：活跃会话开着透明模式时，注入标注数据源要即时跟上
    //（attach 读取范围摘要；不推的话首连/换代的卡要重挂才出现）
    push(host, { kind: 'injections', sessionId: entry.sessionId, injection:summary,metadataCounts:{injectionCount:entry.injections.length,compactionCount:entry.compactions.length} });
  } catch (e) {
    log(host, entry, 'warn', `注入快照记录失败（忽略）: ${(e as Error).message}`);
  }
}

/**
 * 逐轮注入变化（pi modeHooks：首轮报到基线 / stable 快照重渲染）落新代际：
 * 以最后一代为基底换/加该段（保持每代 = 当时的完整追加面），引擎真身原样继承。
 * at 回填当前回合用户消息 ts——该段确实是这一轮提示词的一部分。
 * 旁路纪律：任何异常吞掉，透明标注故障不影响回合。
 */
export function handleInjectionUpdate(host: HostCore, entry: SessionEntry, source: string, text: string): void {
  try {
    if(entry.closed||entry.clearing||host.entries.get(entry.sessionId)!==entry)return;
    const last = entry.injections[entry.injections.length - 1] ?? null;
    if (last) {
      const segments = last.segments.filter((s) => s.source !== source);
      if (text.trim()) {
        segments.push({
          source,
          chars: text.length,
          hash: hashInjectionText(text),
          text
        });
      }
      const next: GuiInjectionSnapshot = {
        at: currentTurnUserTs(entry) ?? Date.now(),
        segments,
        ...(last.enginePrompt ? { enginePrompt: last.enginePrompt } : {}),
        ...(last.tools ? { tools: last.tools } : {})
      };
      if (!injectionSnapshotsEqual(last, next)) {
        const summary=host.store.recordInjection(entry.sessionId,next);
        entry.injections.push(next);
        push(host, {
          kind: 'injections',
          sessionId: entry.sessionId,
          injection:summary,metadataCounts:{injectionCount:entry.injections.length,compactionCount:entry.compactions.length}
        });
      }
    }
    // 已知逐轮段文本留存（连接快照重建时合并，防重连换代丢段）
    if (text.trim()) entry.injectionUpdates.set(source, text.trim());
    else entry.injectionUpdates.delete(source);
  } catch (e) {
    log(host, entry, 'warn', `逐轮注入记录失败（忽略）: ${(e as Error).message}`);
  }
}
