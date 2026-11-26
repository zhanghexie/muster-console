/**
 * 记忆条目格式扩展（memory-refactor §4.3）：在现有合同
 * `<!-- YYYY-MM-DD HH:MM:SS [会话短ID] -->` + `#tag [[关联名]] 正文` 上追加
 * **行尾注解**（均可缺省=中性）：
 *
 *   #lesson [[x]] 正文。 <!-- trigger: 词组, 词组 --> <!-- importance: 8 --> <!-- project: key --> <!-- origin: user -->
 *
 * 兼容底线：旧格式条目（无注解）解析→格式化逐字节还原（roundtrip 不丢字节）——
 * 现有解析器 raw 由 ts/sid/正文拼出，本模块序列化按同构拼装，构造上即等值。
 * 解析只剥**合法值**的注解（importance 0/11/非数字等非法值留在正文原样保留），
 * 序列化按结构化字段渲染规范形态（trigger → importance → project → origin 顺序）。
 *
 * USER.md 画像条目（§10，OpenClaw 契约同款）也在此解析：
 * 元数据行 `<!-- observed: 日期 | status: active|superseded -->` + 指令式 directive。
 *
 * 纯函数、零 IO/electron 依赖（test/*.mjs 即时转译导入；格式漂移在这里收口）。
 */
import { buildEntryText, parseMemoryEntries, type MemoryEntry } from '../../shared/memoryFormat';
import { serializeSchedulerMemoryEntry } from '../../shared/schedulerMemory';

// ---------------------------------------------------------------------------
// 行尾注解（§4.3）
// ---------------------------------------------------------------------------

export interface EntryAnnotations {
  /** 触发词组（词法预筛用；缺省=不参与 trigger 注入） */
  trigger?: string[];
  /** 重要性 1–10（写时打分；缺省=中性） */
  importance?: number;
  /** 项目作用域 key（如 github.com/foo/bar；缺省=无作用域） */
  project?: string;
  /**
   * 溯源注解（B7 回填，§5 origin 五类的展示/审计子集）：只允许宿主代码在写入时落
   * （memory.remember 直写 origin=user、巩固晋升带真实来源）——**模型文本里出现的
   * origin 注解在入库时被剥离**（stripOriginAnnotationTail，防 markdown 伪造提权；
   * 信任判定在写入时，注解仅展示/审计用）。untrusted/system 不落注解（缺省=中性）。
   */
  origin?: EntryOriginAnnotation;
}

/** origin 注解的合法值域（五类中可展示的三类；定不了的类不注解） */
export type EntryOriginAnnotation = 'user' | 'scheduler' | 'worker';

export interface MemoryEntryV2 {
  /** 稳定 id（沿用现有解析合同的 id 形态） */
  id: string;
  ts: string;
  sessionId: string;
  tags: string[];
  links: string[];
  /** 正文（含行首 #tag/[[link]] 标记；**不含**行尾注解） */
  text: string;
  /** 行尾注解（结构化）；全部缺省=中性 */
  annotations: EntryAnnotations;
  /** 原文（含注释行与行尾注解；未识别条目=原样内容） */
  raw: string;
  unparsed: boolean;
}

/** 尾部注解注释（仅认四个已知 key；值宽松匹配再单独校验） */
const ANNOTATION_TAIL_RE =
  /\s*<!--\s*(trigger|importance|project|origin)\s*:\s*([^>]*?)\s*-->\s*$/;

/** origin 值：仅 user/scheduler/worker 合法（untrusted/system 不落注解；非法值留在正文） */
function parseOriginValue(value: string): EntryOriginAnnotation | null {
  const v = value.trim();
  return v === 'user' || v === 'scheduler' || v === 'worker' ? v : null;
}

/** trigger 值：逗号分隔词组（非空才有效） */
function parseTriggerValue(value: string): string[] | null {
  const phrases = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return phrases.length ? phrases : null;
}

