/** Canonical ui.render contract: compose public components in an HTML fragment. */
export interface UiRenderParams {
  title: string;
  html: string;
  mode?: 'inline' | 'browser';
  note?: string;
  update?: string;
}
export interface UiValidationIssue { path: string; message: string; }
const fields = new Set(['title', 'html', 'mode', 'note', 'update']);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function validateUiRender(value: unknown): UiValidationIssue[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path: 'params', message: '须为对象' }];
  const params = value as Record<string, unknown>, issues: UiValidationIssue[] = [];
  for (const key of Object.keys(params)) {
    if (!fields.has(key)) issues.push({ path: key, message: key === 'preset' || key === 'data' ? '不再支持 preset/data，请用公共 ma-* 组件组成 html' : '未知字段' });
  }
  for (const key of ['title', 'html']) if (!isText(params[key])) issues.push({ path: key, message: '必填非空字符串' });
  if (params.mode !== undefined && params.mode !== 'inline' && params.mode !== 'browser') issues.push({ path: 'mode', message: '枚举 inline|browser' });
  for (const key of ['note', 'update']) if (params[key] !== undefined && !isText(params[key])) issues.push({ path: key, message: '非空字符串' });
  return issues;
}

/** Author feedback for hard-coded colors and font sizes outside the host tokens. */
export function scanHtmlViolations(html: string): string[] {
  const out: string[] = [];
  const hex = html.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g);
  if (hex?.length) out.push(`硬编码颜色（用 var(--*) token）：${hex.slice(0, 3).join(' ')}${hex.length > 3 ? ` 等 ${hex.length} 处` : ''}`);
  const rgb = html.match(/rgba?\(/g);
  if (rgb?.length) out.push(`rgb()/rgba() 颜色 ${rgb.length} 处（用 var(--*) token）`);
  for (const match of html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gi)) {
    const px = Number(match[1]); if (px < 10 || px > 22) out.push(`font-size ${px}px 超出 10–22px 约定`);
  }
  const tones = ['success', 'danger', 'warning', 'info', 'neutral'];
  for (const tag of html.matchAll(/<(ma-text|ma-badge)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tone = tag[0].match(/\s+tone\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = tone && (tone[1] ?? tone[2] ?? tone[3]);
    if (value !== null && value !== undefined && !tones.includes(value)) out.push(`${tag[1]} tone=${JSON.stringify(value)} 无效（合法：${tones.join('/')}）`);
  }
  return out;
}
