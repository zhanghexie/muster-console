import { ErrorTip } from './ErrorTip';
import { randomUuid } from '../../../shared/randomUuid';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceRoot } from '../../../shared/types';
import { pathKey } from '../../../shared/pathKey';
import { IconChevronDown } from './icons';
import { usePresence } from './motion';

interface Props {
  roots: WorkspaceRoot[];
  defaultRootId?: string;
  controlRootId?: string;
  onChange: (roots: WorkspaceRoot[], defaultRootId?: string, controlRootId?: string) => void;
  onPick: () => Promise<string[] | undefined>;
  onPickingChange?: (picking: boolean) => void;
  busy?: boolean;
  active?: boolean;
}

/** 创建/编辑复用。只编辑登记草稿；磁盘、真实路径和移除依赖由保存入口校验。 */
export function WorkspaceRootsEditor({ roots, defaultRootId, controlRootId, onChange, onPick, onPickingChange, busy, active = true }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string>();
  const request = useRef(0);
  const locked = !!busy || picking || !active;
  useEffect(() => { onPickingChange?.(picking); }, [picking, onPickingChange]);
  useEffect(() => {
    setPicking(false);
    setError('');
    setExpanded(undefined);
    return () => { request.current++; };
  }, [active]);

  const pick = async (): Promise<void> => {
    const token = ++request.current;
    setPicking(true);
    setError('');
    try {
      const paths = await onPick();
      if (token !== request.current || !paths?.length) return;
      const seen = new Set(roots.map((r) => pathKey(r.path)));
      const next = [...roots];
      let duplicate = false;
      for (const rootPath of paths) {
        if (seen.has(pathKey(rootPath))) { duplicate = true; continue; }
        seen.add(pathKey(rootPath));
        next.push({ id: randomUuid(), path: rootPath });
      }
      if (next.length > roots.length) onChange(next, defaultRootId ?? next[0].id, controlRootId ?? next[0].id);
      if (duplicate) setError(t('源文件夹已在列表中'));
    } catch (err) {
      if (token === request.current) setError(String((err as Error).message ?? err));
    } finally { if (token === request.current) setPicking(false); }
  };

  return <div className="ws-roots-editor">
    <div className="ws-roots-heading">
      <span>{t('源文件夹')}</span>
      <button type="button" className="ui-btn" disabled={locked} onClick={() => void pick()}>{picking ? t('选择中…') : t('添加文件夹')}</button>
    </div>
    {roots.length ? <ul className="ws-roots-list" aria-label={t('源文件夹')}>
      {roots.map((root) => {
        const management = root.id === controlRootId;
        const selected = root.id === defaultRootId;
        return <WorkspaceRootRow key={root.id} root={root} selected={selected} expanded={expanded === root.id} locked={locked}
          onExpand={() => setExpanded(expanded === root.id ? undefined : root.id)}>
            <button type="button" className="ui-btn" aria-pressed={selected} disabled={locked}
              onClick={() => onChange(roots, root.id, controlRootId)}>{selected ? t('默认运行目录') : t('设为默认')}</button>
            <button type="button" className="ui-btn" disabled={locked || management || roots.length <= 1}
              aria-label={t('移除文件夹')}
              title={management ? t('此文件夹保存工作区数据，移除前需迁移管理根') : t('移除只解除关联，不删除磁盘文件')}
              onClick={() => {
                const next = roots.filter((r) => r.id !== root.id);
                onChange(next, selected ? next[0].id : defaultRootId, controlRootId);
              }}>{t('移除')}</button>
            {management ? <span className="ws-root-management">{t('管理目录，保存工作区数据')}</span> : null}
        </WorkspaceRootRow>;
      })}
    </ul> : <div className="ws-roots-empty">{t('添加一个或多个源文件夹')}</div>}
    {error ? <ErrorTip message={error} /> : null}
  </div>;
}

function WorkspaceRootRow({ root, selected, expanded, locked, onExpand, children }: {
  root: WorkspaceRoot; selected: boolean; expanded: boolean; locked: boolean; onExpand: () => void; children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const presence = usePresence(expanded);
  const detailsId = `ws-root-details-${root.id}`;
  return <li data-root-id={root.id}>
    <button type="button" className="ws-root-summary" aria-label={root.path} aria-expanded={expanded} aria-controls={detailsId}
      disabled={locked} onClick={onExpand}>
      <span className="ws-root-path">{root.path}</span>
      {selected ? <span className="ws-root-badge">{t('默认')}</span> : null}
      <IconChevronDown size={12} className={expanded ? 'is-open' : ''} />
    </button>
    {presence.mounted ? <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread} id={detailsId} {...(!expanded ? { inert: '' } : {})} aria-hidden={!expanded}>
      <div className="acc-body"><div className="ws-root-actions">{children}</div></div>
    </div> : null}
  </li>;
}
