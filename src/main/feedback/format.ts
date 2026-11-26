import type { FeedbackDraft, FeedbackEntry, FeedbackKind, ManualFeedbackInput } from '../../shared/feedback';
import { feedbackReadableBody } from '../../shared/feedbackFormatting';
import { collectEnvSecrets, redactSafetyText } from '../safety/redact';

const FIELDS = ['title', 'area', 'context', 'actual', 'expected', 'steps', 'impact', 'evidence', 'suggestion'] as const;

function cleanField(text: string, secrets: string[]): string {
  return redactSafetyText(text.trim(), [...secrets])
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '***REDACTED***')
    .replace(/<!--\s*muster-feedback:[^>]*-->/gi, '[内部标记已移除]');
}

function cleanDraftFields(input: unknown, additionalSecrets: string[] = []): FeedbackDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('反馈内容必须为对象');
  const value = input as Record<string, unknown>;
  if (value.kind !== 'bug' && value.kind !== 'improvement') throw new Error('反馈类型必须为 bug 或 improvement');
  const out: Record<string, string> = { kind: value.kind as FeedbackKind };
  const secrets = [...collectEnvSecrets(process.env), ...additionalSecrets.filter(Boolean)];
  for (const field of FIELDS) {
    const raw = value[field];
    if (raw !== undefined && typeof raw !== 'string') throw new Error(`反馈字段 ${field} 必须是文字`);
    const text = cleanField(raw as string | undefined ?? '', secrets);
    const max = field === 'title' ? 180 : field === 'area' ? 120 : 4000;
    if (text.length > max) throw new Error(`反馈字段 ${field} 超过 ${max} 字符`);
    out[field] = text;
  }
  return out as unknown as FeedbackDraft;
}

/** Validate in the host as CLI callers do not all have schema validation. */
export function cleanFeedbackDraft(input: unknown, additionalSecrets: string[] = []): FeedbackDraft {
  const draft = cleanDraftFields(input, additionalSecrets);
  if (!draft.title) throw new Error('请填写「标题」');
  if (!normalizedTitle(draft.title)) throw new Error('反馈标题需要包含文字或数字');
  return draft;
}

export function cleanManualFeedbackDraft(input: unknown): ManualFeedbackInput {
  const draft = cleanDraftFields(input);
  const rawEnvironment = (input as Record<string, unknown>).environment;
  if (rawEnvironment !== undefined && typeof rawEnvironment !== 'string') throw new Error('反馈字段 environment 必须是文字');
  const environment = cleanField(rawEnvironment as string | undefined ?? '', collectEnvSecrets(process.env));
  if (environment.length > 4000) throw new Error('反馈字段 environment 超过 4000 字符');
  if (!draft.title || /[\r\n]/.test(draft.title)) throw new Error('请在第一行填写反馈标题');
  if (!normalizedTitle(draft.title)) throw new Error('反馈标题需要包含文字或数字');
  return { ...draft, environment };
}

/** Clean a user-edited report while preserving its exact, visible Issue body. */
export function cleanFeedbackText(input: unknown): { title: string; body: string } {
  if (typeof input !== 'string') throw new Error('反馈内容必须为文字');
  if (input.length > 40_000) throw new Error('反馈内容不能超过 40000 个字符');
  const text = redactSafetyText(input.replace(/\r\n?/g, '\n'), collectEnvSecrets(process.env))
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '***REDACTED***')
    .replace(/<!--\s*muster-feedback:[^>]*-->/gi, '[内部标记已移除]').trim();
  const lineEnd = text.indexOf('\n');
  const title = (lineEnd < 0 ? text : text.slice(0, lineEnd)).trim();
  const body = lineEnd < 0 ? '' : text.slice(lineEnd + 1).trim();
  if (!title || !normalizedTitle(title)) throw new Error('请在第一行填写反馈标题');
  if (title.length > 180) throw new Error('反馈标题不能超过 180 个字符');
  if (!body) throw new Error('请填写反馈正文');
  return { title, body };
}

export function normalizedTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The same normalized title is a hard duplicate; similar titles only prompt a human. */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizedTitle(a), y = normalizedTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const xs = grams(x), ys = grams(y);
  const intersection = [...xs].filter(v => ys.has(v)).length;
  return xs.size + ys.size ? 2 * intersection / (xs.size + ys.size) : 0;
}

export function feedbackBody(entry: FeedbackEntry): string {
  return `${feedbackReadableBody(entry)}\n\n<!-- muster-feedback:${entry.id} -->`;
}
