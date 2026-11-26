import { parseDocument } from 'yaml';
import { t } from '../../shared/i18n';

export const MAX_SKILL_BYTES = 1_048_576;
export function skillMetadata(content: string, fallback: string): { name: string; description: string; error?: string } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(normalized);
  if (!frontmatter) return { name: fallback, description: '', error: t('SKILL.md 缺少 YAML frontmatter') };
  try {
    const doc = parseDocument(frontmatter[1]);
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    const data: unknown = doc.toJS({ maxAliasCount: 10 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('frontmatter 必须是对象'));
    const values = data as Record<string, unknown>;
    const name = typeof values.name === 'string' ? values.name.trim() : '';
    const description = typeof values.description === 'string' ? values.description.trim() : '';
    if (!name) return { name: fallback, description, error: t('frontmatter 缺少 name') };
    if (!description) return { name, description, error: t('frontmatter 缺少 description') };
    return { name, description };
  } catch (error) {
    return { name: fallback, description: '', error: t('无法解析 frontmatter：{{message}}', { message: (error as Error).message }) };
  }
}
