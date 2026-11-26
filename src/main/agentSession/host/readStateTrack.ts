/**
 * read-state 过期提示宿主接线（A1 / T2）：GUI Worker 工具结果路径上的
 * Read 登记 / Write·Edit·bash 疑似写标脏 / 下一轮 startTurn 前缀注入。
 * 状态挂在 SessionEntry 引用上（WeakMap，会话关闭随 GC 回收）；
 * 文件指纹走 fs.stat（不落内容）。注入点见 injection-registry
 * worker.turn-prefix.read-state-stale。
 *
 * 登记键一律用 resolve 后的绝对路径（同一文件相对/绝对/`./` 混用命中同一键）；
 * 显示也用绝对路径（避免歧义）。
 * 已知边界：ACP 的 toolName 优先取人话 title（展示层约定），title 在场时
 * 分类退化为 other、不登记——kind 命中或 title 缺席的路径不受影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyReadStateTool,
  createReadStateTracker,
  extractReadStatePaths,
  extractShellCommand,
  isPartialReadInput,
  isSuspectedWriteCommand,
  type FreshStat,
  type ReadStateTracker
} from '../../../shared/readState';

/** tool-start 到 tool-result 之间的入参暂存（按 toolCallId 对齐） */
interface PendingTool {
  kind: 'read' | 'write' | 'shell';
  /** read/write 的文件路径（原样；write 可多条——codex changes[]） */
  paths: string[];
  /** shell 的命令文本 */
  command?: string;
  /** read 是否部分读 */
  isPartial: boolean;
}

interface TrackBag {
  tracker: ReadStateTracker;
  pending: Map<string, PendingTool>;
}

/** 会话级状态（key = SessionEntry 对象引用；关闭后随 GC 回收） */
const bags = new WeakMap<object, TrackBag>();

function bagOf(entry: object): TrackBag {
  let bag = bags.get(entry);
  if (!bag) {
    bag = { tracker: createReadStateTracker(), pending: new Map() };
    bags.set(entry, bag);
  }
  return bag;
}

/** 文件指纹 + 绝对路径（stat 失败返回 null——文件被删/无权限，跳过本轮判定） */
function statOf(filePath: string, cwd: string): ({ abs: string } & FreshStat) | null {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const st = fs.statSync(abs);
    return { abs, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * tool-start：分类暂存入参。只认 read/write/shell 三类原生工具，
 * 其余（MCP/宿主工具）不进 read-state。
 */
export function noteReadStateToolStart(
  entry: object,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
): void {
  const kind = classifyReadStateTool(toolName);
  if (kind === 'other') return;
  const bag = bagOf(entry);
  if (kind === 'read') {
    const p = extractReadStatePaths(input);
    if (!p.length) return;
    bag.pending.set(toolCallId, { kind, paths: p, isPartial: isPartialReadInput(input) });
    return;
  }
  if (kind === 'write') {
    const paths = extractReadStatePaths(input);
    if (!paths.length) return;
    bag.pending.set(toolCallId, { kind, paths, isPartial: false });
    return;
  }
  const command = extractShellCommand(input);
  if (!command) return;
  bag.pending.set(toolCallId, { kind, command, paths: [], isPartial: false });
}

/**
 * tool-result 成功后的登记/标脏：
 * - read → stat 后登记（partial 标记随入参；键=resolve 后绝对路径）；
 * - write → stat 后对命中已读路径标脏（多路径逐条：codex changes[]）；
 * - shell 且疑似写 → 用新鲜指纹回扫全部已读路径。
 * 失败结果只清暂存，不动状态。
 */
export function noteReadStateToolResult(
  entry: object,
  toolCallId: string,
  ok: boolean,
  cwd: string
): void {
  const bag = bags.get(entry);
  if (!bag) return;
  const pending = bag.pending.get(toolCallId);
  bag.pending.delete(toolCallId);
  if (!pending || !ok) return;

  if (pending.kind === 'read') {
    for (const p of pending.paths) {
      const stat = statOf(p, cwd);
      if (stat) bag.tracker.noteRead(stat.abs, stat, pending.isPartial);
    }
    return;
  }
  if (pending.kind === 'write') {
    for (const p of pending.paths) {
      const stat = statOf(p, cwd);
      if (stat) bag.tracker.noteWrite(stat.abs, stat);
    }
    return;
  }
  // shell：疑似写才回扫（unknown 不标脏，避免误报）
  if (!pending.command || !isSuspectedWriteCommand(pending.command)) return;
  const stats = collectFreshStats(bag.tracker, cwd);
  if (stats.length) bag.tracker.noteBashSweep(stats);
}

/** 已读路径 → 新鲜指纹（stat 失败的路径跳过） */
function collectFreshStats(tracker: ReadStateTracker, cwd: string): Array<{ path: string } & FreshStat> {
  const out: Array<{ path: string } & FreshStat> = [];
  for (const p of tracker.readPaths()) {
    const stat = statOf(p, cwd);
    if (stat) out.push({ path: stat.abs, ...stat });
  }
  return out;
}

/**
 * 取走合并提示（同回合多文件一条；无 pending 返回 ''）。
 * startTurn 前缀注入用；取走即清，不重复提示。
 */
export function takeReadStateHint(entry: object): string {
  const bag = bags.get(entry);
  return bag ? bag.tracker.takeHint() : '';
}

/** 当前 pending 命中（测试/诊断用） */
export function readStatePending(entry: object): number {
  const bag = bags.get(entry);
  return bag ? bag.tracker.pendingHits().length : 0;
}

/** 已登记路径数（测试/诊断用） */
export function readStateSize(entry: object): number {
  const bag = bags.get(entry);
  return bag ? bag.tracker.size() : 0;
}
