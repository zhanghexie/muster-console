/**
 * 长期记忆（MEMORY.md）格式单源：条目解析/序列化、#tag 与 [[link]] 提取、
 * recovery 删除备份 schema、重复检测、托管块与 SKILL.md 文案渲染。
 * agent 追加约定、记忆面板 IPC、curation 三方共用本模块，格式漂移在这里收口。
 * 零依赖（test/*.mjs 即时转译导入）。
 *
 * 条目格式（pi-memory 同款）：
 *   <!-- YYYY-MM-DD HH:MM:SS [会话短ID] -->
 *   #tag1 [[关联名]] 正文……
 * 时间戳注释 = 条目边界；无注释的前导内容解析为「未识别条目」（面板降级展示）。
 */
import { jaccard, tokenSet } from './searchTokens';

export interface MemoryEntry {
  /** 稳定 id：`<ts>-<sid>`；未识别条目为 `raw-<序号>` */
  id: string;
  /** 时间戳注释内容，如 `2026-09-02 10:12:03`；未识别条目为空串 */
  ts: string;
  /** 会话短 ID；未识别条目为空串 */
  sessionId: string;
  tags: string[];
  links: string[];
  /** 正文（已去 tag/link 标记？不——正文保留原文，tags/links 仅供筛选与展示） */
  text: string;
  /** 原文（含注释行）；未识别条目 = 原样内容 */
  raw: string;
  /** true = 前导无时间戳注释的内容（格式坏掉/手写），面板降级展示 */
  unparsed: boolean;
}

export const MEMORY_META_RE = /^<!--\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[([^\]\r\n]+)\]\s*-->$/;
const TAG_RE = /(^|\s)[#＃]([^\s#＃，。；、！？]+)/g;
const LINK_RE = /\[\[([^\]\r\n]+)\]\]/g;

/** 当前时刻的条目注释行 */
export function stampNow(now?: Date, sessionId?: string): string {
  const d = now ?? new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const sid = (sessionId ?? '').trim() || 'manual';
  return `<!-- ${ts} [${sid}] -->`;
}

/** 提取正文里的 #tag（去前缀，保持出现顺序去重） */
export function extractTags(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(TAG_RE)) {
    const tag = m[2].trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 提取 [[wiki-link]] 关联名（保持出现顺序去重） */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(LINK_RE)) {
    const link = m[1].trim();
    if (link && !out.includes(link)) out.push(link);
  }
  return out;
}

/** 组装一条条目的正文行：`#a #b [[x]] 正文`（tags/links 可空） */
export function buildEntryText(tags: string[], links: string[], text: string): string {
  const parts = [...tags.map((t) => `#${t}`), ...links.map((l) => `[[${l}]]`)];
  const body = (text ?? '').trim();
  return parts.length ? `${parts.join(' ')} ${body}` : body;
}

/** 稳定 id 的内容指纹（FNV-1a 36 进制；shared 零依赖，不能用 node:crypto） */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 解析 MEMORY.md 全文 → 条目数组（保持文件顺序；前导无注释内容 → unparsed 条目）。
 *  id = ts+sid+内容指纹：跨删除/重排稳定，不随位置重编号；
 *  同文重复条目（git 多机并发追加的常见形态）追加 #2/#3 位序后缀消歧，
 *  保证「删一张卡只删一处」与列表 key 唯一。容错：吞掉 UTF-8 BOM。 */
