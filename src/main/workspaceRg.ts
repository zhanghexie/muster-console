import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FsListPathsOptions, FsSearchHit, FsSearchTextOptions } from '../shared/types';
import { t } from '../shared/i18n';
import { SKIP_DIR_NAMES } from './workspaceSkipDirs';

const DEFAULT_MAX_PATHS = 8000;
const DEFAULT_MAX_HITS = 200;
/** 单文件最多计入多少条命中，避免某文件刷屏 */
const MAX_COUNT_PER_FILE = 20;
const MAX_STDERR_CHARS = 64 * 1024;
/** 尚未凑成一行的缓冲上限，防止无换行的巨块撑爆内存 */
const MAX_PENDING_CHARS = 1024 * 1024;
const SEARCH_TIMEOUT_MS = 25_000;
const LIST_TIMEOUT_MS = 45_000;

/** @vscode/ripgrep 入口是纯 ESM，主进程 CJS bundle 不能 require；直接 resolve 平台包里的 rg */
const nodeRequire = createRequire(fileURLToPath(import.meta.url));

function resolveRgPath(): string {
  const arch = process.env.npm_config_arch || process.arch;
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
  let resolved: string;
  try {
    resolved = nodeRequire.resolve(`${platformPkg}/bin/${binaryName}`);
  } catch {
    throw new Error(
      t('找不到 {{pkg}}。请确认已安装可选依赖（当前平台 {{platform}}）。', {
        pkg: platformPkg,
        platform: `${process.platform}-${arch}`
      })
    );
  }
  return resolved.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked');
}

function skipGlobs(): string[] {
  const globs: string[] = [];
  for (const name of SKIP_DIR_NAMES) {
    globs.push('-g', `!${name}`);
    globs.push('-g', `!**/${name}/**`);
  }
  return globs;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function killRg(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      /* ignore */
    }
  }
}

type LineHandler = (line: string) => 'continue' | 'stop';

export interface RgQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 相对枚举根的目录；对应另一个显式查询根。 */
  excludeDirs?: string[];
  includeHidden?: boolean;
  includeIgnored?: boolean;
}
export interface RgResult<T> { items: T[]; truncated: boolean; timedOut: boolean; cancelled: boolean }

function queryGlobs(opts: RgQueryOptions): string[] {
  const args = opts.includeHidden ? ['--hidden'] : [];
  if (opts.includeIgnored) args.push('--no-ignore');
  for (const dir of opts.excludeDirs ?? []) {
    const literal = dir.replace(/[\\*?\[\]{}!]/g, '\\$&');
    args.push('-g', `!/${literal}`, '-g', `!/${literal}/**`);
  }
  return args;
}

/**
 * 流式读 rg stdout，按行回调；凑够即可 stop 并杀掉进程。
 * 禁止把整段 stdout 拼成超大字符串（会 RangeError: Invalid string length）。
 */
function runRgLines(
  args: string[],
  cwd: string,
  onLine: LineHandler,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<{ code: number | null; stderr: string; stoppedEarly: boolean; timedOut: boolean; cancelled: boolean }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { resolve({ code: null, stderr: '', stoppedEarly: false, timedOut: false, cancelled: true }); return; }
    let child: ChildProcess;
    try {
      child = spawn(resolveRgPath(), args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = '';
    let pending = '';
    let stoppedEarly = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (pending && !stoppedEarly && !cancelled && !timedOut) {
        try {
          if (onLine(pending) === 'stop') stoppedEarly = true;
        } catch (err) {
          reject(err);
          return;
        }
        pending = '';
      }
      resolve({ code, stderr, stoppedEarly, timedOut, cancelled });
    };

    const stop = (reason: 'early' | 'timeout' | 'overflow'): void => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'early' || reason === 'overflow') stoppedEarly = true;
      killRg(child);
    };

    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const abort = (): void => { cancelled = true; killRg(child); };
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      if (settled || stoppedEarly || timedOut || cancelled) return;
      try {
        pending += chunk;
        if (pending.length > MAX_PENDING_CHARS) {
          stop('overflow');
          return;
        }
        for (;;) {
          const nl = pending.indexOf('\n');
          if (nl < 0) break;
          let line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) continue;
          if (onLine(line) === 'stop') {
            stop('early');
            return;
          }
        }
      } catch (err) {
        killRg(child);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', abort);
          reject(err);
        }
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= MAX_STDERR_CHARS) return;
      stderr += chunk;
      if (stderr.length > MAX_STDERR_CHARS) {
        stderr = `${stderr.slice(0, MAX_STDERR_CHARS)}\n…(stderr truncated)`;
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      reject(err);
    });

    child.on('close', (code) => settle(code));
  });
}

