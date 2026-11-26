/**
 * 调度侧转录索引（memory-refactor B5；progress B5 行钉死交付物）：调度 pi 会话长命
 * 跨重启、没有干净的结束事件——B3 的「会话结束摄入」覆盖不到调度面。本模块用
 * **增量索引**：回合 settle/去抖后把新增消息（用户/assistant 文本）以
 * source_type=transcript 进 chunks（session_kind=scheduler），供 Lane2 深检索与
 * memory.search 命中调度对话历史。
 *
 * - 消息 id 锚点防重放（照 B3 摄入检查点先例）：meta 键记消息数+末条消息 id，
 *   重复触发只做增量或跳过；clearHistory/会话切换时先完成尾批再换 display；
 * - 脱敏：候选文本经 redact.ts 凭证遮蔽后入库；
 * - origin 按消息角色+污点保守分类：host 自治消息（host=true）→ scheduler（非用户
 *   输入）；用户消息含明示记住 → user；其余用户消息 → user 面语义但按保守口径
 *   scheduler（转录是双方混写，无逐条用户亲述证据）；消息 toolCalls 命中网络来源
 *   工具 → 该消息按 untrusted；
 * - 判重与召回回路防护对 transcript chunk 同样生效：新消息与既有 chunk 高重叠
 *   （含被注入过的 chunk——recall_stats 在账的）即跳过，防「注入→再入库」回路；
 *   transcript chunk 进全量 chunks 后，noteStaging/后续转录的判重对照面自动含它。
 *
 * 纯 MemoryDb 句柄注入（test/*.mjs 直跑）。
 */
import { MemoryDb, insertChunk, type MemoryOrigin } from './db';
import { hasExplicitRememberInstruction, isNetworkSourceTool } from './provenance';
import { redactCredentialShapes } from './redact';
import { mmrTokenSet } from './ranking';

export const TRANSCRIPT_INDEX_CONSTANTS = {
  /** 单条转录 chunk 文本上限（超长多为粘贴/工具转储，截断保索引质量） */
  MESSAGE_MAX_CHARS: 1_500,
  /** 消息最小长度（寒暄/短指令无检索价值） */
  MIN_CHARS: 12,
  /** 单次增量索引的消息上限（防失控长会话一次灌爆；按消息序取前 N） */
  MAX_MESSAGES_PER_BATCH: 24,
  /** 判重高重叠阈值（与 STAGING_CONSTANTS.DUPLICATE_JACCARD 同档） */
  DUP_JACCARD: 0.75,
  /** 判重扫描行数上限 */
  DUP_SCAN_LIMIT: 2_000,
  /** recall_stats 在账（被注入过）的对照阈值（召回回路防护，与 staging 同档） */
  RECALL_LOOP_JACCARD: 0.6
} as const;

/** 转录索引检查点（防重放；照 B3 IngestCheckpoint 先例） */
export const SCHEDULER_TRANSCRIPT_CHECKPOINT_PREFIX = 'scheduler_transcript_checkpoint:';

export interface SchedulerTranscriptCheckpoint {
  messageCount: number;
  lastMessageId: string;
  indexedCount: number;
  ts: number;
}

export function readTranscriptCheckpoint(db: MemoryDb, sessionKey: string): SchedulerTranscriptCheckpoint | null {
  try {
    const raw = db.metaGet(SCHEDULER_TRANSCRIPT_CHECKPOINT_PREFIX + sessionKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as SchedulerTranscriptCheckpoint;
    return typeof v.messageCount === 'number' && typeof v.lastMessageId === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function writeTranscriptCheckpoint(db: MemoryDb, sessionKey: string, cp: SchedulerTranscriptCheckpoint): void {
  db.metaSet(SCHEDULER_TRANSCRIPT_CHECKPOINT_PREFIX + sessionKey, JSON.stringify(cp));
}

/** 转录索引侧消息最小面（orchestrator display 消息的投影） */
export interface TranscriptIndexMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 文本内容（图片/卡片不参与） */
  content: string;
  /** host 自治消息标记（非用户输入；origin 保守 scheduler） */
  host?: boolean;
  /** 消息携带的工具调用名（污点判定用；无=空数组） */
  toolNames?: readonly string[];
  /** 排队未执行的消息（跳过——尚未真正进入对话） */
  queued?: boolean;
}

export interface IndexSchedulerTranscriptInput {
  /** 会话稳定键（调度 pi 会话文件名或桶 id；检查点按它防重放） */
  sessionKey: string;
  messages: ReadonlyArray<TranscriptIndexMessage>;
  now?: number;
}

export interface IndexSchedulerTranscriptResult {
  ok: true;
  skipped?: 'checkpoint_replay' | 'empty_window';
  examined: number;
  added: number;
  /** 按跳过原因计数（判重/召回回路/长度门） */
  rejected: Partial<Record<'too_short' | 'duplicate' | 'recall_loop', number>>;
}

function normalizeForCompare(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

interface TextRow {
  id: number;
  text: string;
}

function listChunkTextsForDup(db: MemoryDb, normLen: number): TextRow[] {
  const f = 4; // 长度桶窗口（staging 同档：性能收窄，非严格等价）
  const lo = Math.max(1, Math.floor(normLen / f));
  const hi = Math.ceil(normLen * f);
  const rows = db.handle
    .prepare('SELECT id, text FROM chunks WHERE length(text) BETWEEN ? AND ? ORDER BY id LIMIT ?')
    .all(lo, hi, TRANSCRIPT_INDEX_CONSTANTS.DUP_SCAN_LIMIT) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), text: String(r.text) }));
}