/** importance 值：1–10 整数才有效（其余留在正文不剥） */
function parseImportanceValue(value: string): number | null {
  if (!/^\d{1,2}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 && n <= 10 ? n : null;
}

/**
 * 从正文尾部剥出注解（重复出现：trigger 合并去重、importance/project 文本末位优先；
 * 非法值即停——其后的注释留在正文里，保证旧文/手写脏数据 roundtrip 不丢字节）。
 */
export function splitEntryAnnotations(text: string): { text: string; annotations: EntryAnnotations } {
  const annotations: EntryAnnotations = {};
  const triggers: string[] = [];
  let body = text ?? '';
  for (;;) {
    const m = body.match(ANNOTATION_TAIL_RE);
    if (!m) break;
    const key = m[1];
    const value = m[2];
    if (key === 'trigger') {
      const phrases = parseTriggerValue(value);
      if (!phrases) break;
      triggers.unshift(...phrases);
    } else if (key === 'importance') {
      const n = parseImportanceValue(value);
      if (n === null) break;
      if (annotations.importance === undefined) annotations.importance = n;
    } else if (key === 'origin') {
      const o = parseOriginValue(value);
      if (o === null) break;
      if (annotations.origin === undefined) annotations.origin = o;
    } else {
      const p = value.trim();
      if (!p) break;
      if (annotations.project === undefined) annotations.project = p;
    }
    body = body.slice(0, m.index);
  }
  if (triggers.length) {
    annotations.trigger = [...new Set(triggers)];
  }
  return { text: body.trimEnd(), annotations };
}

/** 注解 → 规范行尾形态（只渲染存在的字段；trigger → importance → project → origin 顺序） */
export function formatEntryAnnotations(a: EntryAnnotations | undefined): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.trigger?.length) parts.push(`<!-- trigger: ${a.trigger.join(', ')} -->`);
  if (a.importance !== undefined) parts.push(`<!-- importance: ${a.importance} -->`);
  if (a.project) parts.push(`<!-- project: ${a.project} -->`);
  if (a.origin) parts.push(`<!-- origin: ${a.origin} -->`);
  return parts.join(' ');
}

/**
 * 剥离正文尾部的一切 origin 注解（任意值、含非法值——入库防伪造，B7）：
 * 模型产正文里出现的 `<!-- origin: … -->` 在落盘前整体剥掉，宿主写入路径随后按
 * **实际分类**重挂注解（巩固晋升带 staging 真实来源；原 directWrite origin=user
 * 通道已于 2026-10-26 F-01 随 MEMORY.md 直写门退役）。
 * 从尾部贪心剥掉全部已知注解以挖出被后置 trigger/importance/project 挡住的伪造
 * origin；非 origin 注解原样拼回，行为仍等价于「只剥 origin、不动其余注解」。
 */
export function stripOriginAnnotationTail(text: string): string {
  let body = text ?? '';
  const kept: string[] = [];
  for (;;) {
    const m = body.match(/\s*(<!--\s*(trigger|importance|project|origin)\s*:\s*[^>]*?-->)\s*$/);
    if (!m) break;
    if (m[2] !== 'origin') kept.unshift(m[1]);
    body = body.slice(0, m.index);
  }
  body = body.trimEnd();
  if (!kept.length) return body;
  return body ? `${body} ${kept.join(' ')}` : kept.join(' ');
}

/** 当前时刻的条目注释行内容（`YYYY-MM-DD HH:MM:SS`；新条目落盘用，ts 语义与 shared/memoryFormat.stampNow 一致） */
export function entryStampTs(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
}

export interface NewEntryWithAnnotationsInput {
  sessionId?: string;
  tags?: string[];
  links?: string[];
  text: string;
  annotations?: EntryAnnotations;
  /**
   * 落盘面（B8 起两面同收口）：缺省 worker = 共享核心条目合同；
   * scheduler = 调度自由 markdown 合同（tags/links 不消费）。
   */
  surface?: CuratedWriteSurface;
  /**
   * 证据引用行（巩固晋升的 `Source: …`）：**先剥伪造 origin 注解再拼接**——
   * 剥离是尾部匹配，调用方若自行把 citation 拼在正文后，引用行会挡住尾部使
   * 伪造注解漏剥（B8 单点化收口时的实证教训）；拼接顺序由此收口。
   */
  sourceCitation?: string | null;
}

/** 策展核心落盘面（巩固晋升写入用；原直写门已退役） */
export type CuratedWriteSurface = 'worker' | 'scheduler';

/**
 * 新条目落盘（带注解 + 当前时刻戳）：巩固晋升等宿主写入路径的唯一组装出口，
 * **也是伪造 origin 剥离的唯一收口**（B7 评审 MAJOR-1 单点化：两个落盘面
 * 都在此剥一遍；调用方传原文与 citation 即可。还原即红口径随之一一对应：
 * 去掉本函数内的 stripOriginAnnotationTail，伪造注解即落盘，晋升侧测试同转红；
 * 原 directWrite 侧已于 2026-10-26 F-01 随直写门退役）。输出与旧合同逐字节兼容
 * （无注解时 = `<!-- ts [sid] -->\n正文`）。
 */
export function serializeNewEntryWithAnnotations(input: NewEntryWithAnnotationsInput, now: Date): string {
  const body = stripOriginAnnotationTail(String(input.text ?? '').trim());
  const withSource = input.sourceCitation ? `${body}\n${input.sourceCitation}` : body;
  if (input.surface === 'scheduler') {
    const block = serializeSchedulerMemoryEntry(withSource, now).trimEnd();
    const origin = input.annotations?.origin;
    return origin ? `${block} <!-- origin: ${origin} -->` : block;
  }
  const e: MemoryEntryV2 = {
    id: '',
    ts: entryStampTs(now),
    sessionId: (input.sessionId ?? 'memory').trim() || 'memory',
    tags: input.tags ?? [],
    links: input.links ?? [],
    text: buildEntryText(input.tags ?? [], input.links ?? [], withSource),
    annotations: input.annotations ?? {},
    raw: '',
    unparsed: false
  };
  return serializeMemoryEntryV2(e);
}

