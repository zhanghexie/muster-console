import { lookup } from 'node:dns/promises';
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 400_000;
const DEFAULT_MAX_CHARS = 8_000;
/** 宿主工具结果序列化预算 12K：正文上限必须留出包裹字段余量 */
const MAX_CHARS_CAP = 10_000;

function isPrivateIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return true;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

function isPrivateIPv6(s: string): boolean {
  const v = s.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(v)) return true; // fe80::/10 link local
  if (v.startsWith('::ffff:')) return isPrivateIPv4(v.slice(7)); // v4-mapped
  return false;
}

/** SSRF 粗防：字面量私网地址直接拒；域名则解析后逐一校验 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error(t('拒绝访问内网/回环地址'));
  }
  const literal =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : host.includes(':') ? host : null;
  if (literal) {
    if (isPrivateIPv4(literal) || isPrivateIPv6(literal)) {
      throw new Error(t('拒绝访问内网/回环地址'));
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(t('域名解析失败') + `: ${host}`);
  }
  if (addrs.length === 0) throw new Error(t('域名解析失败') + `: ${host}`);
  for (const { address } of addrs) {
    if (isPrivateIPv4(address) || isPrivateIPv6(address)) {
      throw new Error(t('拒绝访问内网/回环地址'));
    }
  }
}

/** HTML → 纯文本：去脚本/样式/注释，块级标签转行，实体解码，空白规整 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|ul|ol|table|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * web.fetch（联网抓取，read 类）：
 * - 仅供查公开文档/资料；拒绝内网与回环地址（SSRF 粗防）。
 * - HTML 去标签转正文；text/json 原样返回；结果截断在 12K 序列化预算内。
 */
export const webHost = {
  'web.fetch': async (_ctx: AppContext, args: { url?: string; maxChars?: number }) => {
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!raw) throw new Error(t('缺少 url'));
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(t('无效的 URL') + `: ${raw}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(t('仅支持 http(s) URL'));
    }
    await assertPublicHost(url.hostname);

    const maxChars = Math.max(
      200,
      Math.min(MAX_CHARS_CAP, typeof args?.maxChars === 'number' && args.maxChars > 0 ? Math.floor(args.maxChars) : DEFAULT_MAX_CHARS)
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });
    } catch (e) {
      throw new Error(t('抓取失败') + `: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`${t('抓取失败')}: HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (/^(image|audio|video|font)\//.test(contentType) || /octet-stream/.test(contentType)) {
      throw new Error(t('不支持二进制内容') + ` (${contentType})`);
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) {
      throw new Error(t('页面过大') + ` (${declared} > ${MAX_BYTES} bytes)`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const decoded = buf.subarray(0, MAX_BYTES).toString('utf-8');

    const isHtml = contentType.includes('html') || (!contentType && /^\s*</.test(decoded));
    const body = isHtml
      ? htmlToText(decoded)
      : contentType.includes('json')
        ? decoded
        : decoded.replace(/\r\n/g, '\n').trim();
    const truncated = body.length > maxChars;
    return {
      url: res.url || url.toString(),
      contentType: contentType || (isHtml ? 'text/html' : 'text/plain'),
      truncated,
      text: truncated ? body.slice(0, maxChars) : body
    };
  }
};
