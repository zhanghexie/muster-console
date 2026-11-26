import { t } from './i18n';

/** Display the host warning without rewriting Git's diagnostic or the retained path. */
export function localizeGitUserError(message: string): string {
  const marker = '；创建失败后目录已保留，请检查：';
  const index = message.indexOf(marker);
  if (index <= 0 || index !== message.lastIndexOf(marker) || index + marker.length === message.length) return message;
  return t('{{error}}；创建失败后目录已保留，请检查：{{path}}', {
    error: message.slice(0, index), path: message.slice(index + marker.length)
  });
}
