import { getResolvedLocale, t } from '../../../shared/i18n';

/** Stable host diagnostics; paths and third-party details are never translated. */
export const SKILL_CONSOLIDATION_ERRORS = [
  '技能包超过归并大小限制，请先整理目录。', '技能包超过 100 MiB，无法归并。',
  '技能备份读回不一致，未删除原文件。', '技能暂存读回不一致。', '技能归并后读回不一致。',
  '原通用目录链接被外部修改', '新源被外部修改', '链接被外部修改', '原路径被占用', '通用目录已被占用', '暂存内容变化'
] as const;
export const SKILL_CONSOLIDATION_PREFIXES = [
  { prefix: '技能包内含链接，无法安全归并：', key: '技能包内含链接，无法安全归并：{{detail}}' },
  { prefix: '技能包含仓库或嵌套技能，无法整体删除：', key: '技能包含仓库或嵌套技能，无法整体删除：{{detail}}' },
  { prefix: '技能包内存在特殊文件：', key: '技能包内存在特殊文件：{{detail}}' },
  { prefix: '技能链接读回失败：', key: '技能链接读回失败：{{detail}}' },
  { prefix: '存在未完成的技能归并，请先按事务清单恢复：', key: '存在未完成的技能归并，请先按事务清单恢复：{{detail}}' },
  { prefix: '归并后旧副本被外部修改，请检查事务清单：', key: '归并后旧副本被外部修改，请检查事务清单：{{detail}}' }
] as const;
const known = new Set<string>(SKILL_CONSOLIDATION_ERRORS);

export function localizeSkillConsolidationError(value: string): string {
  if (getResolvedLocale() === 'zh-CN') return value;
  const wrapped = /^(?:Error invoking remote method '[^']+': )?Error: ([\s\S]*)$/.exec(value);
  if (wrapped) {
    const translated = localizeSkillConsolidationError(wrapped[1]);
    return translated === wrapped[1] ? value : translated;
  }
  const retained = /^(.*)；原文件已保留或恢复。$/.exec(value);
  if (retained) return t('{{detail}}；原文件已保留或恢复。', { detail: localizeSkillConsolidationError(retained[1]) });
  const rollback = /^(.*?)；回滚未完成，请检查 (.+?): ([\s\S]*)$/.exec(value);
  if (rollback) {
    const failures = rollback[3].split('; ').map(failure => {
      const match = /^(.*?: )?(Error: [\s\S]*)$/.exec(failure);
      if (!match) return failure;
      const translated = localizeSkillConsolidationError(match[2]);
      return translated === match[2] ? failure : (match[1] ?? '') + translated;
    }).join('; ');
    return t('{{detail}}；回滚未完成，请检查 {{path}}: {{failures}}', { detail: localizeSkillConsolidationError(rollback[1]), path: rollback[2], failures });
  }
  const cleanup = /^统一源已保存，但旧副本清理未完成：(.+?)；([\s\S]*)$/.exec(value);
  if (cleanup) return t('统一源已保存，但旧副本清理未完成：{{path}}；{{detail}}', { path: cleanup[1], detail: localizeSkillConsolidationError(cleanup[2]) });
  if (known.has(value)) return t(value);
  const template = SKILL_CONSOLIDATION_PREFIXES.find(item => value.startsWith(item.prefix));
  return template ? t(template.key, { detail: value.slice(template.prefix.length) }) : value;
}
