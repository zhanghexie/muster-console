/**
 * R-14 一期·交验前置门（机械门纯逻辑，宿主硬机制零 LLM）。
 * 维度注册表（内置默认，结构支持工作区配置覆盖——本批只做内置 + 配置读取骨架）：
 *   - i18n：改动命中 src/shared/i18n/**（或改动 .ts/.tsx 新增了 t() 调用）时，
 *     对「本次交付新增的 t() key」跑双语对账（zh 有 en 缺 → 红）；
 *     locale 文件删了仍被引用的 key 也红。核心抽取抽自 test/i18n-coverage.mjs（单源）。
 *   - motion：改动命中 *.css / components/motion.tsx 时，对「新增 CSS 行」跑静态规约
 *     （字面量时长 / cubic-bezier / transition: all）+ MOTION 常量与 base.css --dur-* 同步。
 * 结果由宿主写入 SessionMeta.dimensionGates 并广播；红灯会话不进「需要你」列
 * （见 boardReview.ts），逃生门 = 验收确认框「跳过维度门」+ 账本 override 留痕。
 * 无 fs / git 依赖：文件收集在 main/dimensionGates/runner.ts。
 */
import { t } from './i18n';

export type DimensionId = 'i18n' | 'motion';
export const DIMENSION_IDS: readonly DimensionId[] = ['i18n', 'motion'];

/** 维度标签（中文即 t() key；渲染点/本模块 helpers 已 t() 包装） */
export const DIMENSION_GATE_LABELS: Record<DimensionId, string> = {
  i18n: '多语言',
  motion: '动画'
};

export type DimensionGateStatus = 'red' | 'green';

export interface DimensionGateResult {
  id: DimensionId;
  status: DimensionGateStatus;
  /** 命中并检查的改动文件（仓库相对路径，前斜杠） */
  checkedFiles: string[];
  /** 红灯问题行（已本地化，人 / 调度直读）；上限 DIMENSION_PROBLEMS_MAX */
  problems: string[];
}

export interface DimensionGatesSnapshot {
  at: number;
  trigger: 'needs_you';
  results: DimensionGateResult[];
}

/** 单维度问题行上限（防长 diff 刷屏；超出截断提示） */
export const DIMENSION_PROBLEMS_MAX = 20;

/** 验收账本 override 留痕前缀（协议标记，人/Agent 重启可查；同 approval=auto 先例） */
export const DIMENSION_GATE_OVERRIDE_PREFIX = 'dimension-gate-override';

export function dimensionGateOverrideNote(detail: string): string {
  const d = detail.trim().replace(/\s+/g, ' ').slice(0, 160);
  return d ? `${DIMENSION_GATE_OVERRIDE_PREFIX}：${d}` : DIMENSION_GATE_OVERRIDE_PREFIX;
}

/* ------------------------------------------------------------------ *
 * i18n 核心抽取（与 test/i18n-coverage.mjs 同源；测试侧 import 本模块）
 * ------------------------------------------------------------------ */

/** t 调用的字符串字面量 key（单/双引号均可）；排除属性访问与标识符前缀 */
export const T_CALL_RE = /(?<![\w$])t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
/** 词条表 key 行：'key': 或 "key":（单双引号都收，fragments 生成物可能是双引号） */
export const LOCALE_KEY_LINE_RE = /^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/;

function unescapeKey(raw: string): string {
  return raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

/** 从源码文本（新增行合并 / 整文件）抽取 t() 字面量 key（带字符偏移，供调用方算行号） */
export function extractTCallKeyPositions(text: string): Array<{ key: string; index: number }> {
  const out: Array<{ key: string; index: number }> = [];
  for (const m of text.matchAll(T_CALL_RE)) {
    out.push({ key: unescapeKey(m[2]), index: m.index ?? 0 });
  }
  return out;
}

export function extractTCallKeys(text: string): string[] {
  return extractTCallKeyPositions(text).map((x) => x.key);
}

/** 从词条表源码或 diff 行提取字符串键，跳过注释及字符串值内的伪键。 */
export function extractLocaleKeys(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const src of files) {
    for (let i = 0; i < src.length;) {
      if (src.startsWith('//', i)) { const end = src.indexOf('\n', i + 2); i = end < 0 ? src.length : end; continue; }
      if (src.startsWith('/*', i)) { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
      const quote = src[i];
      if (quote !== "'" && quote !== '"' && quote !== '`') { i++; continue; }
      const start = i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i++] === quote) break;
      }
      if (quote === '`' || src[i - 1] !== quote) continue;
      const lineStart = src.lastIndexOf('\n', start - 1) + 1;
      const prefix = src.slice(lineStart, start).trimEnd();
      if (prefix && !prefix.endsWith('{') && !prefix.endsWith(',')) continue;
      let next = i;
      while (next < src.length && /\s/.test(src[next])) next++;
      if (src[next] === ':') out.push(unescapeKey(src.slice(start + 1, i - 1)));
    }
  }
  return out;
}

