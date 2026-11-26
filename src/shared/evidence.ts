

export type EvidenceKind =
  | 'pty-slice'
  | 'bgtask-summary'
  | 'browser-shot';

/** 翻转事件上下文（pty-slice 条目必带） */
export interface EvidencePhaseRef {
  /** 翻转前 phase（首次上报无） */
  from?: string;
  to: string;
  source: string;
}

/** bgTasks 构建/测试输出摘要（内联，不落单独文件） */
export interface EvidenceBgTask {
  taskId: string;
  /** 命令文本（bgtasks.shell 的 detail） */
  command: string;
  status: string;
  exitCode?: number;
  summary?: string;
}

/** browser-shot 的回合截图归属元数据（任务 D；显式 browser.screenshot 无此段） */
export interface EvidenceTurnShotMeta {
  /** 宿主回合标识（GUI=收口回合 assistant 消息 id；CLI 由活动信号收口，无 turn id） */
  turnId?: string;
  /** 采集时刻 tab 的页面 URL */
  url?: string;
}

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  ts: number;
  /** pty-slice：翻转上下文 */
  phase?: EvidencePhaseRef;
  /** 相对会话目录的文件名（pty-slice / browser-shot） */
  file?: string;
  /** pty-slice：翻转后补抓段落完成的时刻 */
  afterTs?: number;
  /** bgtask-summary 内联数据 */
  bgTask?: EvidenceBgTask;
  /** browser-shot：原始截图路径（browser-captures 目录） */
  sourcePath?: string;
  /** browser-shot：回合结束自动截图的归属元数据（显式截图不带） */
  turnShot?: EvidenceTurnShotMeta;
}

export interface EvidenceIndex {
  version: 1;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  entries: EvidenceEntry[];
}

/** 滚动保留窗口（天） */
export const EVIDENCE_KEEP_DAYS = 7;
/** pty 切片：翻转时刻前后各取的行数 */
export const EVIDENCE_PTY_SLICE_LINES = 120;
/** pty 尾部字符预算（先按字符取尾再按行裁，避免全量 join 大 buffer） */
export const EVIDENCE_PTY_TAIL_CHARS = 24_000;
/** 单会话索引条目上限（FIFO 丢最旧） */
export const EVIDENCE_MAX_ENTRIES = 500;
/** 翻转后补抓 after 段的等待（ms） */
export const EVIDENCE_AFTER_MS = 45_000;
/** bgTask 摘要截断（对齐 BG_TASK_SUMMARY_MAX 口径） */
export const EVIDENCE_BGTASK_SUMMARY_MAX = 600;

/** 证据配置（AppConfig.evidence；browser 截图证据默认关） */
export interface EvidenceConfig {
  browserShots?: boolean;
}

const KIND_PREFIX: Record<EvidenceKind, string> = {
  'pty-slice': 'p',
  'bgtask-summary': 'b',
  'browser-shot': 's'
};

/** 条目 id（也用作文件名主干）：`<kind前缀>-<base36时间戳>-<随机>` */
export function evidenceEntryId(kind: EvidenceKind, ts: number): string {
  return `${KIND_PREFIX[kind]}-${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 已清洗 pty 文本 → 尾部 N 行（压缩 3+ 连续空行、去首尾空白） */
export function slicePtyTail(cleanText: string, lines = EVIDENCE_PTY_SLICE_LINES): string {
  const clean = cleanText.replace(/\n{3,}/g, '\n\n').trim();
  if (lines <= 0 || !clean) return '';
  const all = clean.split('\n');
  return all.length <= lines ? clean : all.slice(all.length - lines).join('\n');
}

/** pty 切片文件头行：翻转事件描述 */
export function formatPhaseFlipHeader(flip: EvidencePhaseRef, ts: number, lines: number): string {
  const from = flip.from ?? '(none)';
  return `[phase-flip] ${from} -> ${flip.to} (source=${flip.source}) at ${new Date(ts).toISOString()} | tail ${lines} lines`;
}

/** after 段分隔标记（翻转后补抓） */
export function formatAfterSection(after: string, delayMs: number): string {
  return `--- after +${Math.round(delayMs / 1000)}s ---\n${after}`;
}

export function newEvidenceIndex(sessionId: string, now: number): EvidenceIndex {
  return { version: 1, sessionId, createdAt: now, updatedAt: now, entries: [] };
}

/** 追加条目（不可变）：超上限丢最旧；updatedAt 推进 */
export function appendEvidenceEntry(
  index: EvidenceIndex,
  entry: EvidenceEntry,
  now: number,
  max = EVIDENCE_MAX_ENTRIES
): EvidenceIndex {
  const entries = [...index.entries, entry];
  const overflow = Math.max(0, entries.length - max);
  return {
    ...index,
    updatedAt: now,
    entries: overflow > 0 ? entries.slice(overflow) : entries
  };
}

/** 条目级过期：ts 距 now 超过 keepMs 的剔除（返回保留/剔除两组） */
export function pruneEvidenceEntries(
  entries: readonly EvidenceEntry[],
  now: number,
  keepMs = EVIDENCE_KEEP_DAYS * 24 * 60 * 60 * 1000
): { kept: EvidenceEntry[]; dropped: EvidenceEntry[] } {
  const kept: EvidenceEntry[] = [];
  const dropped: EvidenceEntry[] = [];
  for (const e of entries) {
    if (now - e.ts > keepMs) dropped.push(e);
    else kept.push(e);
  }
  return { kept, dropped };
}

/** 目录级过期：索引 updatedAt（或孤儿目录 mtime）距 now 超过 keepMs */
export function evidenceDirExpired(updatedAt: number, now: number, keepMs?: number): boolean {
  const keep = keepMs ?? EVIDENCE_KEEP_DAYS * 24 * 60 * 60 * 1000;
  return now - updatedAt > keep;
}

/**
 * 会话目录名安全校验：sessionId 是应用生成的 UUID，但索引/目录操作面对磁盘，
 * 仍拒绝路径穿越与意外字符（只放行 [A-Za-z0-9._-] 且不以 . 开头）。
 */
export function sanitizeEvidenceSessionDir(name: string): string | null {
  if (!name || name.startsWith('.')) return null;
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

/** bgTask 命令/摘要入索引前的截断（内联数据控体积） */
export function truncateEvidenceText(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  const clean = s.replace(/\s+$/, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
