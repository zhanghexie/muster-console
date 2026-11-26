/** mermaid 查看器缩放/平移（纯函数，渲染层与离线单测共用） */

export const MERMAID_ZOOM_MIN = 0.2;
export const MERMAID_ZOOM_MAX = 8;
export const MERMAID_ZOOM_STEP = 1.15;

export interface MermaidViewState {
  scale: number;
  x: number;
  y: number;
}

export function clampMermaidZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MERMAID_ZOOM_MAX, Math.max(MERMAID_ZOOM_MIN, scale));
}

/** 以视口内一点为锚缩放，该点下的内容不动 */
export function zoomMermaidToward(
  state: MermaidViewState,
  nextScale: number,
  pivotX: number,
  pivotY: number
): MermaidViewState {
  const scale = clampMermaidZoom(nextScale);
  if (scale === state.scale) return state;
  const px = (pivotX - state.x) / state.scale;
  const py = (pivotY - state.y) / state.scale;
  return { scale, x: pivotX - px * scale, y: pivotY - py * scale };
}

/** 从 mermaid 产出的 SVG 读 viewBox 宽高（忽略 origin） */
export function parseMermaidSvgViewBox(svg: string): { width: number; height: number } | null {
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const vb = open[0].match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (!vb) return null;
  const parts = vb[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4) return null;
  const width = parts[2];
  const height = parts[3];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function stripSvgAttr(attrs: string, name: string): string {
  return attrs.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'gi'), '');
}

/** 相对亮度（WCAG 近似）：输入 #rgb/#rrggbb/#rrggbbaa 或 rgb() 字符串 */
function relativeLuminance(color: string): number | null {
  const hex = color.match(/^#([0-9a-f]{3,8})$/i);
  let r = 0;
  let g = 0;
  let b = 0;
  if (hex) {
    const v = hex[1];
    if (v.length === 3 || v.length === 4) {
      r = parseInt(v[0] + v[0], 16);
      g = parseInt(v[1] + v[1], 16);
      b = parseInt(v[2] + v[2], 16);
    } else if (v.length === 6 || v.length === 8) {
      r = parseInt(v.slice(0, 2), 16);
      g = parseInt(v.slice(2, 4), 16);
      b = parseInt(v.slice(4, 6), 16);
    } else return null;
  } else {
    const rgb = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (!rgb) return null;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
    if (![r, g, b].every(Number.isFinite)) return null;
  }
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 仅渲染层/jsdom 可用；node 侧（test/mermaid-view.mjs）不会调用本函数。
 *  结构化最小类型，避免 tsconfig.node（无 DOM lib）下 Document/Node 不可见。 */
interface SvgElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selectors: string): SvgElementLike | null;
}

interface DomParsingHost {
  DOMParser: new () => { parseFromString(source: string, mimeType: string): { querySelectorAll(selectors: string): SvgElementLike[] } };
  XMLSerializer: new () => { serializeToString(node: unknown): string };
}

/**
 * 节点字面填充的文字对比色修正：
 * 图源码 classDef/style 里的字面 fill（如 AI 常用的 #e0f7fa 浅青）会原样生效，
 * 而文字色继承主题前景——深色主题下浅底+浅字不可读（反之浅主题深底亦然）。
 * 对每个带字面填充的节点按亮度给文字配对比色；字面填充是 var() 或源码显式
 * 指定了文字色（style/color）的尊重原样不动。仅字符串级处理，无需挂 DOM。
 */
export function contrastMermaidLabels(svg: string): string {
  if (!svg.includes('pele-node')) return svg;
  const dom = globalThis as unknown as DomParsingHost;
  const doc = new dom.DOMParser().parseFromString(svg, 'image/svg+xml');
  let touched = false;
  for (const group of doc.querySelectorAll('g.pele-node')) {
    const shape = group.querySelector('rect,path,ellipse,circle,polygon');
    const styleFill = shape?.getAttribute('style')?.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1]?.trim();
    if (!styleFill || /^(var|url|none|inherit|currentcolor)/i.test(styleFill)) continue;
    const lum = relativeLuminance(styleFill);
    if (lum === null) continue;
    const text = group.querySelector('text');
    if (!text) continue;
    // 源码给过文字色（pele 会落到 text 的 style/fill 上）就不越权
    if (/(?:^|;)\s*fill\s*:/i.test(text.getAttribute('style') ?? '') || text.getAttribute('fill')) continue;
    // WCAG 4.5:1 的黑白交叉点约在 0.18-0.2，中间调底色配深字对比更优
    text.setAttribute('fill', lum > 0.2 ? '#1f1f1f' : '#fafafa');
    touched = true;
  }
  return touched ? new dom.XMLSerializer().serializeToString(doc) : svg;
}

/**
 * mermaid 默认 useMaxWidth 会写成 width="100%" / height 百分比。
 * 父级高度随内容撑开时形成循环，重启后历史消息里图会瘪成一条；点开查看器读 viewBox 又是正常的。
 * 这里改成 viewBox 像素宽高 + aspect-ratio，预览才能稳定撑开。
 */
export function normalizeMermaidSvg(svg: string): string {
  const box = parseMermaidSvgViewBox(svg);
  return svg.replace(/<svg\b([^>]*)>/i, (_full, attrs: string) => {
    let next = stripSvgAttr(stripSvgAttr(attrs, 'width'), 'height');
    const styleMatch = next.match(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
    const oldStyle = styleMatch ? (styleMatch[2] ?? styleMatch[3] ?? '') : '';
    const kept = oldStyle
      .split(';')
      .map((part) => part.trim())
      .filter((part) => {
        if (!part) return false;
        const key = part.split(':')[0]?.trim().toLowerCase();
        return key !== 'max-width' && key !== 'max-height' && key !== 'width' && key !== 'height';
      });
    if (box) kept.push(`aspect-ratio: ${box.width} / ${box.height}`);
    next = next.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i, '');
    if (kept.length) next += ` style="${kept.join('; ')}"`;
    if (box) next += ` width="${box.width}" height="${box.height}"`;
    return `<svg${next}>`;
  });
}
export function fitMermaidView(
  viewW: number,
  viewH: number,
  contentW: number,
  contentH: number,
  padding = 48
): MermaidViewState {
  const cw = Math.max(1, contentW);
  const ch = Math.max(1, contentH);
  const availW = Math.max(1, viewW - padding * 2);
  const availH = Math.max(1, viewH - padding * 2);
  const scale = clampMermaidZoom(Math.min(availW / cw, availH / ch, 1));
  return {
    scale,
    x: (viewW - cw * scale) / 2,
    y: (viewH - ch * scale) / 2
  };
}