/** Repeated keys can silently override translations when locale fragments merge. */
export function duplicateLocaleKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  return [...duplicates];
}

/* ------------------------------------------------------------------ *
 * 维度命中（路径 pattern；输入统一仓库相对路径）
 * ------------------------------------------------------------------ */

export function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

const LOCALE_PREFIX = 'src/shared/i18n/';

export function isLocaleFile(p: string): boolean {
  return normalizeRepoPath(p).startsWith(LOCALE_PREFIX);
}

/** i18n 门命中：改了 locale 文件，或改了 .ts/.tsx（后者仅当新增行含 t() 才产生检查面） */
export function i18nGateHit(changedPaths: readonly string[]): boolean {
  return changedPaths.some((p) => {
    const n = normalizeRepoPath(p);
    return n.startsWith(LOCALE_PREFIX) || /\.tsx?$/.test(n);
  });
}

/** motion 门命中：改了 *.css 或 components/motion.tsx */
export function motionGateHit(changedPaths: readonly string[]): boolean {
  return changedPaths.some((p) => {
    const n = normalizeRepoPath(p);
    return n.endsWith('.css') || n.endsWith('components/motion.tsx');
  });
}

/* ------------------------------------------------------------------ *
 * i18n 增量检查
 * ------------------------------------------------------------------ */

export interface I18nGateInput {
  /** 本次交付的改动文件（仓库相对路径） */
  changedPaths: readonly string[];
  /** 各改动文件的新增行（未提交 + 领先提交 + 未跟踪全文） */
  addedByFile: ReadonlyArray<{ file: string; lines: readonly string[] }>;
  /** 各改动文件的删除行（locale key 回收检查用） */
  removedByFile?: ReadonlyArray<{ file: string; lines: readonly string[] }>;
  /** 全树 src 的 t() 引用 key（runner 扫描；仅 locale 文件有删除行时才需要，可空） */
  usedKeys?: readonly string[];
  /** 当前词条表全部 key */
  localeKeys: readonly string[];
}

export function runI18nGate(input: I18nGateInput, now = Date.now()): DimensionGateResult {
  const localeSet = new Set(input.localeKeys);
  const problems: string[] = [];
  const checkedFiles: string[] = [];
  let examinedKeys = 0;

  // ① 源码新增 t() key 缺英文词条（zh 有 en 缺）——只扫 src/（与 i18n-coverage 全量口径一致，
  // 免得测试夹具里的 t 调用字符串字面量误红）
  for (const f of input.addedByFile) {
    const rel = normalizeRepoPath(f.file);
    if (!/\.(ts|tsx|mjs)$/.test(rel)) continue;
    if (!(rel === 'src' || rel.startsWith('src/'))) continue;
    const keys = extractTCallKeys(f.lines.join('\n'));
    if (!keys.length) continue;
    examinedKeys += keys.length;
    if (isLocaleFile(f.file)) checkedFiles.push(normalizeRepoPath(f.file));
    for (const key of keys) {
      if (localeSet.has(key)) continue;
      const p = t('「{{key}}」缺英文词条（{{file}}）', { key, file: normalizeRepoPath(f.file) });
      if (!problems.includes(p)) problems.push(p);
    }
  }

  // ② locale 文件改动本身命中
  for (const p of input.changedPaths) {
    if (isLocaleFile(p) && !checkedFiles.includes(normalizeRepoPath(p))) {
      checkedFiles.push(normalizeRepoPath(p));
    }
  }

  // ③ locale 删除的 key 仍被源码引用（词条被误删）
  const removedLocale = (input.removedByFile ?? []).filter((f) => isLocaleFile(f.file));
  if (removedLocale.length && input.usedKeys?.length) {
    const usedSet = new Set(input.usedKeys);
    for (const f of removedLocale) {
      for (const key of extractLocaleKeys(f.lines)) {
        if (!usedSet.has(key) || localeSet.has(key)) continue;
        const p = t('「{{key}}」词条已删但仍被引用（{{file}}）', { key, file: normalizeRepoPath(f.file) });
        if (!problems.includes(p)) problems.push(p);
      }
    }
  }

  return {
    id: 'i18n',
    status: problems.length ? 'red' : 'green',
    checkedFiles: checkedFiles.slice(0, 50),
    problems: problems.slice(0, DIMENSION_PROBLEMS_MAX)
  };
}

