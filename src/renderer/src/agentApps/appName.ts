import type { AgentAppDefinition } from '../../../shared/agentApps';
import { getResolvedLocale, t } from '../../../shared/i18n';
import { builtInAgentApps } from '../../../shared/agentAppsBuiltins';
import { photoAlbumExample } from '../../../shared/agentAppsExamples';

const builtins = new Map([...builtInAgentApps(), photoAlbumExample()].map(app => [app.id, app]));
const localizeIfBuiltin = (value: string, expected: string | undefined, englishKey = value) =>
  value === expected && getResolvedLocale() !== 'zh-CN' ? t(englishKey) : value;

/** Return a display-only overlay; persisted app definitions and user-edited labels stay intact. */
export function localizeBuiltinApp(app: AgentAppDefinition): AgentAppDefinition {
  const builtin = builtins.get(app.id);
  if (!builtin) return app;
  return {
    ...app,
    collections: app.collections.map(collection => {
      const expected = builtin.collections.find(item => item.id === collection.id);
      return { ...collection, title: localizeIfBuiltin(collection.title, expected?.title),
        fields: collection.fields.map(field => {
          const key = app.id === 'mail' && field.id === 'subject' ? '邮件主题'
            : app.id === 'messages' && field.id === 'body' ? '消息内容'
              : app.id === 'rss' && field.id === 'saved' ? '已收藏'
                : field.id === 'enabled' ? '已启用' : field.label;
          return { ...field, label: localizeIfBuiltin(field.label, expected?.fields.find(item => item.id === field.id)?.label, key) };
        }) };
    }),
    commands: app.commands.map(command => ({ ...command, title: localizeIfBuiltin(command.title, builtin.commands.find(item => item.id === command.id)?.title, command.id === 'create' ? '创建' : command.title) })),
    views: app.views.map(view => ({ ...view, title: localizeIfBuiltin(view.title, builtin.views.find(item => item.id === view.id)?.title) }))
  };
}

export function phoneBuiltinDescription(appId: string, description: string): string {
  return localizeIfBuiltin(description, builtins.get(appId)?.description);
}

/** Translate only unchanged built-in names; installed apps and renamed built-ins are user data. */
export function phoneAppName(app: Pick<AgentAppDefinition, 'id' | 'name'>): string {
  const builtin = builtins.get(app.id);
  return builtin && app.name === builtin.name ? t(builtin.name) : app.name;
}