export function parseMemoryEntries(md: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const lines = (md ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let pending: string[] = [];
  const flushPending = (): void => {
    const raw = pending.join('\n').trim();
    pending = [];
    if (!raw) return;
    out.push({
      id: `raw-${fnv1a(raw)}`,
      ts: '',
      sessionId: '',
      tags: extractTags(raw),
      links: extractLinks(raw),
      text: raw,
      raw,
      unparsed: true
    });
  };
  let cur: { ts: string; sid: string; body: string[] } | null = null;
  const flushCur = (): void => {
    if (!cur) return;
    const body = cur.body.join('\n').trim();
    if (body) {
      const raw = `<!-- ${cur.ts} [${cur.sid}] -->\n${body}`;
      out.push({
        id: `${cur.ts}-${cur.sid}-${fnv1a(raw)}`,
        ts: cur.ts,
        sessionId: cur.sid,
        tags: extractTags(body),
        links: extractLinks(body),
        text: body,
        raw,
        unparsed: false
      });
    }
    cur = null;
  };
  for (const line of lines) {
    const meta = line.match(MEMORY_META_RE);
    if (meta) {
      flushPending();
      flushCur();
      cur = { ts: `${meta[1]} ${meta[2]}`, sid: meta[3], body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
    else pending.push(line);
  }
  flushCur();
  flushPending();
  dedupeIds(out);
  return out;
}

/** 同 id 条目（同 ts+sid+同文）追加位序后缀：`<id>#2`、`<id>#3`…… */
function dedupeIds(entries: MemoryEntry[]): void {
  const seen = new Map<string, number>();
  for (const e of entries) {
    const n = (seen.get(e.id) ?? 0) + 1;
    seen.set(e.id, n);
    if (n > 1) e.id = `${e.id}#${n}`;
  }
}

/** 去掉正文行首已带的 #tag / [[link]] 标记（结构化编辑回传原文时防重复拼接） */
export function stripLeadingMarkers(text: string): string {
  let t = (text ?? '').trim();
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(/^(?:[#＃][^\s#＃，。；、！？]+|\[\[[^\]\r\n]+\]\])\s*/, '').trim();
  }
  return t;
}

/** 序列化条目 → 待追加文本块（注释 + 正文；tags/links 组装进行首） */
export function serializeMemoryEntry(
  entry: Pick<MemoryEntry, 'ts' | 'sessionId' | 'text' | 'tags' | 'links'>,
  now?: Date
): string {
  const stamp =
    entry.ts && entry.sessionId
      ? `<!-- ${entry.ts} [${entry.sessionId}] -->`
      : stampNow(now, entry.sessionId || 'manual');
  return `${stamp}\n${buildEntryText(entry.tags, entry.links, entry.text)}`;
}

/** 追加一条到 MEMORY.md 全文 */
export function appendEntryToContent(existing: string, block: string): string {
  const base = (existing ?? '').replace(/\s+$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** 从全文中移除指定 id 的条目；返回新全文与被移除条目（recovery 用）。找不到返回 null。
 *  保留条目按 raw 原样写回（不经 serialize，避免 tags/links 重复拼接）；
 *  同文重复条目因 id 带位序后缀，只移除命中的一处。 */
export function removeEntryById(md: string, id: string): { content: string; removed: MemoryEntry } | null {
  const entries = parseMemoryEntries(md);
  const target = entries.find((e) => e.id === id);
  if (!target) return null;
  const kept = entries.filter((e) => e.id !== id);
  const content = kept.length
    ? `${kept.map((e) => e.raw).join('\n\n')}\n`
    : '';
  return { content, removed: target };
}

/** 未识别条目的原位替换：把 oldRaw 的首次出现换成 newBlock（同文重复时替换任一等价）。
 *  CRLF 兜底：外部编辑器存成 \r\n 时 indexOf 必 miss——退按 CRLF 形态再找一次。 */
export function replaceRawBlock(content: string, oldRaw: string, newBlock: string): string {
  const at = content.indexOf(oldRaw);
  if (at >= 0) return `${content.slice(0, at)}${newBlock}${content.slice(at + oldRaw.length)}`;
  const crlf = oldRaw.replace(/\n/g, '\r\n');
  const at2 = crlf !== oldRaw ? content.indexOf(crlf) : -1;
  if (at2 >= 0) return `${content.slice(0, at2)}${newBlock}${content.slice(at2 + crlf.length)}`;
  return appendEntryToContent(content, newBlock);
}

// ---------------------------------------------------------------------------
// 结构化输入归一（面板 / memory.note·remember 写工具共用）：写入侧约束，杜绝 ##tag / [[x]] 伪标记进文件
// ---------------------------------------------------------------------------

export const MEMORY_INPUT_MAX = { text: 4000, tags: 8, links: 8, tag: 40, link: 60 } as const;

/** 归一 tags：剥行首 #/＃、去重保序、上限截断（超限丢弃不报错——筛选视觉元素） */
export function normalizeTagInput(tags: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/^[#＃]+/, '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MEMORY_INPUT_MAX.tags) break;
  }
  return out.filter((t) => t.length <= MEMORY_INPUT_MAX.tag);
}

/** 归一 links：剥 [[ ]] 包裹、去重保序 */
export function normalizeLinkInput(links: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(links) ? links : []) {
    if (typeof raw !== 'string') continue;
    const link = raw.replace(/^\[\[+/, '').replace(/\]\]+$/, '').trim();
    if (link && !out.includes(link)) out.push(link);
    if (out.length >= MEMORY_INPUT_MAX.links) break;
  }
  return out.filter((l) => l.length <= MEMORY_INPUT_MAX.link);
}

// ---------------------------------------------------------------------------
// 注入选择（M-A 预算扩容版）：按优先级装箱而不是对整文件中间截断
// ---------------------------------------------------------------------------

/** 注入优先档：decision/preference=0（全档最高），其余已知结构条目=1，未识别=2 */
const INJECTION_PRIORITY_TAGS = new Set(['decision', 'preference']);

export function injectionRank(e: MemoryEntry): number {
  if (e.unparsed) return 2;
  return e.tags.some((t) => INJECTION_PRIORITY_TAGS.has(t)) ? 0 : 1;
}

export interface InjectionSelection {
  /** 装入预算的条目（保持文件原序，注入文本时间线可读） */
  selected: MemoryEntry[];
  /** 预算装不下被挤出的条目（按被挤出顺序） */
  dropped: MemoryEntry[];
}

/**
 * 预算装箱：按「优先档升序 → 时间新→旧 → 文件序」逐条装入，装不下的挤出；
 * 首条无条件装入（单条超预算也至少保底最新优先的一条）。
 */
export function selectEntriesForInjection(entries: MemoryEntry[], budgetChars: number): InjectionSelection {
  const ranked = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const r = injectionRank(a.e) - injectionRank(b.e);
      if (r !== 0) return r;
      return a.e.ts < b.e.ts ? 1 : a.e.ts > b.e.ts ? -1 : a.i - b.i;
    });
  const chosen = new Set<number>();
  const dropped: MemoryEntry[] = [];
  let used = 0;
  for (const { e, i } of ranked) {
    const size = e.raw.length + 2; // 条目间空行
    if (chosen.size === 0 || used + size <= budgetChars) {
      chosen.add(i);
      used += size;
    } else {
      dropped.push(e);
    }
  }
  return { selected: entries.filter((_, i) => chosen.has(i)), dropped };
}

// ---------------------------------------------------------------------------
// recovery（可恢复删除）：schema 校验 + 生成（pi-memory 同款，wx 独占创建在 store 层）
// ---------------------------------------------------------------------------

export const RECOVERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MemoryRecoveryRecord {
  version: 1;
  id: string;
  createdAt: string;
  /** 被删条目完整内容（raw） */
  removedContent: string[];
}

export function isRecoveryRecord(value: unknown): value is MemoryRecoveryRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<MemoryRecoveryRecord>;
  return (
    r.version === 1 &&
    typeof r.id === 'string' &&
    RECOVERY_ID_RE.test(r.id) &&
    typeof r.createdAt === 'string' &&
    Array.isArray(r.removedContent) &&
    r.removedContent.length > 0 &&
    r.removedContent.every((s) => typeof s === 'string')
  );
}

// ---------------------------------------------------------------------------
// 重复 / 矛盾检测（curation 手动形态）：正文 token Jaccard 相似度启发式
// ---------------------------------------------------------------------------

export interface DuplicatePair {
  aId: string;
  bId: string;
  score: number;
}

/** 相似度 ≥ threshold（默认 0.72）的条目对，按分数降序 */
export function findDuplicatePairs(entries: MemoryEntry[], threshold = 0.72): DuplicatePair[] {
  const sets = entries.map((e) => ({ id: e.id, set: tokenSet(e.text) }));
  const out: DuplicatePair[] = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const score = jaccard(sets[i].set, sets[j].set);
      if (score >= threshold) out.push({ aId: sets[i].id, bId: sets[j].id, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** 疑似矛盾/变更信号：否定/替换类词（不/弃/废/改/换/迁/回退） */
const POLARITY_RE = /不|弃|废|改|换|迁|回退|取消/;

/**
 * 疑似矛盾对：同 tag、中等相似（0.35~0.72，像在说同一件事但措辞不同）、
 * 且至少一方带否定/替换信号。保守启发式，仅作人工复核提示。
 */
export function findConflictPairs(entries: MemoryEntry[]): DuplicatePair[] {
  const sets = entries.map((e) => ({ e, set: tokenSet(e.text), polarity: POLARITY_RE.test(e.text) }));
  const out: DuplicatePair[] = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      const sharedTag = a.e.tags.some((t) => b.e.tags.includes(t));
      if (!sharedTag) continue;
      const score = jaccard(a.set, b.set);
      if (score < 0.35 || score >= 0.72) continue;
      if (!a.polarity && !b.polarity) continue;
      out.push({ aId: a.e.id, bId: b.e.id, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

// ---------------------------------------------------------------------------
// 记忆技能指路
// ---------------------------------------------------------------------------

export function buildWorkerMemoryGuidance(toolName: (id: string) => string | undefined): string {
  const search = toolName('host.memory.search');
  const journal = toolName('host.memory.journal');
  const note = toolName('host.memory.note');
  const remember = toolName('host.memory.remember');
  if (!search && !journal && !note && !remember) return '';

  return [
    'Read ~/.muster/skills/memory/SKILL.md before your first memory tool call in this session.',
    search && `For prior work, past decisions or corrections, recurring issues, or standing preferences, search first with ${search} and short topic keywords.`,
    journal && `Use ${journal} for decisions, findings, or handoffs worth revisiting.`,
    note && `Proactively submit lasting facts or preferences the user shares via ${note}.`,
    remember && `For explicit remember requests, use ${remember}.`,
    'If the skill is unreadable, use registered tools. Report failures. Leave private memory files untouched.'
  ].filter(Boolean).join(' ');
}

/** Compatibility pointer only; the maintained skill body ships in resources/skills/memory. */
export function renderMemorySkillSection(): string {
  return '## Muster memory\n\n仅在Muster宿主会话中，读取 `~/.muster/skills/memory/SKILL.md`。非宿主不触发。';
}
