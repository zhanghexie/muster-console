/**
 * 崩溃现场证据的纯逻辑层：exitCode 语义翻译、渲染层 console 环形缓冲、
 * 死因日志条目拼装。渲染进程死亡（主窗口）与子进程死亡（GPU/utility）共用。
 *
 * 背景（2026-10-10 补强）：10-06 那次真实崩溃只留下一行 reason/exitCode，
 * 而 exitCode 143 是 SIGTERM 语义的外部终止（不走 crashpad、无 minidump），
 * 一行日志既定位不了死因也不知道崩溃时渲染层在干什么。本文件把「出事那一刻」
 * 的现场快照（URL / 主进程内存 / 最近渲染层 console）钉进死因日志。
 */

/** 死因日志里携带的渲染层 console 条数上限 */
export const CRASH_CONSOLE_DUMP_MAX = 20;
/** 环形缓冲单条长度上限（超长截断，防止单条巨日志撑爆死因条目） */
export const CRASH_CONSOLE_LINE_MAX = 500;

const EXIT_CODE_TAGS: ReadonlyMap<number, string> = new Map([
  [143, 'sigterm-like external kill'],
  [134, 'sigabrt-like CHECK/abort'],
  [0xc0000005, 'access-violation'],
  [0xc0000409, 'fail-fast OOM/CHECK'],
  [0xc00000fd, 'stack-overflow']
]);

/**
 * exitCode → 人话注解。Windows 的 NTSTATUS 有无符号大数（3221225477）与
 * 有符号负数（-1073741819）两种形态，都要能对上；未收录的 NTSTATUS 给 hex。
 */
export function describeExitCode(code: number): string {
  const unsigned = code < 0 ? code + 0x1_0000_0000 : code;
  const tag = EXIT_CODE_TAGS.get(code) ?? EXIT_CODE_TAGS.get(unsigned);
  if (tag) return `${code} [${tag}]`;
  if (unsigned >= 0xc0000000) return `${code} [ntstatus 0x${unsigned.toString(16).toUpperCase()}]`;
  return String(code);
}

/** 渲染层 console 环形缓冲：容量淘汰 + 单条截断 + 空白折叠成单行 */
export class CrashConsoleRing {
  private lines: string[] = [];

  constructor(
    private readonly capacity: number = 60,
    private readonly lineMax: number = CRASH_CONSOLE_LINE_MAX
  ) {}

  push(line: string): void {
    const text = line.replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.lines.push(text.length > this.lineMax ? `${text.slice(0, this.lineMax)}…` : text);
    if (this.lines.length > this.capacity) this.lines.shift();
  }

  latest(n: number): string[] {
    return this.lines.slice(-Math.max(0, n));
  }
}

export interface RenderGoneEntryInput {
  reason: string;
  exitCode: number;
  /** 限频决策说明（decideRenderGoneReload 的 note） */
  decisionNote: string;
  url: string;
  /** 主进程 RSS 字节数（缺省时省略该字段） */
  mainRssBytes?: number;
  /** 渲染层最近的 console 行（已带级别前缀，如 console[e] …） */
  consoleLines?: readonly string[];
}

/**
 * 拼装 render-process-gone 死因条目（多行）。首行保持
 * `[renderer gone] reason=… exitCode=… -> …` 的可 grep 契约不变。
 */
export function buildRenderGoneEntry(input: RenderGoneEntryInput): string {
  const head = `[renderer gone] reason=${input.reason} exitCode=${describeExitCode(input.exitCode)} -> ${input.decisionNote}`;
  const rss =
    input.mainRssBytes === undefined ? '' : ` mainRss=${Math.round(input.mainRssBytes / 1048576)}MB`;
  const lines = [head, `  ctx url=${input.url || '(unknown)'}${rss}`];
  for (const line of (input.consoleLines ?? []).slice(-CRASH_CONSOLE_DUMP_MAX)) {
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

export interface ChildGoneDetails {
  type: string;
  reason: string;
  exitCode: number;
  /** 进程名（utility 的 serviceName / Pepper 插件的 name），缺省不带 name= 字段 */
  name?: string;
}

/** 子进程（GPU/utility 等）死亡的单行日志；渲染进程由各宿主自行落盘避免重复 */
export function formatChildGoneLine(d: ChildGoneDetails): string {
  const name = d.name ? ` name=${d.name}` : '';
  return `[child gone] type=${d.type}${name} reason=${d.reason} exitCode=${describeExitCode(d.exitCode)}`;
}
