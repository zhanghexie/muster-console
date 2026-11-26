/**
 * 索引构建器（memory-refactor §8 索引生命周期）：markdown 记忆源切块入 chunks 表 +
 * 文件 mtime+size 快速路径与内容哈希身份的增量重索引（memorySearch.ts 惰性失效先例）+ fs.watch 防抖
 * （watcher 失效自动退化懒同步——每次检索/同步仍做指纹检查，主动通知只是加速）。
 *
 * 源与切块粒度：
 * - docs/memory/MEMORY.md 与 .muster/scheduler/MEMORY.md（source_type=memory，
 *   常青）：parseMemoryEntriesV2 逐条一个 chunk，注解进 importance/triggers/repo_key；
 * - 当前 memory/journal/*.md（source_type=journal，带日期）：parseJournalEntries 逐条，
 *   文件名日期进 observed_at（排序引擎新近度衰减用）；无条目整文件兜底一块；
 * - USER.md（source_type=user_md，常青，userData 侧 P6 接线）：active 指令逐条；
 * - docs/features/*.md（source_type=features，常青，B5 评审 MAJOR-2 恢复旧引擎语料
 *   面）：功能实现文档语料——**只可检索、不进任何注入面、结构性不可晋升**（晋升候选
 *   只来自 staging；trigger 策展层限定只认 memory/user_md）；`## ` 小节切块，文件名
 *   拼进 chunk 文本保「按文件名找文档」命中，无小节整文件兜底，单块超长硬切续块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  type ChunkSourceType,
  MemoryDb,
  deleteChunksBySource,
  listIndexedSourcePaths,
  replaceChunksForSource
} from './db';
import { parseJournalEntries } from '../../shared/journalFormat';
import {
  parseMemoryEntriesV2,
  parseProfileEntries,
  type EntryOriginAnnotation
} from './entryFormat';
import {
  FEATURES_DIR_REL,
  JOURNAL_DIR_REL,
  MEMORY_FILE_REL,
  SCHEDULER_MEMORY_FILE_REL
} from './paths';

// ---------------------------------------------------------------------------
// 记忆源清单（canonical 路径常量单源在 memory/paths.ts；本模块曾自持同值副本并
// 注「——B8 收口」但实际未收口，B8 评审收尾改为导入，不再自持）
// ---------------------------------------------------------------------------

export type MemorySourceFamily = 'memory' | 'journal' | 'user_md' | 'features';

export interface MemoryIndexSource {
  absPath: string;
  sourceType: ChunkSourceType;
  /** 库内源标识（工作区相对路径；USER.md 为 `user:USER.md`） */
  sourcePath: string;
  family: MemorySourceFamily;
  /** journal 文件名日期 YYYY-MM-DD（无/不合法为 undefined） */
  fileDay?: string;
}

export interface ListSourcesOptions {
  userMdPath?: string;
  /** journal 目录扫描文件数上限（防失控目录；超限按文件名升序保留旧→新） */
  journalScanLimit?: number;
  /** features 目录扫描文件数上限（同 journal 防失控口径） */
  featuresScanLimit?: number;
}

/** USER.md 在库内的源标识（工作区相对路径之外的命名空间，避免与文档路径撞车） */
export const USER_MD_SOURCE_PATH = 'user:USER.md';

const JOURNAL_SCAN_DEFAULT_LIMIT = 400;
const FEATURES_SCAN_DEFAULT_LIMIT = 400;

/** 列目录下 *.md（不存在/不可读=空）；按文件名排序，超限保留字典序末尾（旧→新） */
function listMdFiles(dir: string, limit: number): string[] {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch {
    /* 目录不存在/不可读：无该源 */
  }
  if (names.length > limit) names = names.slice(names.length - limit);
  return names;
}

