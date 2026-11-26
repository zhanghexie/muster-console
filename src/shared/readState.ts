/**
 * read-state 过期提示纯函数层（zcode-adopt-batch-a A1 / S2.1）。
 * 会话级只读状态表 ReadFileState[]：Read 成功登记，写类/bash 疑似写后标脏，
 * 生成 `【read-state】` 重读提示（同回合多文件合并为一条）。禁止持久化文件全文，
 * 只用 hash/mtime/size。零依赖（test/*.mjs 即时转译导入）。
 */
import { isReadOnlyShellCommand, splitTopLevelSegments } from './guiWorkerPolicy';
import { pathKey } from './pathKey';

/** 一次成功读入的文件快照（不存内容，只存指纹） */
export interface ReadFileState {
  path: string;
  mtimeMs: number;
  size: number;
  /** 读入内容的哈希（可选；无则失效判定退化为 mtime+size） */
  contentHash?: string;
  /** 部分读（offset/limit、截断）为 true */
  isPartialView: boolean;
}

/** 写后判定为过期的一条命中 */
export interface StaleHit {
  path: string;
  /** 登记时的 mtime（提示文案展示） */
  readMtimeMs: number;
  isPartialView: boolean;
  isPriority: boolean;
}

/** 写后对照用的新鲜指纹（stat/重读结果） */
export interface FreshStat {
  mtimeMs: number;
  size: number;
  contentHash?: string;
}

export type ReadStateTable = Map<string, ReadFileState>;

/** 提示前缀（注入文案与测试断言共用） */
export const READ_STATE_HINT_TAG = '【read-state】';

/** 契约/协议类文件名（大小写不敏感） */
const PRIORITY_BASENAMES = new Set(['agents.md', 'claude.md', 'host.md', 'host-ext.md']);

/**
 * 纯路径优先集：docs/**、契约文件（AGENTS.md/CLAUDE.md/HOST.md/HOST-EXT.md，
 * 含 .muster/ 下同名）、.agents/skills/**。其它路径同样登记，仅排序/展示优先。
 */
export function isPriorityReadPath(p: string): boolean {
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
  const lower = n.toLowerCase();
  if (lower === 'docs' || lower.startsWith('docs/') || lower.includes('/docs/')) return true;
  if (lower === '.agents/skills' || lower.startsWith('.agents/skills/') || lower.includes('/.agents/skills/')) {
    return true;
  }
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  return PRIORITY_BASENAMES.has(base);
}

/** 路径归一登记键（Windows 大小写不敏感；与 pathKey 同源） */
function tableKeyOf(p: string): string {
  return pathKey(p.trim());
}

/** Read 成功登记（同路径重读覆盖旧快照） */
export function registerReadState(table: ReadStateTable, state: ReadFileState): void {
  const path = state.path.trim();
  if (!path) return;
  table.set(tableKeyOf(path), {
    path,
    mtimeMs: state.mtimeMs,
    size: state.size,
    ...(state.contentHash !== undefined ? { contentHash: state.contentHash } : {}),
    isPartialView: state.isPartialView === true
  });
}

/**
 * 标脏判定：mtime+size 未变 → 不提示；双方都有 contentHash 且未变 → 不提示
 * （partial 视图下 hash 只盖已读片段，同样以「hash 未变」为准；无 hash 用 mtime+size）。
 */
export function isReadStale(prev: ReadFileState, curr: FreshStat): boolean {
  if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return false;
  if (
    prev.contentHash !== undefined &&
    curr.contentHash !== undefined &&
    prev.contentHash === curr.contentHash
  ) {
    return false;
  }
  return true;
}

function toHit(state: ReadFileState): StaleHit {
  return {
    path: state.path,
    readMtimeMs: state.mtimeMs,
    isPartialView: state.isPartialView === true,
    isPriority: isPriorityReadPath(state.path)
  };
}

/** 写类工具（Write/Edit）落盘后：命中已读路径且指纹变化才返回 hit */
export function checkWriteStale(
  table: ReadonlyMap<string, ReadFileState>,
  writtenPath: string,
  after: FreshStat
): StaleHit | null {
  const prev = table.get(tableKeyOf(writtenPath));
  if (!prev) return null;
  if (!isReadStale(prev, after)) return null;
  return toHit(prev);
}

