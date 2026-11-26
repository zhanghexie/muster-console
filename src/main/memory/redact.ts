/**
 * 凭证形态脱敏（memory-refactor §6.2 会话结束转录摄入 / §14 转录摄入隐私）：
 * 进入 staging 前对候选文本做正则遮蔽，**保守优先**——形态可疑即遮，宁可误遮
 * 不可漏放。纯函数、零 IO/electron 依赖。
 *
 * 已知边界（如实声明，不假装完备）：
 * - 形态正则只覆盖常见凭证形状（赋值对/Bearer/私钥块/知名前缀 token/URL 内嵌凭据）；
 * - 无固定形态的自由文本秘密（口令短语、随意粘贴的密钥）不保证遮蔽——
 *   转录摄入只取「有信息量的断言消息」，长粘贴内容本就被候选切分排除；
 * - 遮蔽不可逆（原始文本不进 staging/日志）。
 */
export const REDACTED = '***REDACTED***';

/** key=value / key: value 赋值对（key 为常见凭证名；值 ≥8 字符的 secret 形态） */
const ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization)\b(\s*[:=]\s*)["']?([A-Za-z0-9_\-./+=]{8,})["']?/gi;

/** Bearer 方案头（含 eyJ JWT 形态） */
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

/** PEM 私钥块（BEGIN…PRIVATE KEY 到 END 整块遮蔽） */
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** 知名服务 token 前缀（OpenAI / GitHub / Slack / 飞书） */
const KNOWN_PREFIX_TOKENS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: 'openai-key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack-token' },
  { re: /\bv[0-9a-f]\.[0-9a-f]{8}\.[0-9a-zA-Z_-]{10,}\b/g, label: 'discord-style-token' }
];

/** URL 内嵌凭据：scheme://user:pass@host → 遮蔽 pass */
const URL_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@/\s]{3,})(@[^\s]+)/gi;

/** JWT 三段形态（eyJ 头） */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export interface RedactResult {
  /** 脱敏后的文本 */
  text: string;
  /** 命中的形态标签（诊断/测试用；不含原文） */
  hits: string[];
}

/** 对候选文本做凭证形态遮蔽（幂等：已遮蔽的 ***REDACTED*** 不会被再次处理） */
export function redactCredentialShapes(text: string | null | undefined): RedactResult {
  let out = text ?? '';
  const hits: string[] = [];
  if (!out) return { text: out, hits };

  out = out.replace(PRIVATE_KEY_BLOCK_RE, () => {
    hits.push('private-key-block');
    return `${REDACTED}`;
  });
  out = out.replace(ASSIGNMENT_RE, (_m, key: string, sep: string) => {
    hits.push('assignment');
    return `${key}${sep}${REDACTED}`;
  });
  out = out.replace(BEARER_RE, (_m, scheme: string) => {
    hits.push('bearer');
    return `${scheme}${REDACTED}`;
  });
  out = out.replace(URL_CREDENTIAL_RE, (_m, head: string, _pass: string, tail: string) => {
    hits.push('url-credential');
    return `${head}${REDACTED}${tail}`;
  });
  out = out.replace(JWT_RE, () => {
    hits.push('jwt');
    return REDACTED;
  });
  for (const t of KNOWN_PREFIX_TOKENS) {
    out = out.replace(t.re, () => {
      hits.push(t.label);
      return REDACTED;
    });
  }
  // 去重排序（诊断稳定）
  return { text: out, hits: [...new Set(hits)].sort() };
}
