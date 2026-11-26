/**
 * R-14 一期·交验前置门 runner：对「本次交付改了哪些文件」收集改动并跑机械门。
 * 改动文件口径：隔离树 = 脏文件 ∪ 分支领先提交的 changed files；共享检出 = 脏文件。
 * 新增/删除行取未提交 diff（git diff HEAD）+ 领先提交 diff（base...branch）+ 未跟踪全文。
 * 无 electron 依赖（对齐 git/pipelineFacts.ts 先例）；纯判定在 shared/dimensionGates.ts。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractLocaleKeys,
  extractTCallKeys,
  i18nGateHit,
  motionGateHit,
  parseDimensionGateConfig,
  runI18nGate,
  runMotionGate,
  splitUnifiedDiff,
  type DimensionGateResult,
  type DimensionGatesSnapshot,
  type I18nGateInput,
  type MotionGateInput
} from '../../shared/dimensionGates';
import { parsePorcelainPaths } from '../../shared/workerStatusGuard';
import { gitCommandEnvironment } from '../git/gitEnvironment';

const execFileAsync = promisify(execFile);

/** 单文件新增行文本上限（防超大 diff 撑爆内存/摘要） */
const ADDED_TEXT_CAP_FILES = 200;
const ADDED_LINE_CAP = 4000;
const SRC_WALK_FILE_CAP = 4000;
const READ_FILE_CAP_BYTES = 512 * 1024;

async function gitAllowFail(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitCommandEnvironment(),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024
    });
    return { ok: true, out: String(stdout ?? ''), err: '' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; stdout?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    return { ok: false, out: String(err.stdout ?? ''), err: stderr || String(err.message ?? e) };
  }
}

interface FileChangeLines {
  added: string[];
  removed: string[];
}