/**
 * bash 疑似写成功后：对全部已读路径用新鲜指纹回扫，返回变化者。
 * currentStats 未覆盖的路径跳过（删除/无权限由调用方决定是否另行标脏）。
 */
export function checkBashStale(
  table: ReadonlyMap<string, ReadFileState>,
  currentStats: Iterable<{ path: string } & FreshStat>
): StaleHit[] {
  const hits: StaleHit[] = [];
  const seen = new Set<string>();
  for (const cur of currentStats) {
    const key = tableKeyOf(cur.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = table.get(key);
    if (!prev) continue;
    if (!isReadStale(prev, cur)) continue;
    hits.push(toHit(prev));
  }
  return hits;
}

/** mtime 展示（本地 YYYY-MM-DD HH:mm） */
export function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 合并提示文案：同回合多文件一条列表（优先路径在前）；空命中返回 ''。
 * 文案口径对齐 S2.1：「你曾读过 … 此后工作区已改动 … 请重读后再依据其内容决策」。
 * 命中数超 READ_STATE_HINT_MAX 时只列前 N 个 + 总数（防大范围改动时提示文本无界进模型上下文）。
 */
export const READ_STATE_HINT_MAX = 10;

export function composeStaleHint(hits: readonly StaleHit[]): string {
  if (!hits.length) return '';
  const sorted = [...hits].sort((a, b) => {
    if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  const overflow = sorted.length - READ_STATE_HINT_MAX;
  const shown = overflow > 0 ? sorted.slice(0, READ_STATE_HINT_MAX) : sorted;
  if (sorted.length === 1) {
    const h = sorted[0]!;
    return `${READ_STATE_HINT_TAG}你曾读过 ${h.path}（mtime ${formatMtime(h.readMtimeMs)}），此后工作区已改动该文件，请重读后再依据其内容决策。`;
  }
  const lines = shown.map((h) => `- ${h.path}（mtime ${formatMtime(h.readMtimeMs)}）`);
  return [
    `${READ_STATE_HINT_TAG}你曾读过下列 ${sorted.length} 个文件，此后工作区已改动它们，请重读后再依据其内容决策。`,
    ...lines,
    ...(overflow > 0 ? [`- ……等共 ${sorted.length} 个（仅列前 ${READ_STATE_HINT_MAX} 个）`] : [])
  ].join('\n');
}

/** read-state 工具归类（跨引擎大小写/下划线名） */
export type ReadStateToolKind = 'read' | 'write' | 'shell' | 'other';

export function classifyReadStateTool(toolName: string): ReadStateToolKind {
  const n = toolName.trim().toLowerCase().replace(/[\s_]/g, '');
  if (n === 'read' || n === 'readimage') return 'read';
  if (
    n === 'write' ||
    n === 'edit' ||
    n === 'multiedit' ||
    n === 'notebookedit' ||
    n === 'delete' ||
    n === 'filechange'
  ) {
    return 'write';
  }
  if (n === 'bash' || n === 'shell' || n === 'execute' || n === 'commandexecution' || n === 'pwsh') {
    return 'shell';
  }
  return 'other';
}

/**
 * 写重定向（> / >> 指向非 /dev/null，排除 N>&M fd 复制）。
 * 切段器遇到写目标会 fail-closed 返回 []，与引号未闭合等真 unknown 同形——
 * 用本检测把「明确写文件」从 unknown 里拆出来，避免误报与漏报两端。
 */
function hasWriteRedirect(cmd: string): boolean {
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      i = end === -1 ? cmd.length : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length) {
        if (cmd[j] === '\\') {
          j += 2;
          continue;
        }
        if (cmd[j] === '"') break;
        j++;
      }
      i = j >= cmd.length ? cmd.length : j + 1;
      continue;
    }
    if (ch === '>') {
      let j = i + 1;
      if (cmd[j] === '>') j++;
      if (cmd[j] === '&' && /\d/.test(cmd[j + 1] ?? '')) {
        i = j + 1;
        while (i < cmd.length && /\d/.test(cmd[i])) i++;
        continue;
      }
      while (j < cmd.length && cmd[j] === ' ') j++;
      let k = j;
      if (k < cmd.length && (cmd[k] === "'" || cmd[k] === '"')) {
        const q = cmd[k];
        const end = cmd.indexOf(q, k + 1);
        if (end === -1) return true;
        const text = cmd.slice(k + 1, end).toLowerCase();
        if (text !== '/dev/null') return true;
        i = end + 1;
        continue;
      }
      while (k < cmd.length && !/\s/.test(cmd[k]) && !'&;|<>'.includes(cmd[k])) k++;
      const text = cmd.slice(j, k).toLowerCase();
      if (text && text !== '/dev/null') return true;
      i = k;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * bash 疑似写（只读分类器反向，三态收成布尔）：
 * - 明确写（写重定向到非 /dev/null，或切段成功且非只读）→ true；
 * - 空命令 / 无法切段又无写重定向（引号未闭合等 unknown）→ false，避免误报；
 * - 只读白名单命令 → false。
 */
export function isSuspectedWriteCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (hasWriteRedirect(cmd)) return true;
  const segments = splitTopLevelSegments(cmd);
  if (!segments.length) return false;
  return !isReadOnlyShellCommand(cmd);
}

/** Read 入参是否部分读（offset/limit 存在即视为 partial） */
export function isPartialReadInput(input: Record<string, unknown>): boolean {
  return input.offset !== undefined || input.limit !== undefined;
}

/** 工具入参里取文件路径（跨引擎 path / file_path / filePath / target_file / file） */
export function extractReadStatePath(input: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file'] as const) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 工具入参里取全部涉及路径（写类工具的多路径形态）：
 * 单路径键优先；codex file_change 的 `changes: [{ path, ... }]` 数组逐条提取。
 */
export function extractReadStatePaths(input: Record<string, unknown>): string[] {
  const single = extractReadStatePath(input);
  if (single) return [single];
  const changes = input.changes ?? input.files ?? input.edits;
  if (!Array.isArray(changes)) return [];
  const out: string[] = [];
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file'] as const) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) {
        out.push(v.trim());
        break;
      }
    }
  }
  return out;
}

