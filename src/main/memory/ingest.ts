/**
 * 会话结束转录摄入（memory-refactor §6.2）：交互会话（GUI Worker/chat 面）release/
 * 归档时把转录里有信息量的断言消息经 noteStaging 通道落情景暂存。
 *
 * 门与防护（全在写入前，逐层）：
 * - 种类门：非交互会话（heartbeat/auto/headless）整批拒收——会话种类由**运行时
 *   会话上下文**（宿主钩子处的 SessionMeta/调度身份）判定后传入，不做事后猜测；
 * - 召回标记剔除（§5 召回回路防护）：调度注入的消息（source=scheduler，即简报/
 *   回注）不是用户输入，不提取为候选——注入过的内容永不回炉；
 * - 回合内污点（§5）：消息流里出现网络来源工具结果后，其后 assistant 消息按
 *   untrusted 分类；下一条用户消息清污；
 * - 凭证脱敏（redact.ts）：候选文本进 staging 前正则遮蔽，保守优先；
 * - 检查点防重放：每会话摄入进度落派生库 meta（消息数+末条消息 id），重复触发
 *   （归档→重开→再归档、钩子重放）只做增量或直接跳过。
 *
 * 纯逻辑 + MemoryDb 句柄注入（测试 .mjs 直跑，不依赖 electron/AppContext）。
 */
import { MemoryDb } from './db';
import {
  classifyOrigin,
  hasExplicitRememberInstruction,
  isNetworkSourceTool,
  isPromotableSessionKind,
  type MemoryWriterSurface
} from './provenance';
import { redactCredentialShapes } from './redact';
import type { MemoryOrigin } from './db';
import type { MemorySessionKind } from './service';
import {
  type IngestCheckpoint,
  noteStaging,
  readIngestCheckpoint,
  writeIngestCheckpoint,
  type NoteStagingRejectReason
} from './staging';

/** 候选切分参数（一条消息至多提一条可独立理解的短结论） */
export const INGEST_CONSTANTS = {
  /** 用户消息最小长度（太短多是指令寒暄，无信息量） */
  USER_MIN_CHARS: 16,
  /** 助手消息最小长度（断言性结论） */
  ASSISTANT_MIN_CHARS: 32,
  /** 单消息候选长度上限（超长多为粘贴/代码，不是断言；staging 上限另有兜底） */
  MESSAGE_MAX_CHARS: 1_500,
  /** 暂存只收短结论；完整会话仍保留在转录检索层 */
  NOTE_MAX_CHARS: 260,
  /** 单次摄入候选上限（优先保留明确要求记住和较新的结论） */
  MAX_CANDIDATES_PER_SESSION: 4
} as const;

/** 助手消息的断言性标记（有信息量的结论/决策/因果；调参面，B4 巩固门再过滤） */
const ASSERTION_MARKERS = [
  '结论', '决定', '定案', '根因', '原因', '采用', '选用', '选定', '选择', '应当', '必须',
  '注意', '教训', '坑', '修复', '实现', '行为', '协议', '约束', '契约',
  'decision', 'because', 'root cause', 'conclusion', 'so we', 'we should', 'must', 'note that'
];

/** 判断一条消息文本是否「有信息量的断言」（候选启发；纯函数） */
export function isInformativeAssertion(role: 'user' | 'assistant', text: string): boolean {
  const body = stripCodeFences(text).trim();
  if (!body || body.length > INGEST_CONSTANTS.MESSAGE_MAX_CHARS) return false;
  if (role === 'user') {
    if (hasExplicitRememberInstruction(body)) return true; // 明示记住恒为候选
    if (body.length < INGEST_CONSTANTS.USER_MIN_CHARS) return false;
    // 纯疑问/短指令不是断言：整段以问号收尾且无句号分句的放行面窄化
    if (/[?？]\s*$/.test(body) && !/[.。!！;；]/.test(body)) return false;
    return /[.。!！;；]|应当|必须|不要|应该/.test(body); // 陈述句标记
  }
  if (body.length < INGEST_CONSTANTS.ASSISTANT_MIN_CHARS) return false;
  const lower = body.toLowerCase();
  return ASSERTION_MARKERS.some((m) => body.includes(m) || lower.includes(m));
}

