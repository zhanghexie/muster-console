/**
 * 会话批注（对 AI 回复划词批注）的共享逻辑：token 生成、发送展开、位置查找、摘除。
 * 纯函数（test/note-annotations.mjs 即时转译导入锁行为）。
 */

import { composerProtectedReferenceRanges } from './workerModelMention';

/** 批注展开协议标识：生成端与发送路由共用，批注永不充当提问答案。 */
export const NOTE_ANNOTATION_PREFIX = { session: '[会话批注]', file: '[文件批注 ', web: '[网页批注 ' } as const;
export function containsNoteAnnotation(text: string): boolean {
  return Object.values(NOTE_ANNOTATION_PREFIX).some(prefix => text.includes(prefix));
}

export interface NoteAnnotationCore {
  seq: number;
  quote: string;
  note: string;
  /**
   * 文件批注：来源路径及可选根身份，多根时路径使用可读盘的绝对路径。
   * line/endLine = 选区起止行（1-based，endLine 缺省或相同只标起始行）。
   */
  file?: { path: string; line?: number; endLine?: number; fileRef?: import('./types').WorkspaceFileRef };
  /**
   * 网页批注：锚在内置浏览器拾取的元素（quote=label）。发送展开为选择器+批注。
   */
  web?: { label: string; selector: string; url: string };
}

/** 队列里的批注草稿快照：发送正文与可编辑 token 分开保存。 */
export interface QueuedNoteDraft {
  text: string;
  notes: Array<NoteAnnotationCore & {
    id: string;
    messageId: string;
    web?: { label: string; selector: string; url: string; shot?: string };
  }>;
}

/** 输入框里的 token 形态：批注1、批注2 …（与快捷短语药丸同款观感） */
export function makeNoteToken(seq: number): string {
  return `批注${seq}`;
}

/** 新建「批注N」全局匹配器（与 makeNoteToken 同形态的唯一正则源；
 *  每次新建实例，调用方无需操心 lastIndex 状态。composerTokens 也引用此处） */
export function makeNoteTokenMatcher(): RegExp {
  return /批注\d+/g;
}

/** CLI 引用是可持久化的纯文本；JSON 字符串保留空格、引号和跨平台路径。 */
export function composerFileReference(path: string): string { return `[File: ${JSON.stringify(path)}]`; }
export function composerSkillReference(name: string, path: string): string {
  return `Use skill ${JSON.stringify(name)}; read ${JSON.stringify(path)}.`;
}

/** 文件名或技能名可能含「批注1」；这些完整引用不是批注 token。 */
export function composerReferenceRanges(text: string): Array<[number, number]> {
  return composerProtectedReferenceRanges(text);
}

export function mapOutsideComposerReferences(text: string, map: (part: string) => string): string {
  let result = '', last = 0;
  for (const [start, end] of composerReferenceRanges(text)) {
    result += map(text.slice(last, start)) + text.slice(start, end);
    last = end;
  }
  return result + map(text.slice(last));
}

export function noteTokensInText(text: string): string[] {
  const found: string[] = [];
  mapOutsideComposerReferences(text, part => { found.push(...(part.match(makeNoteTokenMatcher()) ?? [])); return part; });
  return found;
}

export function replaceNoteTokens(text: string, replace: (token: string) => string): string {
  return mapOutsideComposerReferences(text, part => part.replace(makeNoteTokenMatcher(), replace));
}

export function nextNoteSeq(seqs: readonly number[]): number {
  return seqs.reduce((m, s) => Math.max(m, s), 0) + 1;
}

/**
 * 单条批注的展开形态：原文与用户批注用标签明确分开，AI 不会把所选内容当成
 * 用户说的话。会话批注锚在消息上；文件批注带路径与行号区间。
 */
export function expandNoteToken(n: NoteAnnotationCore): string {
  const note = n.note ? `；用户批注：${n.note}` : '';
  if (n.web) {
    return `${NOTE_ANNOTATION_PREFIX.web}${n.web.label}] 页面：${n.web.url}；选择器：${n.web.selector}${note}`;
  }
  if (n.file) {
    const loc =
      n.file.line != null
        ? n.file.endLine != null && n.file.endLine > n.file.line
          ? `${n.file.path}:${n.file.line}-${n.file.endLine}`
          : `${n.file.path}:${n.file.line}`
        : n.file.path;
    return `${NOTE_ANNOTATION_PREFIX.file}${loc}] 原文：“${n.quote}”${note}`;
  }
  return `${NOTE_ANNOTATION_PREFIX.session} 原文：“${n.quote}”${note}`;
}

/** 发送展开：批注N → 各自的展开形态（未匹配 token 原样保留） */
export function expandNoteTokens(text: string, notes: readonly NoteAnnotationCore[]): string {
  const byToken = new Map(notes.map(n => [makeNoteToken(n.seq), n]));
  return replaceNoteTokens(text, token => {
    const note = byToken.get(token);
    return note ? expandNoteToken(note) : token;
  });
}

/** 从输入文本摘除一个 token（连带至多 3 个前导空格；负向断言保证「批注1」不误伤「批注10」） */
export function stripNoteToken(text: string, token: string): string {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return mapOutsideComposerReferences(text, part => part.replace(new RegExp(` {0,3}${esc}(?!\\d)`, 'g'), ''));
}

/** token 在文本中的全部出现位置（药丸镜像层定位用） */
export function findNoteTokenRanges(text: string, token: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!token) return out;
  const references = composerReferenceRanges(text);
  let idx = text.indexOf(token);
  while (idx !== -1) {
    if (!references.some(([start, end]) => idx >= start && idx < end)) out.push([idx, idx + token.length]);
    idx = text.indexOf(token, idx + token.length);
  }
  return out;
}

/**
 * token 间隔自动规范化（批注1批注2 / 批注1 批注2 → 批注1   批注2）：药丸的视觉
 * 外沿比字形宽（::before 各占 5px），不足 3 个空格会让相邻药丸贴死或重叠；
 * 间隔规范由系统兜底消除，用户删掉的空格会被补回。
 */
export function separateNoteTokens(text: string): string {
  return mapOutsideComposerReferences(text, part => {
    let out = part;
    let prev: string;
    do {
      prev = out;
      out = out.replace(/(批注\d+) {1,2}(?=批注\d)/g, '$1   ');
      out = out.replace(/(批注\d+)(批注\d+)/g, '$1   $2');
    } while (out !== prev);
    return out;
  });
}

/** 是否存在需规范化的 token 间隔（是否需要跑 separateNoteTokens 的快判） */
export function hasAdjacentNoteTokens(text: string): boolean {
  let found = false;
  mapOutsideComposerReferences(text, part => { if (/批注\d+( {1,2})?批注\d+/.test(part)) found = true; return part; });
  return found;
}

/**
 * 摘除指向已不存在批注的孤儿 token（批注是会话内内存态，草稿桶却持久化——
 * 重启后 token 活得比批注久，发送时会展开成裸「批注N」让模型困惑）。
 * validSeqs 为当前有效批注序号；无孤儿时原文本返回。
 */
export function stripOrphanNoteTokens(text: string, validSeqs: readonly number[]): string {
  const valid = new Set(validSeqs);
  return mapOutsideComposerReferences(text, part => {
    const out = part.replace(/ {0,3}批注(\d+)(?!\d)/g, (full, seq: string) => valid.has(Number(seq)) ? full : '');
    return out === part ? out : out.replace(/ {4,}/g, '   ');
  });
}