/** 列出本工作区的记忆源文件（不存在的文件也列出——指纹 null 即视为清除其 chunk） */
export function listMemoryIndexSources(
  workspaceRoot: string,
  opts: ListSourcesOptions = {}
): MemoryIndexSource[] {
  const root = path.resolve(workspaceRoot);
  const out: MemoryIndexSource[] = [
    {
      absPath: path.join(root, MEMORY_FILE_REL),
      sourceType: 'memory',
      sourcePath: MEMORY_FILE_REL.replace(/\\/g, '/'),
      family: 'memory'
    },
    {
      absPath: path.join(root, SCHEDULER_MEMORY_FILE_REL),
      sourceType: 'memory',
      sourcePath: SCHEDULER_MEMORY_FILE_REL.replace(/\\/g, '/'),
      family: 'memory'
    }
  ];
  const journalDir = path.join(root, JOURNAL_DIR_REL);
  const journalLimit = opts.journalScanLimit ?? JOURNAL_SCAN_DEFAULT_LIMIT;
  for (const name of listMdFiles(journalDir, journalLimit)) {
    out.push({
      absPath: path.join(journalDir, name),
      sourceType: 'journal',
      sourcePath: `${JOURNAL_DIR_REL.replace(/\\/g, '/')}/${name}`,
      family: 'journal',
      fileDay: /^\d{4}-\d{2}-\d{2}\.md$/.test(name) ? name.slice(0, -3) : undefined
    });
  }
  // features 功能文档语料（MAJOR-2）：只进检索索引，永不进注入/晋升面
  const featuresDir = path.join(root, FEATURES_DIR_REL);
  const featuresLimit = opts.featuresScanLimit ?? FEATURES_SCAN_DEFAULT_LIMIT;
  for (const name of listMdFiles(featuresDir, featuresLimit)) {
    out.push({
      absPath: path.join(featuresDir, name),
      sourceType: 'features',
      sourcePath: `${FEATURES_DIR_REL.replace(/\\/g, '/')}/${name}`,
      family: 'features'
    });
  }
  if (opts.userMdPath) {
    out.push({
      absPath: opts.userMdPath,
      sourceType: 'user_md',
      sourcePath: USER_MD_SOURCE_PATH,
      family: 'user_md'
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 切块（纯函数；测试直查）
// ---------------------------------------------------------------------------

export interface IndexedChunkDraft {
  text: string;
  lineStart: number | null;
  lineEnd: number | null;
  observedAt: number | null;
  importance: number | null;
  triggers: string[] | null;
  repoKey: string | null;
  /**
   * 行尾 origin 注解（B7 回填，展示/审计用——信任判定在写入时，模型文本的伪造注解
   * 已在入库侧剥离）。无注解=null → 插库维持现状（memory 面兜 'system'）。
   */
  origin: EntryOriginAnnotation | null;
}

/** `YYYY-MM-DD` + 可选 `HH:MM:SS` → epoch ms（本地时区；非法 null） */
export function parseLocalDayMillis(day: string | null | undefined, time = '00:00:00'): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00';
  const ms = new Date(`${day}T${t}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 在 md 里按文件序定位各 raw 块的起止行（1 基）；找不到该块行号落 null */
function locateLineSpans(
  md: string,
  raws: ReadonlyArray<string | null>
): Array<{ start: number | null; end: number | null }> {
  const spans: Array<{ start: number | null; end: number | null }> = [];
  const lineOffsets: number[] = [0];
  for (let i = 0; i < md.length; i += 1) {
    if (md.charCodeAt(i) === 10 /* \n */) lineOffsets.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let pos = 0;
  for (const raw of raws) {
    if (!raw) {
      spans.push({ start: null, end: null });
      continue;
    }
    const at = md.indexOf(raw, pos);
    if (at < 0) {
      spans.push({ start: null, end: null });
      continue;
    }
    spans.push({ start: lineAt(at), end: lineAt(at + raw.length - 1) });
    pos = at + raw.length;
  }
  return spans;
}

/** memory 条目 ts（`YYYY-MM-DD HH:MM:SS`）→ epoch ms */
function memoryEntryTsToMillis(ts: string): number | null {
  const m = ts.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  return m ? parseLocalDayMillis(m[1], m[2]) : null;
}

/** 整文件超长兜底截断（无结构可切时防单 chunk 失控；正常条目级切块不会触顶） */
const WHOLE_FILE_CHUNK_MAX_CHARS = 4000;

/** features 文档按 `## ` 小节切分（首个小节前的导语也算一段；1 基行号随段返回） */
function splitFeatureSections(md: string): Array<{
  title: string;
  body: string;
  lineStart: number;
  lineEnd: number;
}> {
  const lines = md.split(/\r?\n/);
  const sections: Array<{ title: string; lines: string[]; start: number }> = [
    { title: '', lines: [], start: 1 }
  ];
  lines.forEach((line, i) => {
    const m = line.match(/^##\s+(.*)$/);
    if (m) sections.push({ title: m[1].trim(), lines: [], start: i + 1 });
    else sections[sections.length - 1].lines.push(line);
  });
  return sections
    .map((s) => ({
      title: s.title,
      body: s.lines.join('\n').trim(),
      lineStart: s.start,
      lineEnd: s.start + s.lines.length - 1
    }))
    .filter((s) => s.body.length > 0);
}

/** 一个记忆源文件 → chunk 草稿列表（顺序=文件序）；features 面传 fileTitle=文件名 */
export function chunkMemorySource(
  md: string,
  family: MemorySourceFamily,
  fileDay?: string | null,
  fileTitle?: string | null
): IndexedChunkDraft[] {
  const drafts: IndexedChunkDraft[] = [];
  if (family === 'memory') {
    const entries = parseMemoryEntriesV2(md);
    const spans = locateLineSpans(md, entries.map((e) => e.raw));
    entries.forEach((e, i) => {
      if (e.unparsed) {
        drafts.push({
          text: e.raw,
          lineStart: spans[i].start,
          lineEnd: spans[i].end,
          observedAt: null,
          importance: null,
          triggers: null,
          repoKey: null,
          origin: null
        });
        return;
      }
      drafts.push({
        text: e.text,
        lineStart: spans[i].start,
        lineEnd: spans[i].end,
        observedAt: memoryEntryTsToMillis(e.ts),
        importance: e.annotations.importance ?? null,
        triggers: e.annotations.trigger ?? null,
        repoKey: e.annotations.project ?? null,
        origin: e.annotations.origin ?? null
      });
    });
    if (drafts.length === 0 && md.trim()) {
      drafts.push({
        text: md.trim().slice(0, WHOLE_FILE_CHUNK_MAX_CHARS),
        lineStart: 1,
        lineEnd: null,
        observedAt: null,
        importance: null,
        triggers: null,
        repoKey: null,
        origin: null
      });
    }
    return drafts;
  }
  if (family === 'journal') {
    const dayMs = parseLocalDayMillis(fileDay);
    const entries = parseJournalEntries(md);
    if (entries.length === 0) {
      if (!md.trim()) return drafts;
      drafts.push({
        text: `${fileDay ?? ''} ${md.trim()}`.trim().slice(0, WHOLE_FILE_CHUNK_MAX_CHARS),
        lineStart: 1,
        lineEnd: null,
        observedAt: dayMs,
        importance: null,
        triggers: null,
        repoKey: null,
        origin: null
      });
      return drafts;
    }
    const raws = entries.map((e) =>
      [`## [${e.topic}] ${e.status}`, `- 问题：${e.problem}`, ...e.points.map((p) => `- 要点：${p}`)].join('\n')
    );
    const spans = locateLineSpans(md, raws);
    entries.forEach((e, i) => {
      drafts.push({
        text: `${e.topic} ${e.problem} ${e.points.join(' ')}`.trim(),
        lineStart: spans[i].start,
        lineEnd: spans[i].end,
        observedAt: dayMs,
        importance: null,
        triggers: null,
        repoKey: null,
        origin: null
      });
    });
    return drafts;
  }
  if (family === 'features') {
    // features 功能文档（B5 评审 MAJOR-2）：只可检索、不进注入/晋升面——按 `## ` 小节
    // 切块（文件名拼进正文保「按文件名找文档」命中），无小节整文件兜底，单块超长硬切
    // 续块（正文不静默丢弃）；常青语料无日期语义（observed_at=null + 排序引擎不衰减）。
    const title = fileTitle?.trim() || 'features';
    for (const s of splitFeatureSections(md)) {
      const head = s.title ? `${title}｜${s.title}` : title;
      const full = `${head}\n${s.body}`;
      for (let i = 0, part = 0; i < full.length; i += WHOLE_FILE_CHUNK_MAX_CHARS, part += 1) {
        drafts.push({
          text: full.slice(i, i + WHOLE_FILE_CHUNK_MAX_CHARS),
          lineStart: part === 0 ? s.lineStart : null,
          lineEnd: part === 0 ? s.lineEnd : null,
          observedAt: null,
          importance: null,
          triggers: null,
          repoKey: null,
          origin: null
        });
      }
    }
    return drafts;
  }
  // user_md：只索引 active 指令（superseded 不入检索；unparsed 文件头无检索价值）；
  // 画像是用户自有文件（人在面板直改=终审、宿主治理路径写入）→ origin 恒 user
  for (const e of parseProfileEntries(md)) {
    if (e.unparsed || e.status !== 'active' || !e.directive.trim()) continue;
    drafts.push({
      text: e.directive.trim(),
      lineStart: null,
      lineEnd: null,
      observedAt: parseLocalDayMillis(e.observed),
      importance: null,
      triggers: null,
      repoKey: null,
      origin: 'user'
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// 增量同步（mtime+size 快速路径 + 内容哈希身份）
// ---------------------------------------------------------------------------

export const INDEX_FINGERPRINTS_META_KEY = 'index_fingerprints_v2';

interface SourceFingerprintV2 {
  mtimeMs: number;
  size: number;
  sha256: string;
}

function sourceStamp(absPath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(absPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sourceContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 对外保留的快速文件指纹 `mtimeMs:size`；缺失/不可读 null。完整哈希只在同步时入账。 */
export function sourceFingerprint(absPath: string): string | null {
  try {
    const st = fs.statSync(absPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export interface IndexSyncSummary {
  /** 本次重索引的源（库内 sourcePath） */
  changed: string[];
  /** 本次清除 chunk 的源（文件删除/不可读） */
  removed: string[];
  totalChunks: number;
  durationMs: number;
}

export interface IndexSyncOptions {
  userMdPath?: string;
}

function readFingerprints(db: MemoryDb): Record<string, SourceFingerprintV2> {
  try {
    const parsed = JSON.parse(db.metaGet(INDEX_FINGERPRINTS_META_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Partial<SourceFingerprintV2>;
      return Number.isFinite(item.mtimeMs) && Number.isFinite(item.size) && typeof item.sha256 === 'string'
        ? [[key, { mtimeMs: Number(item.mtimeMs), size: Number(item.size), sha256: item.sha256 }]]
        : [];
    }));
  } catch {
    return {};
  }
}

/**
 * 指纹比对驱动的增量重索引：mtime/size 未变时零读取，时间戳变化但内容哈希未变时
 * 只更新指纹，内容真正变化才整文件替换（同事务删旧插新）。同步函数（fs+sqlite 均同步）。
 */
export function syncMemoryIndex(
  db: MemoryDb,
  workspaceRoot: string,
  opts: IndexSyncOptions = {}
): IndexSyncSummary {
  const t0 = Date.now();
  const sources = listMemoryIndexSources(workspaceRoot, { userMdPath: opts.userMdPath });
  const prev = readFingerprints(db);
  const next: Record<string, SourceFingerprintV2> = {};
  const changed: string[] = [];
  const removed: string[] = [];

  for (const src of sources) {
    const stamp = sourceStamp(src.absPath);
    if (stamp == null) {
      if (prev[src.sourcePath] !== undefined) {
        deleteChunksBySource(db, src.sourceType, src.sourcePath);
        removed.push(src.sourcePath);
      }
      continue;
    }
    const previous = prev[src.sourcePath];
    if (previous && previous.mtimeMs === stamp.mtimeMs && previous.size === stamp.size) {
      // mtime/size 未变时不读正文，保留内容哈希作为完整身份。
      next[src.sourcePath] = previous;
      continue;
    }
    let md = '';
    try {
      md = fs.readFileSync(src.absPath, 'utf8');
    } catch {
      continue; // 读失败保留旧索引且**不记录新指纹**（否则新指纹被钉死、该文件的当前版本永不重索引），下次同步按旧指纹比对自然重试
    }
    const sha256 = sourceContentHash(md);
    next[src.sourcePath] = { ...stamp, sha256 };
    if (previous?.sha256 === sha256) {
      // 文件被重写或时间戳变化但内容没有变化，更新指纹后跳过整文件重建。
      continue;
    }
    // 整文件替换：删旧插新并按 (lineStart,lineEnd,text) 迁 recall_stats/召回计数到新 id
    //（纯 delete+insert 会把信号门计数清零、堆孤儿账——replaceChunksForSource 同事务迁）
    const drafts = chunkMemorySource(md, src.family, src.fileDay, path.basename(src.absPath))
      .map((draft) => {
        const text = draft.text.trim();
        if (!text) return null;
        return {
          lineStart: draft.lineStart,
          lineEnd: draft.lineEnd,
          text,
          // origin 注解（B7）：有注解读注解（宿主写入路径落的真实来源）；无注解维持
          // 现状（memory 面兜 system / user_md 面 user）——注解仅展示审计，不参与信任判定
          origin: draft.origin ?? (src.family === 'user_md' ? ('user' as const) : ('system' as const)),
          observedAt: draft.observedAt,
          importance: draft.importance,
          triggers: draft.triggers,
          repoKey: draft.repoKey
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
    replaceChunksForSource(db, src.sourceType, src.sourcePath, drafts);
    changed.push(src.sourcePath);
  }
  // 库里有、当前源集合之外的残留（journal 超 cap 滚出等）
  const liveKeys = new Set(sources.map((s) => s.sourcePath));
  for (const { sourceType, sourcePath } of listIndexedSourcePaths(db)) {
    if (liveKeys.has(sourcePath) || next[sourcePath] !== undefined) continue;
    deleteChunksBySource(db, sourceType as ChunkSourceType, sourcePath);
    removed.push(sourcePath);
  }
  db.metaSet(INDEX_FINGERPRINTS_META_KEY, JSON.stringify(next));
  const totalChunks = Number(
    (db.handle.prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n
  );
  return { changed, removed, totalChunks, durationMs: Date.now() - t0 };
}

export async function ensureMemoryIndex(
  db: MemoryDb,
  workspaceRoot: string,
  opts: IndexSyncOptions = {}
): Promise<IndexSyncSummary> {
  return syncMemoryIndex(db,workspaceRoot,opts);
}

// ---------------------------------------------------------------------------
// fs.watch 防抖（watcher 失效自动退化懒同步：onError 后关闭，检索侧指纹检查兜底）
// ---------------------------------------------------------------------------

export interface MemoryWatcherHandle {
  close(): void;
}

export interface WatchOptions {
  debounceMs?: number;
  /** 防抖窗口内事件合并后回调（建议：触发一次 ensureIndex） */
  onInvalidate: (touchedDirs: ReadonlyArray<string>) => void;
  /** watcher 异常（目录删除/权限等）——调用方记录后自动退化懒同步 */
  onError?: (err: unknown) => void;
}

/** 记忆源所在目录（工作区相对）：memory 文件、scheduler 私有记忆、journal、features 文档 */
export const MEMORY_WATCH_DIR_RELS = [
  path.join('docs', 'memory'),
  JOURNAL_DIR_REL,
  path.join('docs', 'features'),
  path.join('.muster', 'scheduler')
] as const;

/**
 * 防抖 watch 现存目录（不存在的目录跳过——创建后下次 ensureIndex 指纹检查自然吸收）。
 * 任一 watcher 报错：整体关闭 + onError 上报（OpenClaw 教训：不静默假装还在 watch），
 * 检索/同步路径的指纹检查天然兜底（懒同步）。recursive 不支持的平台退化为非递归。
 */
export function watchMemorySources(
  workspaceRoot: string,
  opts: WatchOptions
): MemoryWatcherHandle | null {
  const debounceMs = opts.debounceMs ?? 500;
  const watchers: fs.FSWatcher[] = [];
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const touched = new Set<string>();
  const flush = (): void => {
    timer = null;
    if (closed || touched.size === 0) return;
    const dirs = [...touched];
    touched.clear();
    try {
      opts.onInvalidate(dirs);
    } catch {
      /* 回调异常不影响 watcher 继续工作 */
    }
  };
  const arm = (dir: string): void => {
    touched.add(dir);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };
  const fail = (err: unknown): void => {
    if (closed) return;
    closeAll();
    opts.onError?.(err);
  };
  const closeAll = (): void => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* 关闭竞态忽略 */
      }
    }
    watchers.length = 0;
  };
  const armDir = (absDir: string, relDir: string): void => {
    const attach = (recursive: boolean): fs.FSWatcher =>
      fs.watch(absDir, { recursive, persistent: false }, () => arm(relDir));
    let w: fs.FSWatcher;
    try {
      w = attach(true);
    } catch {
      try {
        w = attach(false); // Linux 等不支持递归 watch：退化为目录单层（journal 目录本就扁平）
      } catch (err) {
        fail(err);
        return;
      }
    }
    w.on('error', fail);
    watchers.push(w);
  };
  let armedAny = false;
  for (const relDir of MEMORY_WATCH_DIR_RELS) {
    const absDir = path.join(workspaceRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    armDir(absDir, relDir);
    if (closed) return null; // armDir 内失败已 fail 并上报
    armedAny = true;
  }
  if (!armedAny) return null;
  return { close: closeAll };
}