/** bash/shell 入参里的命令文本 */
export function extractShellCommand(input: Record<string, unknown>): string {
  const v = input.command ?? input.shellCommand ?? input.cmd;
  return typeof v === 'string' ? v : '';
}

/**
 * 会话级 read-state 跟踪器：登记/标脏/pending 合并提示。
 * stat 由调用方注入（宿主 fs.stat / 测试桩），本体零 IO。
 */
export interface ReadStateTracker {
  /** Read 成功：登记（同路径覆盖） */
  noteRead(path: string, stat: FreshStat, isPartialView: boolean): void;
  /** 写类工具成功：命中已读路径且指纹变化 → 记入 pending，返回 hit（未命中 null） */
  noteWrite(path: string, stat: FreshStat): StaleHit | null;
  /** bash 疑似写成功：用新鲜指纹回扫全部已读路径，变化者记入 pending */
  noteBashSweep(currentStats: Array<{ path: string } & FreshStat>): StaleHit[];
  /** 取走合并提示并清空 pending（同回合多文件一条）；无 pending 返回 '' */
  takeHint(): string;
  /** 当前 pending（只读快照，测试用） */
  pendingHits(): readonly StaleHit[];
  /** 已登记条目数 */
  size(): number;
  /** 已登记路径列表（bash 回扫时由宿主逐个 stat） */
  readPaths(): string[];
}

export function createReadStateTracker(): ReadStateTracker {
  const table: ReadStateTable = new Map();
  let pending: StaleHit[] = [];
  return {
    noteRead(path, stat, isPartialView) {
      registerReadState(table, {
        path,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ...(stat.contentHash !== undefined ? { contentHash: stat.contentHash } : {}),
        isPartialView
      });
    },
    noteWrite(path, stat) {
      const hit = checkWriteStale(table, path, stat);
      if (hit) pending.push(hit);
      return hit;
    },
    noteBashSweep(currentStats) {
      const hits = checkBashStale(table, currentStats);
      pending.push(...hits);
      return hits;
    },
    takeHint() {
      if (!pending.length) return '';
      const hint = composeStaleHint(pending);
      pending = [];
      return hint;
    },
    pendingHits() {
      return pending;
    },
    size() {
      return table.size;
    },
    readPaths() {
      return [...table.values()].map((e) => e.path);
    }
  };
}
