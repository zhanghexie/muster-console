import React from 'react';
import { useTranslation } from 'react-i18next';

export function BoardTodoCard({ id, name, task, workspaceName, onEdit }: {
  id: string; name: string; task: string; workspaceName?: string; onEdit?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="board-card board-todo-card" data-todo-id={id}
    role={onEdit ? 'button' : undefined} tabIndex={onEdit ? 0 : undefined}
    aria-label={name.trim() || task.trim().split('\n')[0]} title={t('双击编辑代办')}
    onDoubleClick={onEdit ? event => { event.stopPropagation(); onEdit(); } : undefined}
    onKeyDown={onEdit ? event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onEdit(); }
    } : undefined}>
    <div className="board-card-head"><span className="board-todo-tag">{t('代办')}</span><span className="board-card-name">{name.trim() || task.trim().split('\n')[0]}</span></div>
    <div className="board-todo-preview">{task}</div>
    {workspaceName ? <div className="board-card-meta"><span className="board-card-ws">{workspaceName}</span></div> : null}
  </div>;
}
