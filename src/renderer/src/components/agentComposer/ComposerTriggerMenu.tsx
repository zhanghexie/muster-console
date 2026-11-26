import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MutableRefObject } from 'react';
import type { MenuKind, SlashItem } from './composerHelpers';
import type { WorkspaceFileEntry } from '../../../../shared/types';
import { workspaceFileKey } from '../../../../shared/workspaceRoots';
import type { Presence } from '../motion';

interface Props {
  menu: MenuKind;
  slashItems: SlashItem[];
  atItems: WorkspaceFileEntry[];
  activeIdx: number;
  menuRef: MutableRefObject<HTMLDivElement | null>;
  workspaceId: string | null;
  onHover: (idx: number) => void;
  onApply: (idx: number) => void;
  presence?: Presence;
  emptyHint?: string;
}

/** /、@ 触发词候选菜单（纯展示）：斜杠命令/技能与工作区文件两个列表形态。 */
export function ComposerTriggerMenu({
  menu,
  slashItems,
  atItems,
  activeIdx,
  menuRef,
  workspaceId,
  onHover,
  onApply,
  emptyHint,
  presence
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={`agent-composer-menu${presence ? ' mp-pop' : ''}`} role="listbox" ref={menuRef}
      // A press can open another popover before document-level outside-click handlers run.
      onMouseDown={presence ? event => event.stopPropagation() : undefined}
      data-mp-stage={presence?.stage} aria-hidden={presence?.stage === 'out'}
      {...(presence?.stage === 'out' ? { inert: '' } : {})}>
      {menu === 'slash' && slashItems.length === 0 && (
        <div className="agent-composer-menu-empty">{emptyHint ?? t('无匹配命令 / 技能')}</div>
      )}
      {menu === 'at' && atItems.length === 0 && (
        <div className="agent-composer-menu-empty">
          {workspaceId ? t('无匹配文件') : t('无工作区')}
        </div>
      )}
      {menu === 'slash' &&
        slashItems.map((item, i) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={i === activeIdx}
            data-active={i === activeIdx ? 'true' : undefined}
            className={`agent-composer-menu-item${i === activeIdx ? ' is-active' : ''}`}
            title={`${item.label}\n${item.description}\n${item.insert}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onApply(i);
            }}
          >
            <span className="agent-composer-menu-label">{item.label}</span>
            <span className="agent-composer-menu-desc">{item.description}</span>
          </button>
        ))}
      {menu === 'at' &&
        atItems.map((file, i) => (
          <button
            key={file.fileRef ? workspaceFileKey(file.fileRef) : file.path}
            type="button"
            role="option"
            aria-selected={i === activeIdx}
            data-active={i === activeIdx ? 'true' : undefined}
            className={`agent-composer-menu-item${i === activeIdx ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onApply(i);
            }}
          >
            <span className="agent-composer-menu-label">@{file.displayPath ?? file.path}</span>
            {file.fileRef ? <span className="agent-composer-menu-desc" title={file.absolutePath}>{file.absolutePath}</span> : null}
          </button>
        ))}
    </div>
  );
}