function listRecalledChunkIds(db: MemoryDb): Set<number> {
  const rows = db.handle
    .prepare('SELECT DISTINCT chunk_id FROM recall_stats')
    .all() as Array<Record<string, unknown>>;
  return new Set(rows.map((r) => Number(r.chunk_id)));
}

/** 消息 → origin（保守分类：见模块头） */
export function transcriptOriginFor(m: TranscriptIndexMessage): MemoryOrigin {
  if ((m.toolNames ?? []).some((n) => isNetworkSourceTool(n))) return 'untrusted';
  if (m.role === 'user' && !m.host && hasExplicitRememberInstruction(m.content)) return 'user';
  return 'scheduler';
}

/**
 * 调度转录增量索引入口（回合 settle/去抖后与 clearHistory/会话切换尾批共用）。
 * 同步执行（SQLite 同步）；任何异常向上抛由调用方兜底（索引失败绝不影响回合）。
 */
export function indexSchedulerTranscript(
  db: MemoryDb,
  input: IndexSchedulerTranscriptInput
): IndexSchedulerTranscriptResult {
  const now = input.now ?? Date.now();
  const msgs = input.messages.filter((m) => !m.queued);
  const rejected: IndexSchedulerTranscriptResult['rejected'] = {};
  const cp = readTranscriptCheckpoint(db, input.sessionKey);
  let startIdx = 0;
  if (cp) {
    if (cp.messageCount >= msgs.length) {
      return { ok: true, skipped: 'checkpoint_replay', examined: 0, added: 0, rejected };
    }
    const at = msgs.findIndex((m) => m.id === cp.lastMessageId);
    startIdx = at >= 0 ? at + 1 : 0; // 找不到锚点（display 被清重建）从头增量
  }
  const window = msgs.slice(startIdx, startIdx + TRANSCRIPT_INDEX_CONSTANTS.MAX_MESSAGES_PER_BATCH);
  if (window.length === 0) {
    return { ok: true, skipped: cp ? 'checkpoint_replay' : 'empty_window', examined: 0, added: 0, rejected };
  }
  const recalledIds = listRecalledChunkIds(db);
  let added = 0;
  for (const m of window) {
    const red = redactCredentialShapes(m.content ?? '');
    const body = red.text.trim();
    if (body.length < TRANSCRIPT_INDEX_CONSTANTS.MIN_CHARS) {
      rejected.too_short = (rejected.too_short ?? 0) + 1;
      continue;
    }
    const clipped = body.slice(0, TRANSCRIPT_INDEX_CONSTANTS.MESSAGE_MAX_CHARS);
    const norm = normalizeForCompare(clipped);
    const tokens = mmrTokenSet(norm);
    // 判重 + 召回回路防护（对照全量 chunks；被注入过的 chunk 低门槛拒收）
    let dup = false;
    for (const r of listChunkTextsForDup(db, norm.length)) {
      const sim = jaccard(tokens, mmrTokenSet(r.text));
      if (recalledIds.has(r.id) && sim >= TRANSCRIPT_INDEX_CONSTANTS.RECALL_LOOP_JACCARD) {
        rejected.recall_loop = (rejected.recall_loop ?? 0) + 1;
        dup = true;
        break;
      }
      if (normalizeForCompare(r.text) === norm || sim >= TRANSCRIPT_INDEX_CONSTANTS.DUP_JACCARD) {
        rejected.duplicate = (rejected.duplicate ?? 0) + 1;
        dup = true;
        break;
      }
    }
    if (dup) continue;
    insertChunk(db, {
      sourceType: 'transcript',
      sourcePath: `scheduler-session:${input.sessionKey}`,
      text: clipped,
      origin: transcriptOriginFor(m),
      sessionKind: 'scheduler',
      writerAgent: 'scheduler',
      ingestedSessionId: input.sessionKey,
      observedAt: now
    });
    added += 1;
  }
  // 检查点推进到本批窗口末尾（未达全量时下次续批——去抖触发器会再调）
  const lastSeen = window[window.length - 1];
  const seenTotal = Math.min(startIdx + window.length, msgs.length);
  writeTranscriptCheckpoint(db, input.sessionKey, {
    messageCount: seenTotal,
    lastMessageId: lastSeen?.id ?? '',
    indexedCount: added,
    ts: now
  });
  return { ok: true, examined: window.length, added, rejected };
}