/* ------------------------------------------------------------------ *
 * motion 静态检查
 * ------------------------------------------------------------------ */

export interface MotionGateInput {
  changedPaths: readonly string[];
  /** 改动 CSS 文件的新增行 */
  addedByFile: ReadonlyArray<{ file: string; lines: readonly string[] }>;
  /** motion.tsx 当前内容（命中且文件存在时传；MOTION 常量同步检查） */
  motionTsx?: string;
  /** base.css 当前内容（同上） */
  baseCss?: string;
  /** motion.tsx 是否在改动集里（决定是否跑常量同步检查） */
  motionTsxChanged?: boolean;
}

/** 时长属性行：transition / animation（-duration / -delay 变体） */
const TIMING_PROP_RE = /(?:transition|animation)(?:-(?:duration|delay))?\s*:/;
/** 字面量时长（非 token） */
const LITERAL_DURATION_RE = /\b\d+(?:\.\d+)?m?s\b/i;
/** token 定义行（--dur-* / --ease-* 本体允许字面量） */
const TOKEN_DEF_RE = /^\s*--(dur|ease)-[a-z0-9-]*\s*:/;

/** MOTION 常量块：export const MOTION = { microMs: 120, ... } */
const MOTION_BLOCK_RE = /export\s+const\s+MOTION\s*=\s*\{([^}]*)\}/;
const MOTION_ENTRY_RE = /(\w+)Ms\s*:\s*(\d+)/g;
const CSS_DUR_TOKEN_RE = /--dur-([a-z0-9-]+)\s*:\s*([\d.]+)m?s/g;

/** MOTION 常量与 base.css --dur-* token 同步检查（motion.tsx 或 base.css 改动时跑） */
export function checkMotionConstantSync(motionTsx: string, baseCss: string): string[] {
  const block = motionTsx.match(MOTION_BLOCK_RE)?.[1];
  if (!block) return [];
  const cssTokens = new Map<string, number>();
  for (const m of baseCss.matchAll(CSS_DUR_TOKEN_RE)) {
    const v = Number.parseFloat(m[2]);
    if (Number.isFinite(v)) cssTokens.set(m[1], v);
  }
  const problems: string[] = [];
  for (const m of block.matchAll(MOTION_ENTRY_RE)) {
    const name = m[1];
    const ms = Number.parseInt(m[2], 10);
    if (!Number.isFinite(ms)) continue;
    const cssMs = cssTokens.get(name);
    if (cssMs === undefined) {
      problems.push(t('MOTION.{{name}}Ms 无对应 --dur-{{name}} token', { name }));
    } else if (cssMs !== ms) {
      problems.push(
        t('MOTION.{{name}}Ms={{ms}} 与 base.css --dur-{{name}} 不一致', { name, ms })
      );
    }
  }
  return problems;
}

