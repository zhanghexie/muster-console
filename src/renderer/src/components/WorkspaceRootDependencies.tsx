import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceRoot, WorkspaceRootDependency } from '../../../shared/types';
import { workspaceRootLabel } from '../../../shared/workspaceRoots';
import { t } from '../../../shared/i18n';
import { usePresenceValue } from './motion';

export class WorkspaceSaveError extends Error {
  readonly rootDependencies: WorkspaceRootDependency[];
  constructor(message: string, dependencies: WorkspaceRootDependency[] = []) {
    super(message);
    this.rootDependencies = dependencies.map(item => ({ ...item }));
  }
}

function kindLabel(kind: WorkspaceRootDependency['kind']): string {
  switch (kind) {
    case 'session': return t('运行中会话');
    case 'worktree': return t('隔离 worktree');
    case 'queued-task': return t('排队任务');
    case 'service': return t('定时服务');
    case 'background-task': return t('后台任务');
    case 'launch': return t('正在创建会话');
    case 'open-file': return t('打开的文件');
    case 'file-write': return t('正在保存文件');
    case 'file-delete': return t('正在删除文件');
  }
}

interface Props {
  dependencies: WorkspaceRootDependency[];
  roots: WorkspaceRoot[];
  busy?: boolean;
  active?: boolean;
  onOpen?: (dependency: WorkspaceRootDependency) => void;
}

export function WorkspaceRootDependencies({ dependencies, roots, busy, active = true, onOpen }: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const { presence, value } = usePresenceValue(active && dependencies.length ? { dependencies, roots } : null);
  if (!presence.mounted || !value) return null;
  return <section className="ws-root-dependencies mp-panel" {...presence.spread} aria-hidden={presence.stage === 'out' ? true : undefined} aria-label={t('移除受阻的依赖')}>
    <h4>{t('源文件夹仍在使用')}</h4>
    <p>{t('处理以下依赖后重试保存；查看对象会关闭设置。')}</p>
    <ul>
      {value.dependencies.map(item => {
        const root = value.roots.find(root => root.id === item.rootId);
        const action = item.serviceId ? t('查看服务') : item.sessionId ? t('查看会话')
          : item.kind === 'open-file' && item.relativePath !== undefined ? t('打开文件') : undefined;
        return <li key={JSON.stringify([item.rootId, item.kind, item.id])}>
          <div className="ws-root-dependency-text">
            <span className="ws-root-dependency-kind" title={root?.path}>{root ? workspaceRootLabel(root) : item.rootId} · {kindLabel(item.kind)}</span>
            {root ? <span className="ws-root-dependency-hint">{root.path}</span> : null}
            <span className="ws-root-dependency-label" title={item.label}>{item.label || root?.path || item.rootId}</span>
            <span className="ws-root-dependency-hint">{item.kind === 'open-file'
              ? t('请在打开它的原窗口关闭文件视图。')
              : action ? t('请在对象页面处理使用状态后重试。') : t('操作仍在进行，请稍后重试保存')}</span>
          </div>
          {action && onOpen ? <button type="button" className="ui-btn" disabled={busy || presence.stage === 'out'} onClick={() => onOpen({ ...item })}>{action}</button> : null}
        </li>;
      })}
    </ul>
  </section>;
}