/** 解析全文 → 扩展条目数组（现有解析器跑底座，注解在 text 之上二次剥离） */
export function parseMemoryEntriesV2(md: string): MemoryEntryV2[] {
  return parseMemoryEntries(md).map((e: MemoryEntry) => {
    if (e.unparsed) {
      return { ...e, annotations: {} };
    }
    const split = splitEntryAnnotations(e.text);
    return { ...e, text: split.text, annotations: split.annotations };
  });
}

/** 序列化单条（未识别条目原样返回；注解缺省时输出与旧合同逐字节一致） */
export function serializeMemoryEntryV2(e: MemoryEntryV2): string {
  if (e.unparsed) return e.raw;
  const stamp = `<!-- ${e.ts} [${e.sessionId}] -->`;
  const suffix = formatEntryAnnotations(e.annotations);
  return suffix ? `${stamp}\n${e.text} ${suffix}` : `${stamp}\n${e.text}`;
}

/** 序列化条目列表 → 全文（条目间空行；现有 removeEntryById 同款拼装口径） */
export function serializeMemoryFileV2(entries: MemoryEntryV2[]): string {
  return entries.length ? `${entries.map((e) => serializeMemoryEntryV2(e)).join('\n\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// USER.md 画像条目（§10）：observed 元数据行 + 指令式 directive
// ---------------------------------------------------------------------------

export type ProfileEntryStatus = 'active' | 'superseded';

export interface ProfileEntry {
  /** 稳定 id：`<observed>-<status>-<内容指纹>`；未识别块为 `raw-<序号>` */
  id: string;
  /** 观察日期 YYYY-MM-DD */
  observed: string;
  status: ProfileEntryStatus;
  /** 指令式 directive（Always/Never/Prefer 开头的一条行为；解析不强制词头） */
  directive: string;
  /** 原文（元数据行 + directive；未识别块=原样内容） */
  raw: string;
  unparsed: boolean;
}

/** 元数据行；status 缺省按 active 容错（序列化恒写全） */
const PROFILE_META_RE = /^<!--\s*observed:\s*(\d{4}-\d{2}-\d{2})\s*(?:\|\s*status:\s*(active|superseded)\s*)?-->$/;

/** 稳定 id 指纹（shared/memoryFormat 的 fnv1a 为私有，这里同算法复制一份） */
function fnv1a36(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 解析 USER.md 全文：元数据行开条，其后至下一元数据行/EOF 为 directive；
 * 元数据行外的内容（文件头说明等）归未识别块，原样保留。
 */
export function parseProfileEntries(md: string): ProfileEntry[] {
  const out: ProfileEntry[] = [];
  const lines = (md ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let pending: string[] = [];
  const flushPending = (seq: number): void => {
    const raw = pending.join('\n').trim();
    pending = [];
    if (!raw) return;
    out.push({ id: `raw-${seq}-${fnv1a36(raw)}`, observed: '', status: 'active', directive: '', raw, unparsed: true });
  };
  let cur: { observed: string; status: ProfileEntryStatus; body: string[] } | null = null;
  let unparsedSeq = 0;
  const flushCur = (): void => {
    if (!cur) return;
    const body = cur.body.join('\n').trim();
    if (body) {
      const raw = `<!-- observed: ${cur.observed} | status: ${cur.status} -->\n${body}`;
      out.push({
        id: `${cur.observed}-${cur.status}-${fnv1a36(raw)}`,
        observed: cur.observed,
        status: cur.status,
        directive: body,
        raw,
        unparsed: false
      });
    }
    cur = null;
  };
  for (const line of lines) {
    const meta = line.match(PROFILE_META_RE);
    if (meta) {
      flushPending(unparsedSeq++);
      flushCur();
      cur = { observed: meta[1], status: (meta[2] as ProfileEntryStatus) ?? 'active', body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
    else pending.push(line);
  }
  flushCur();
  flushPending(unparsedSeq++);
  return out;
}

/** 序列化画像条目（未识别块原样；识别条目按结构化字段规范渲染） */
export function serializeProfileEntry(e: ProfileEntry): string {
  if (e.unparsed) return e.raw;
  return `<!-- observed: ${e.observed} | status: ${e.status} -->\n${e.directive}`;
}

/** 画像文件 bootstrap 硬上限（§10：4000 字符，只可调低不能调高） */
export const USER_PROFILE_MAX_CHARS = 4000;