export function runMotionGate(input: MotionGateInput, now = Date.now()): DimensionGateResult {
  const problems: string[] = [];
  const checkedFiles: string[] = [];
  const push = (line: string): void => {
    if (problems.length >= DIMENSION_PROBLEMS_MAX) return;
    if (!problems.includes(line)) problems.push(line);
  };

  for (const f of input.addedByFile) {
    const file = normalizeRepoPath(f.file);
    if (!file.endsWith('.css')) continue;
    checkedFiles.push(file);
    for (const raw of f.lines) {
      const line = raw.trim();
      if (!line || line.startsWith('/*') || line.startsWith('*')) continue;
      const isTokenDef = TOKEN_DEF_RE.test(line);
      if (!isTokenDef && /\btransition\s*:\s*all\b/.test(line)) {
        push(t('{{file}} 使用 transition: all', { file }));
        continue;
      }
      if (!isTokenDef && LITERAL_DURATION_RE.test(line) && TIMING_PROP_RE.test(line)) {
        push(
          t('{{file}} 新增字面量时长/曲线：{{line}}', {
            file,
            line: line.slice(0, 80)
          })
        );
        continue;
      }
      if (!isTokenDef && line.includes('cubic-bezier(')) {
        push(t('{{file}} 新增字面量时长/曲线：{{line}}', { file, line: line.slice(0, 80) }));
      }
    }
  }

  // MOTION 常量同步检查：motion.tsx 或任一 CSS 改动即跑（AGENTS.md「改 --dur-* 必须同步 MOTION」
  // 只盯 motion.tsx 会漏「只改 base.css 的 --dur-*」这半边）；两项内容可读即查，静态检查零成本
  if (
    input.motionTsx !== undefined &&
    input.baseCss !== undefined &&
    input.changedPaths.some(
      (p) => normalizeRepoPath(p).endsWith('motion.tsx') || normalizeRepoPath(p).endsWith('.css')
    )
  ) {
    if (!checkedFiles.includes('src/renderer/src/components/motion.tsx')) {
      checkedFiles.push('src/renderer/src/components/motion.tsx');
    }
    for (const p of checkMotionConstantSync(input.motionTsx, input.baseCss)) push(p);
  }

  return {
    id: 'motion',
    status: problems.length ? 'red' : 'green',
    checkedFiles,
    problems
  };
}

/* ------------------------------------------------------------------ *
 * 快照聚合 / 展示
 * ------------------------------------------------------------------ */

export function hasRedGate(snapshot?: DimensionGatesSnapshot | null): boolean {
  return !!snapshot?.results.some((r) => r.status === 'red');
}

export function isDimensionGateRedSession(
  s: Pick<SessionMetaLike, 'phase' | 'dimensionGates'>
): boolean {
  return s.phase?.value === 'needs_you' && hasRedGate(s.dimensionGates);
}

/** 红灯维度标签（已 t()；空数组 = 无红灯） */
export function redGateDimensionLabels(snapshot?: DimensionGatesSnapshot | null): string[] {
  const out: string[] = [];
  for (const r of snapshot?.results ?? []) {
    if (r.status === 'red') out.push(t(DIMENSION_GATE_LABELS[r.id]));
  }
  return out;
}

/** 看板徽标 / 摘要一行：「维度门未过：多语言、动画」 */
export function dimensionGateBadgeLabel(snapshot?: DimensionGatesSnapshot | null): string {
  const dims = redGateDimensionLabels(snapshot);
  return dims.length ? t('维度门未过：{{dims}}', { dims: dims.join('、') }) : '';
}

/** 红灯详情多行文本（徽标 title / 确认框 / 编排事件用）；无红灯返回 '' */
export function dimensionGateDetailText(snapshot?: DimensionGatesSnapshot | null): string {
  if (!snapshot) return '';
  const lines: string[] = [];
  for (const r of snapshot.results) {
    if (!r.problems.length) continue;
    lines.push(`【${t(DIMENSION_GATE_LABELS[r.id])}】`);
    for (const p of r.problems) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 工作区配置覆盖骨架（.muster/dimension-gates.json）
 * ------------------------------------------------------------------ */

export interface DimensionGateConfig {
  /** 禁用的维度 id（一期仅支持关闭内置维度） */
  disabled: DimensionId[];
}

export function parseDimensionGateConfig(raw: unknown): DimensionGateConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { disabled?: unknown };
  const disabled = Array.isArray(obj.disabled)
    ? obj.disabled.filter((x): x is DimensionId => DIMENSION_IDS.includes(x as DimensionId))
    : [];
  return { disabled };
}

/** 统一 diff 文本 → 新增 / 删除行（git diff -U0 输出；+++ / --- 头除外） */
export function splitUnifiedDiff(diffText: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) added.push(raw.slice(1));
    else if (raw.startsWith('-')) removed.push(raw.slice(1));
  }
  return { added, removed };
}

/** 本文件自引用类型（避免与 types.ts 循环）：SessionMeta 的最小结构 */
interface SessionMetaLike {
  phase?: { value?: string } | undefined;
  dimensionGates?: DimensionGatesSnapshot | null;
}
