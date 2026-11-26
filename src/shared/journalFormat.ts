/**
 * 工作日志（journal）格式合同单源。
 * 解析（日报面板 / M1 退出摘要校验）、序列化、托管块与 SKILL.md 文案渲染共用本模块；
 * 格式漂移在这里收口（方案 C：校验器不过不落盘）。零依赖（test/*.mjs 即时转译导入）。
 *
 * 条目合同：`## [主题 ≤20字] 状态` 行 + `- 问题：` + 至少一条 `- 要点：`；
 * 侧栏「工作日报」面板依赖此格式解析，改格式必须同步该面板与 M1 校验（都以本模块为准）。
 */

export type JournalStatus = '进行中' | '已完成' | '阻塞' | '搁置';

export interface JournalEntry {
  /** 主题（不含方括号） */
  topic: string;
  /** Explicit cross-session topic identity; names alone never merge records. */
  topicId?: string;
  status: JournalStatus;
  problem: string;
  points: string[];
}

/** 条目状态词表（唯一事实来源；下方正则从这里拼出，勿再写第二份） */
export const JOURNAL_STATUSES: readonly JournalStatus[] = ['进行中', '已完成', '阻塞', '搁置'];

/** `## [主题] 状态` 标题行（条目边界；状态词从 JOURNAL_STATUSES 拼出，模板串里 \\s 是给 RegExp 的 \s） */
const ENTRY_HEAD_RE = new RegExp(`^##\\s*\\[(.+?)\\]\\s*(${JOURNAL_STATUSES.join('|')})\\s*$`);
const PROBLEM_RE = /^-\s*问题：\s*(.*)$/;
const POINT_RE = /^-\s*要点：\s*(.*)$/;

/** 逐行解析一段 markdown 里的全部条目；无法归类的行忽略。
 *  嵌套子行（`- 要点：` 之后缩进的子列表/续行）并入上一条要点的文本——
 *  它们是 journal 语料（BM25 检索）的一部分，不能只索引行首一层。 */
export function parseJournalEntries(md: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  let cur: JournalEntry | null = null;
  let canContinue = false; // 上一行是 `- 要点：`（可吸收缩进续行）
  const flush = (): void => {
    if (cur && cur.problem) out.push(cur);
    cur = null;
  };
  for (const line of (md ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const head = line.match(ENTRY_HEAD_RE);
    if (head) {
      flush();
      cur = { topic: head[1].trim(), status: head[2] as JournalStatus, problem: '', points: [] };
      canContinue = false;
      continue;
    }
    if (!cur) continue;
    const topicId = line.match(/^<!-- muster-topic:([^\s]+) -->$/);
    if (topicId) {
      try { cur.topicId = decodeURIComponent(topicId[1]); } catch { /* Ignore malformed legacy metadata. */ }
      continue;
    }
    const problem = line.match(PROBLEM_RE);
    if (problem) {
      cur.problem = problem[1].trim();
      canContinue = false;
      continue;
    }
    const point = line.match(POINT_RE);
    if (point) {
      cur.points.push(point[1].trim());
      canContinue = true;
      continue;
    }
    // 缩进行 = 上一条要点的嵌套子行，并入该要点文本（剥子项列表符号）；空行不断开；非缩进杂行断开归属
    if (/^\s+\S/.test(line)) {
      if (canContinue && cur.points.length > 0) {
        const i = cur.points.length - 1;
        const piece = line.trim().replace(/^[-•*]\s+/, '');
        cur.points[i] = cur.points[i] ? `${cur.points[i]} ${piece}` : piece;
      }
    } else if (line.trim()) {
      canContinue = false;
    }
  }
  flush();
  return out;
}

/** 序列化单条（不含条目间空行） */
export function serializeJournalEntry(e: JournalEntry): string {
  const lines = [`## [${e.topic}] ${e.status}`, ...(e.topicId ? [`<!-- muster-topic:${encodeURIComponent(e.topicId)} -->`] : []), `- 问题：${e.problem}`];
  for (const p of e.points) lines.push(`- 要点：${p}`);
  return lines.join('\n');
}

/**
 * 校验一段待落盘文本是「单条合法条目」：标题行 + 问题 + 至少一条要点，且不含多余标题。
 * M1 退出摘要用它做「不过不落盘」闸；返回 null=非法（附原因）。
 */
export function validateSingleEntryText(text: string): { ok: true; entry: JournalEntry } | { ok: false; reason: string } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, reason: '空文本' };
  const lines = trimmed.split(/\r?\n/);
  const heads = lines.filter((l) => ENTRY_HEAD_RE.test(l.trim()));
  if (heads.length !== 1) return { ok: false, reason: `标题行应为恰好 1 条「## [主题] 状态」，实际 ${heads.length} 条` };
  const parsed = parseJournalEntries(trimmed);
  if (parsed.length !== 1) return { ok: false, reason: '解析不出完整条目' };
  const entry = parsed[0];
  if (!entry.topic) return { ok: false, reason: '主题为空' };
  if (entry.topic.length > 20) return { ok: false, reason: `主题超 20 字（${entry.topic.length}）` };
  if (!entry.problem) return { ok: false, reason: '缺「- 问题：」行' };
  if (entry.points.length === 0) return { ok: false, reason: '缺「- 要点：」行' };
  return { ok: true, entry };
}

/** 追加一条到既有文件内容（不存在则补当日文件头）；prefixComment 为条目上方的注释行
 *  （如退出摘要的去重 marker），随条目同块落盘。返回新全文 */
export function appendEntryToContent(
  existing: string,
  entry: JournalEntry,
  dayKey: string,
  prefixComment?: string
): string {
  const header = `# ${dayKey} 工作日志`;
  const block = prefixComment?.trim()
    ? `${prefixComment.trim()}\n${serializeJournalEntry(entry)}`
    : serializeJournalEntry(entry);
  const base = (existing ?? '').replace(/\s+$/, '');
  if (!base) return `${header}\n\n${block}\n`;
  return `${base}\n\n${block}\n`;
}