async function resolveBaseBranch(cwd: string, fallbackBase?: string): Promise<string> {
  const b = (fallbackBase ?? '').trim();
  if (b) return b;
  // 缺省回落：origin/HEAD → main → master（够用即可；baseBranch 常态由会话 meta 提供）
  const sym = await gitAllowFail(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const short = sym.out.trim().replace(/^origin\//, '');
  if (sym.ok && short) return short;
  return 'main';
}

function readCapped(abs: string): string {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(READ_FILE_CAP_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function walk(dir: string, extRe: RegExp, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= SRC_WALK_FILE_CAP) return out;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'out' || ent.name === 'dist' || ent.name === '.worktrees') {
        continue;
      }
      walk(p, extRe, out);
    } else if (extRe.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 会话交付的机械门快照；无维度命中返回 null（不写 meta） */
export async function collectDimensionGates(opts: {
  cwd: string;
  branch?: string;
  baseBranch?: string;
  now?: () => number;
}): Promise<DimensionGatesSnapshot | null> {
  const cwd = opts.cwd?.trim();
  if (!cwd || !fs.existsSync(cwd)) return null;
  const now = opts.now ?? Date.now;

  // ---- 改动文件 + 行收集 ----
  // -uall：未跟踪的新目录必须展开到文件——否则整目录折叠成 `?? src/`，两维度门对新目录交付完全失明
  const porcelain = await gitAllowFail(cwd, ['status', '--porcelain', '-uall']);
  const untracked = new Set(
    porcelain.ok
      ? porcelain.out
          .split(/\r?\n/)
          .filter((l) => l.startsWith('?? '))
          .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
      : []
  );
  const dirty = porcelain.ok ? parsePorcelainPaths(porcelain.out) : [];

  const branch = (opts.branch ?? '').trim();
  let aheadFiles: string[] = [];
  let base = '';
  if (branch) {
    base = await resolveBaseBranch(cwd, opts.baseBranch);
    const names = await gitAllowFail(cwd, ['diff', '--name-only', `${base}...${branch}`]);
    if (names.ok) {
      aheadFiles = names.out
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    }
  }

  const changed = [...new Set([...dirty, ...aheadFiles])].slice(0, ADDED_TEXT_CAP_FILES);
  if (!changed.length) return null;
  if (!i18nGateHit(changed) && !motionGateHit(changed)) return null;

  const byFile = new Map<string, FileChangeLines>();
  const mergeLines = (file: string, part: { added: string[]; removed: string[] }): void => {
    const cur = byFile.get(file) ?? { added: [], removed: [] };
    cur.added = [...cur.added, ...part.added].slice(0, ADDED_LINE_CAP);
    cur.removed = [...cur.removed, ...part.removed].slice(0, ADDED_LINE_CAP);
    byFile.set(file, cur);
  };
  for (const file of changed) {
    if (untracked.has(file)) {
      const text = readCapped(path.join(cwd, file));
      mergeLines(file, { added: text.split(/\r?\n/), removed: [] });
      continue;
    }
    const uncommitted = await gitAllowFail(cwd, ['diff', 'HEAD', '-U0', '--', file]);
    if (uncommitted.ok) mergeLines(file, splitUnifiedDiff(uncommitted.out));
    if (branch && base) {
      const ahead = await gitAllowFail(cwd, ['diff', `${base}...${branch}`, '-U0', '--', file]);
      if (ahead.ok) mergeLines(file, splitUnifiedDiff(ahead.out));
    }
  }

  // ---- i18n 门素材 ----
  let i18nInput: I18nGateInput | undefined;
  const addedByFile = [...byFile.entries()].map(([file, v]) => ({ file, lines: v.added }));
  const removedByFile = [...byFile.entries()]
    .filter(([file, v]) => v.removed.length && file.replace(/\\/g, '/').startsWith('src/shared/i18n/'))
    .map(([file, v]) => ({ file, lines: v.removed }));

  let usedKeys: string[] = [];
  if (i18nGateHit(changed)) {
    const localeDir = path.join(cwd, 'src', 'shared', 'i18n', 'locales');
    const localeFiles = walk(localeDir, /\.ts$/);
    if (localeFiles.length) {
      const localeKeys = extractLocaleKeys(localeFiles.map((f) => readCapped(f)));
      if (removedByFile.length) {
        const used = new Set<string>();
        for (const f of walk(cwd, /\.(ts|tsx|mjs)$/)) {
          for (const k of extractTCallKeys(readCapped(f))) used.add(k);
        }
        usedKeys = [...used];
      }
      i18nInput = {
        changedPaths: changed,
        addedByFile,
        removedByFile,
        usedKeys,
        localeKeys
      };
    }
  }

  // ---- motion 门素材 ----
  let motionInput: MotionGateInput | undefined;
  if (motionGateHit(changed)) {
    const baseCssPath = path.join(cwd, 'src', 'renderer', 'src', 'styles', 'base.css');
    const motionTsxPath = path.join(cwd, 'src', 'renderer', 'src', 'components', 'motion.tsx');
    const motionTsxChanged = changed.some(
      (p) => p.replace(/\\/g, '/') === 'src/renderer/src/components/motion.tsx'
    );
    const baseCss = fs.existsSync(baseCssPath) ? readCapped(baseCssPath) : undefined;
    const motionTsx = fs.existsSync(motionTsxPath) ? readCapped(motionTsxPath) : undefined;
    motionInput = {
      changedPaths: changed,
      addedByFile: addedByFile.filter((f) => f.file.replace(/\\/g, '/').endsWith('.css')),
      ...(baseCss !== undefined ? { baseCss } : {}),
      ...(motionTsx !== undefined ? { motionTsx } : {}),
      motionTsxChanged
    };
  }

  // ---- 工作区配置覆盖（骨架：禁用维度） ----
  let disabled: string[] = [];
  try {
    const cfgPath = path.join(cwd, '.muster', 'dimension-gates.json');
    if (fs.existsSync(cfgPath)) {
      disabled = parseDimensionGateConfig(JSON.parse(readCapped(cfgPath))).disabled;
    }
  } catch {
    /* 配置坏文件按无配置处理 */
  }

  const results: DimensionGateResult[] = [];
  if (i18nInput && !disabled.includes('i18n')) results.push(runI18nGate(i18nInput, now()));
  if (motionInput && !disabled.includes('motion')) results.push(runMotionGate(motionInput, now()));
  if (!results.length) return null;
  return { at: now(), trigger: 'needs_you', results };
}