/**
 * 用 rg --files 枚举工作区相对路径。
 */
export async function listPaths(
  root: string,
  opts: FsListPathsOptions = {}
): Promise<string[]> {
  const result = await listPathsDetailed(root, opts);
  if (result.timedOut && !result.items.length) throw new Error(t('rg --files 超时'));
  return result.items;
}

export async function listPathsDetailed(
  root: string,
  opts: FsListPathsOptions & RgQueryOptions = {}
): Promise<RgResult<string>> {
  const absRoot = path.resolve(root);
  const max = Math.max(1, opts.max ?? DEFAULT_MAX_PATHS);
  const args = ['--files', '--color', 'never', ...skipGlobs(), ...queryGlobs(opts)];
  const paths: string[] = [];

  const { code, stderr, stoppedEarly, timedOut, cancelled } = await runRgLines(
    args,
    absRoot,
    (line) => {
      paths.push(toPosix(line));
      return paths.length >= max ? 'stop' : 'continue';
    },
    { timeoutMs: opts.timeoutMs ?? LIST_TIMEOUT_MS, signal: opts.signal }
  );

  if (!stoppedEarly && !timedOut && !cancelled && code !== 0 && code !== 1) {
    throw new Error(stderr.trim() || `rg --files exited ${code}`);
  }
  return { items: paths, truncated: stoppedEarly, timedOut, cancelled };
}

/**
 * 字面量内容搜索（流式；满额即停，避免大仓把 stdout 拼爆）。
 */
export async function searchText(
  root: string,
  opts: FsSearchTextOptions
): Promise<FsSearchHit[]> {
  const result = await searchTextDetailed(root, opts);
  if (result.timedOut && !result.items.length) throw new Error(t('搜索超时（工作区过大或关键词过泛）'));
  return result.items;
}

export async function searchTextDetailed(
  root: string,
  opts: FsSearchTextOptions & RgQueryOptions
): Promise<RgResult<FsSearchHit>> {
  const query = String(opts.query ?? '').trim();
  if (!query) return { items: [], truncated: false, timedOut: false, cancelled: !!opts.signal?.aborted };
  const absRoot = path.resolve(root);
  const maxResults = Math.max(1, opts.maxResults ?? DEFAULT_MAX_HITS);
  const args = [
    '--json',
    '--fixed-strings',
    '--color',
    'never',
    '--max-filesize',
    '2M',
    '--max-count',
    String(MAX_COUNT_PER_FILE),
    ...skipGlobs(),
    ...queryGlobs(opts)
  ];
  if (!opts.caseSensitive) args.push('-i');
  args.push('--', query, '.');

  const hits: FsSearchHit[] = [];

  const { code, stderr, stoppedEarly, timedOut, cancelled } = await runRgLines(
    args,
    absRoot,
    (line) => {
      let msg: { type?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
      } catch {
        return 'continue';
      }
      if (msg.type !== 'match' || !msg.data) return 'continue';
      const data = msg.data;
      const pathText =
        typeof data.path === 'object' && data.path && 'text' in (data.path as object)
          ? String((data.path as { text: string }).text)
          : '';
      const lineNumber = typeof data.line_number === 'number' ? data.line_number : 0;
      const linesObj = data.lines as { text?: string } | undefined;
      const preview = String(linesObj?.text ?? '').replace(/\r?\n$/, '');
      if (!pathText || lineNumber < 1) return 'continue';
      hits.push({
        path: toPosix(pathText),
        line: lineNumber,
        preview
      });
      return hits.length >= maxResults ? 'stop' : 'continue';
    },
    { timeoutMs: opts.timeoutMs ?? SEARCH_TIMEOUT_MS, signal: opts.signal }
  );

  if (!stoppedEarly && !timedOut && !cancelled && code !== 0 && code !== 1) {
    throw new Error(stderr.trim() || `rg search exited ${code}`);
  }
  return { items: hits, truncated: stoppedEarly, timedOut, cancelled };
}