/** 剥掉围栏代码块（候选不该是代码；粘贴大段代码的消息整段跳过由长度上限兜底） */
function stripCodeFences(text: string): string {
  return (text ?? '').replace(/```[\s\S]*?```/g, '').trim();
}

/** 从会话答复中提一条独立的结论；进度、命令和长段原文留在情景检索。 */
export function extractCandidateNote(role: 'user' | 'assistant', text: string): string | null {
  const plain = stripCodeFences(text)
    .replace(/^\s*(?:#{1,6}\s*|[-*]\s*|\d+[.)]\s*)/gm, '')
    .replace(/`([^`]+)`/g, '$1');
  const sentences = plain.split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((part) => part.trim().replace(/^[「“]+|[」”]+$/g, ''))
    .filter(Boolean);
  const durable = /根因|结论|决定|定案|教训|约束|契约|必须|应当|不要|采用|选用|root cause|decision|must/i;
  const progress = /^(?:我会|我先|接下来|正在|已运行|已执行|已经打开|测试通过|检查完成|改完了|已提交)/;
  const minChars = role === 'user' ? INGEST_CONSTANTS.USER_MIN_CHARS : INGEST_CONSTANTS.ASSISTANT_MIN_CHARS;
  const chosen = sentences.find((part) => part.length >= minChars && part.length <= INGEST_CONSTANTS.NOTE_MAX_CHARS && durable.test(part) && !progress.test(part))
    ?? (role === 'user' ? sentences.find((part) => part.length >= minChars && part.length <= INGEST_CONSTANTS.NOTE_MAX_CHARS && !progress.test(part)) : null);
  return chosen ?? null;
}

export interface IngestMessagePart {
  kind: 'text' | 'thinking' | 'tool';
  text?: string;
  toolName?: string;
}

/** 摄入侧消息最小面（GuiChatMessage 的投影；宿主钩子处映射，测试直接构造） */
export interface IngestMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 文本片段（user 恒单 text；assistant 按序） */
  parts: IngestMessagePart[];
  /** 转写身份：'scheduler'=调度注入（简报/回注）→ 召回标记剔除 */
  host?: boolean;
  source?: import('../../shared/chatMessageSource').ChatTranscriptSource;
}

export interface IngestTranscriptInput {
  sessionId: string;
  sessionKind: MemorySessionKind;
  writerSurface: MemoryWriterSurface;
  messages: ReadonlyArray<IngestMessage>;
  taskId?: string | null;
  repoKey?: string | null;
  /** 证据路径（转录文件/会话引用；面板溯源用） */
  evidencePath?: string | null;
}

export interface IngestTranscriptResult {
  ok: true;
  /** 整批跳过原因（种类门/检查点重放/空转录）；added=0 */
  skipped?: 'session_kind_gate' | 'checkpoint_replay' | 'empty_transcript';
  /** 本次新看过的消息数（检查点之后） */
  examined: number;
  added: number;
  /** 按拒收原因计数（noteStaging 门） */
  rejected: Partial<Record<NoteStagingRejectReason, number>>;
}

interface DraftCandidate {
  text: string;
  role: 'user' | 'assistant';
  messageId: string;
  tainted: boolean;
  explicitRemember: boolean;
  redactionHits: string[];
}

function messageText(m: IngestMessage): string {
  return m.parts
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * 消息流 → 候选草稿（纯函数；含污点走查与脱敏）。
 * 污点规则（§5）：assistant 消息的 tool part 命中网络来源工具 → 从其后的 assistant
 * 消息起 taint=true，直到下一条**用户真输入**（source≠scheduler）清污。
 */
export function buildIngestCandidates(
  messages: ReadonlyArray<IngestMessage>
): DraftCandidate[] {
  const drafts: DraftCandidate[] = [];
  let tainted = false;
  for (const m of messages) {
    const text = messageText(m);
    // 网络来源工具结果：出现在 assistant 消息的 tool part（GUI 转录里工具挂在 assistant）
    if (m.role === 'assistant' && m.parts.some((p) => p.kind === 'tool' && isNetworkSourceTool(p.toolName))) {
      tainted = true;
    }
    if (m.role === 'user') {
      // 调度注入（简报/回注）：召回标记剔除，不是用户输入；同时**不清污**（注入不构成用户回合）
      if (m.host || m.source === 'scheduler' || m.source === 'agent') continue;
      tainted = false; // 用户真输入清污（§5）
    }
    if (!isInformativeAssertion(m.role, text)) continue;
    const red = redactCredentialShapes(text);
    const note = extractCandidateNote(m.role, red.text);
    if (!note) continue;
    drafts.push({
      text: note,
      role: m.role,
      messageId: m.id,
      tainted,
      explicitRemember: m.role === 'user' ? hasExplicitRememberInstruction(text) : false,
      redactionHits: red.hits
    });
  }
  // 后期结论通常修正前面的试探；显式「记住」优先，其余取较新的候选。
  const explicit = drafts.filter((d) => d.explicitRemember);
  const ordinary = drafts.filter((d) => !d.explicitRemember).reverse();
  return [...explicit, ...ordinary].slice(0, INGEST_CONSTANTS.MAX_CANDIDATES_PER_SESSION);
}

/**
 * 会话结束摄入入口（宿主 release 钩子调用；同步执行）。任何内部异常向上抛由钩子
 * 兜底 try/catch（摄入失败不影响 release 主流程）。
 */
export function ingestTranscript(db: MemoryDb, input: IngestTranscriptInput): IngestTranscriptResult {
  const rejected: IngestTranscriptResult['rejected'] = {};
  // 种类门（§5）：非交互会话整批拒收（钩子处已按运行时会话上下文跳过；此处兜底，
  // 且不写检查点——种类判定来源变了（如会话转为交互）应允许重摄）
  if (!isPromotableSessionKind(input.sessionKind)) {
    return { ok: true, skipped: 'session_kind_gate', examined: 0, added: 0, rejected };
  }
  const cp = readIngestCheckpoint(db, input.sessionId);
  // 增量窗口：从检查点末条消息之后开始（找不到该 id 时从头——转录被清空重建的场景）
  let startIdx = 0;
  if (cp) {
    if (cp.messageCount >= input.messages.length) {
      return { ok: true, skipped: 'checkpoint_replay', examined: 0, added: 0, rejected };
    }
    const at = input.messages.findIndex((m) => m.id === cp.lastMessageId);
    startIdx = at >= 0 ? at + 1 : 0;
  }
  const window = input.messages.slice(startIdx);
  if (window.length === 0) {
    return { ok: true, skipped: cp ? 'checkpoint_replay' : 'empty_transcript', examined: 0, added: 0, rejected };
  }

  const drafts = buildIngestCandidates(window);
  let added = 0;
  for (const d of drafts) {
    const origin: MemoryOrigin = classifyOrigin({
      sessionKind: input.sessionKind,
      latestUserTurnHasExplicitRemember: d.explicitRemember,
      toolResultsTainted: d.tainted,
      writerSurface: input.writerSurface
    }).origin;
    const r = noteStaging(db, {
      text: d.text,
      origin,
      sessionKind: input.sessionKind,
      taskId: input.taskId ?? null,
      repoKey: input.repoKey ?? null,
      evidencePath: input.evidencePath ?? null,
      observedAt: Date.now(),
      signals: {
        source: 'transcript-ingest',
        role: d.role,
        messageId: d.messageId,
        ...(d.redactionHits.length ? { redactionHits: d.redactionHits } : {})
      }
    });
    if (r.ok) added += 1;
    else rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
  }
  const nextCp: IngestCheckpoint = {
    messageCount: input.messages.length,
    lastMessageId: input.messages[input.messages.length - 1]?.id ?? '',
    ingestedCount: added,
    ts: Date.now()
  };
  writeIngestCheckpoint(db, input.sessionId, nextCp);
  return { ok: true, examined: window.length, added, rejected };
}
