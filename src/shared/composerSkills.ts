/**
 * Composer 技能斜杠菜单与 /skill:name 展开（纯函数，渲染层与主进程共用）。
 * 展开形态对齐 Pi SDK `_expandSkillCommand`：整段以 /skill:name 开头才展开，
 * 正文去 frontmatter 后包进 <skill>；参数追加在块后。未知技能原文通过。
 */

export interface ComposerSkillRef {
  name: string;
  description: string;
  filePath?: string;
  commandName?: string;
  source?: { label: string; path: string };
}

export interface SkillSlashItem {
  id: string;
  label: string;
  description: string;
  insert: string;
  skillFilePath?: string;
}

export interface SkillExpansionSource {
  name: string;
  filePath: string;
  baseDir: string;
  body: string;
}

/** 斜杠菜单技能条目：调度与 GUI 会话同一套过滤/收录，不按表面特判 */
export function skillsToSlashItems(
  skills: ReadonlyArray<ComposerSkillRef>,
  query: string,
  fallbackDesc: string
): SkillSlashItem[] {
  const q = query.toLowerCase();
  return skills
    .filter((s) => {
      if (!q) return true;
      const name = (s.commandName ?? s.name).toLowerCase();
      const pref = q.startsWith('skill:') ? q.slice(6) : q;
      return (
        name.includes(pref) ||
        `skill:${name}`.startsWith(q) ||
        s.name.toLowerCase().includes(pref) || s.description.toLowerCase().includes(pref) ||
        !!s.source && `${s.source.label} ${s.source.path}`.toLowerCase().includes(pref)
      );
    })
    .slice(0, 30)
    .map((s) => ({
      id: `skill:${s.commandName ?? s.name}`,
      label: `/skill:${s.source && skills.filter(other => other.name === s.name && other.source?.label === s.source?.label).length > 1 ? s.commandName ?? s.name : s.name}${s.source ? ` · ${s.source.label}` : ''}`,
      description: s.source ? `${s.description || fallbackDesc} · ${s.source.path}` : s.description || fallbackDesc,
      insert: `/skill:${s.commandName ?? s.name} `,
      ...(s.filePath ? { skillFilePath: s.filePath } : {})
    }));
}

/** Rehydrate a selected skill from the leading command or the CLI's quoted file reference. */
export function leadingComposerSkill(text: string, extensionNames: readonly string[] = []): { name: string; token: string; path?: string } | undefined {
  const normal = /^\/skill:([^\s]+)(?=\s|$)/.exec(text);
  if (normal) return { name: normal[1], token: normal[0] };
  const extension = /^\/([^\s]+)(?=\s|$)/.exec(text);
  if (extension && extensionNames.includes(extension[1])) return { name: extension[1], token: extension[0] };
  const cli = /^Use skill ("(?:\\.|[^"\\])*"); read ("(?:\\.|[^"\\])*")\.(?=\s|$)/.exec(text);
  if (cli) {
    try { return { name: JSON.parse(cli[1]), path: JSON.parse(cli[2]), token: cli[0] }; } catch { /* Ordinary text. */ }
  }
  return undefined;
}

export function extensionSkillNamesFromMeta(raw?: string): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];
  } catch { return []; }
}

/** 仅当整段以 /skill:name 开头时视为技能命令（与 Pi 一致） */
export function parseSkillCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/skill:')) return null;
  const spaceIndex = text.search(/\s/);
  const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  if (!name) return null;
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
  return { name, args };
}

/** 去掉 YAML frontmatter（对齐 Pi stripFrontmatter：归一换行 + 去 BOM，body trim） */
export function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return normalized;
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4).trim();
}

export function formatSkillExpansion(
  skill: { name: string; filePath: string; baseDir: string },
  body: string,
  args = ''
): string {
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  const trimmedArgs = args.trim();
  return trimmedArgs ? `${skillBlock}\n\n${trimmedArgs}` : skillBlock;
}

/** 按技能表展开；未命中或非技能命令则原文返回 */
export function expandSkillCommand(
  text: string,
  skills: ReadonlyArray<SkillExpansionSource>
): string {
  const parsed = parseSkillCommand(text);
  if (!parsed) return text;
  const skill = skills.find((s) => s.name === parsed.name);
  if (!skill) return text;
  return formatSkillExpansion(skill, skill.body, parsed.args);
}
