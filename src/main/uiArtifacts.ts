/**
 * ma-ui 部件落盘器：把 ui.render 参数组装成自包含 HTML 并写入会话 ui 目录。
 * 文件格式见 docs/prototypes/intelligent-ui/contract.md：元数据 + HTML 片段 + 公共运行时。
 * 写入位置由调用方决定（宿主接线时用 userData/agent-sessions/<sessionId>/ui/）。
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  scanHtmlViolations,
  validateUiRender,
  type UiRenderParams
} from '../shared/uiRender';
import { UI_CONTRACT_CSS, UI_MERMAID_RUNTIME_JS, UI_SHARED_RUNTIME_JS } from './uiAssets';

// Includes the offline D3/Three.js runtime and the author-source restoration copy.
export const UI_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

export type UiArtifactTheme = 'dark' | 'light';

export type UiArtifactResult =
  | { ok: true; filePath: string; warnings: string[] }
  | { ok: false; error: string; issues?: { path: string; message: string }[] };

/** Only Mermaid hosts opt into the larger offline Pele bundle. */
export function hasMermaidMarkup(html: string): boolean {
  return /<ma-mermaid\b/i.test(html) || /<(?:pre|div)\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmermaid\b[^"']*"|'[^']*\bmermaid\b[^']*'|[^\s>]*\bmermaid\b)/i.test(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** 标题 → 文件名 slug：仅 ASCII 字母数字（CJK/空格等折叠为 -，终端复制/划词友好），
 *  最长 24；纯中文标题使用 ui 兜底 */
export function slugifyUiTitle(title: string): string {
  const slug = title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug || 'ui';
}

export function uiArtifactFileName(
  seq: number,
  title: string,
  mode: 'inline' | 'browser'
): string {
  const slug = slugifyUiTitle(title);
  return `${String(seq).padStart(2, '0')}-${slug}.${mode}.html`;
}

/** 目录内 <n>- 前缀的下一个自增编号（从 1 起；无合法前缀文件时为 1） */
export function nextUiArtifactSeq(existing: string[]): number {
  let max = 0;
  for (const name of existing) {
    const m = name.match(/^(\d{2,})-/);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max + 1;
}

/**
 * 组装自包含部件 HTML（不落盘，纯函数）。
 * warnings 来自自定义 HTML 静态检查（硬编码色/越界字号），随工具结果回显供 agent 自修。
 */
export function buildUiArtifactHtml(
  params: UiRenderParams,
  theme: UiArtifactTheme = 'dark',
  artifactVersion = 1
): { html: string; warnings: string[] } {
  const mode = params.mode ?? 'inline';
  const warnings = scanHtmlViolations(params.html);
  const meta = { v: 2, revision: artifactVersion, mode, title: params.title,
    ...(params.note ? { note: params.note } : {}) };
  const metaAttr = JSON.stringify(meta).replace(/'/g, '&#39;').replace(/</g, '&lt;');
  // D3 and Three.js are bundled offline; only host font providers may load static resources.
  const csp = "default-src 'none'; style-src 'unsafe-inline' https://cdn-font.hyperos.mi.com https://cdn.jsdelivr.net; script-src 'unsafe-inline'; img-src data: blob:; font-src data: https://www.oppo.com https://cdn-font.hyperos.mi.com https://cdn.jsdelivr.net; connect-src 'none'; base-uri 'none'; form-action 'none'";
  const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
  const content = params.html + (params.note ? `<footer class="ma-note">${escapeHtml(params.note)}</footer>` : '');
  const html = `<!doctype html>
<html lang="zh-CN" data-theme="${theme}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.title)}</title><meta name="muster-ui" content='${metaAttr}'>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style id="ma-contract-style">${UI_CONTRACT_CSS}
html[data-theme='dark'] { color-scheme: dark; }
html[data-theme='light'] { color-scheme: light; }
body.ma-artifact { max-width: 960px; margin: 0 auto; padding: 24px; background: var(--bg-card); }
#ma-ui-content { display: flow-root; min-width: 0; }
html.in-frame { overflow: hidden; }
html.in-frame body.ma-artifact { max-width: none; margin: 0; padding: 0; background: var(--bg-card); }
@font-face { font-family: 'OPPO Sans'; font-weight: 400; font-display: swap; src: url('https://www.oppo.com/content/dam/statics/fonts/cn/OPPOSans3.0cn-Regular.woff2') format('woff2'); }
@font-face { font-family: 'OPPO Sans'; font-weight: 500; font-display: swap; src: url('https://www.oppo.com/content/dam/statics/fonts/cn/OPPOSans3.0cn-Medium.woff2') format('woff2'); }
@font-face { font-family: 'OPPO Sans'; font-weight: 700; font-display: swap; src: url('https://www.oppo.com/content/dam/statics/fonts/cn/OPPOSans3.0cn-Bold.woff2') format('woff2'); }
@media (max-width: 560px) { body.ma-artifact { padding: 16px; } html.in-frame body.ma-artifact { padding: 0; } }
</style><script>${UI_SHARED_RUNTIME_JS}</script>${hasMermaidMarkup(params.html) ? `<script>${UI_MERMAID_RUNTIME_JS}</script>` : ''}</head><body class="ma-artifact">
<script id="ma-ui-source" type="application/json">${json(params)}</script>
<main id="ma-ui-content">${content}</main></body></html>`;
  return { html, warnings };
}

/** 每目录互斥（「取号 + 写入」串行化）：并发 ui.render 各自 readdir→max+1 会同算一个
 *  序号，wx 重试在 >3 路并发下会耗尽（实测：10 并发 3 失败）。链尾吞错防断链。 */
const dirLocks = new Map<string, Promise<unknown>>();

async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  dirLocks.set(dir, next.catch(() => undefined));
  return next;
}

/** 校验 + 组装 + 落盘；编号自增、2MiB 上限、目录自动创建 */
export async function writeUiArtifact(
  dir: string,
  params: unknown,
  theme: UiArtifactTheme = 'dark'
): Promise<UiArtifactResult> {
  const issues = validateUiRender(params);
  if (issues.length) {
    return { ok: false, error: '参数校验失败（契约见 ui-widget-design skill）', issues };
  }
  const p = params as UiRenderParams;
  const { html, warnings } = buildUiArtifactHtml(p, theme);
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > UI_ARTIFACT_MAX_BYTES) {
    return { ok: false, error: `部件超出 ${Math.round(UI_ARTIFACT_MAX_BYTES / 1024)}KB 上限（当前 ${Math.round(bytes / 1024)}KB），拆分或精简后重试` };
  }
  await mkdir(dir, { recursive: true });
  const mode = p.mode ?? 'inline';
  return withDirLock(dir, async () => {
  const existing = await readdir(dir).catch(() => [] as string[]);
  let fileName = uiArtifactFileName(nextUiArtifactSeq(existing), p.title, mode);
  let filePath = '';
  // 撞号兜底（互斥已消主竞态；wx 排他创建 + EEXIST 顺延作双保险，如同目录被外部并发写）
  for (let attempt = 0; attempt < 8; attempt++) {
    filePath = path.join(dir, fileName);
    try {
      await writeFile(filePath, html, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 7) {
        const now = await readdir(dir).catch(() => [] as string[]);
        fileName = uiArtifactFileName(nextUiArtifactSeq(now), p.title, mode);
        continue;
      }
      throw e;
    }
  }
  return { ok: true, filePath, warnings };
  });
}
