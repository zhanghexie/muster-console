import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FilterCheckbox } from '../components/FilterCheckbox';
import { IconCheckSquare, IconLocate, IconSquare } from '../components/icons';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { MOTION, usePresence } from '../components/motion';
import type { BoardFilterPanel } from './freeViewGeom';

export interface BoardFilterOption {
  id: string;
  label: string;
}

const MARGIN = 8;
const ANCHOR_GAP = 6;
const MAX_HEIGHT = 640;
const PANEL_COLORS: Record<BoardFilterPanel, string> = {
  todo: 'var(--board-column-fg-secondary)',
  working: 'var(--board-column-status-info-fg)',
  needsYou: 'var(--board-column-status-warning-fg)',
  done: 'var(--board-column-status-success-fg)',
  archived: 'var(--board-column-fg-muted)'
};

function SelectAll({ label, selected, onClick }: {
  label: string;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = selected ? IconCheckSquare : IconSquare;
  return (
    <button type="button" className="filter-checkbox-row board-filter-command" aria-pressed={selected} onClick={onClick}>
      <Icon size={13} />
      <span className="filter-row-label">{label}</span>
    </button>
  );
}

export function BoardFilterMenu({
  open,
  anchorRef,
  workspaceOptions,
  selectedWorkspaceIds,
  panelOptions,
  selectedPanelIds,
  onToggleWorkspace,
  onTogglePanel,
  currentWorkspaceId,
  onSelectCurrentWorkspace,
  onSelectAllWorkspaces,
  onSelectAllPanels,
  onClose
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  workspaceOptions: BoardFilterOption[];
  selectedWorkspaceIds: string[] | null;
  panelOptions: Array<BoardFilterOption & { id: BoardFilterPanel }>;
  selectedPanelIds: BoardFilterPanel[] | null;
  onToggleWorkspace: (id: string) => void;
  onTogglePanel: (id: BoardFilterPanel) => void;
  currentWorkspaceId?: string | null;
  onSelectCurrentWorkspace: () => void;
  onSelectAllWorkspaces: () => void;
  onSelectAllPanels: () => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open, MOTION.microMs);
  const interactive = open && presence.stage === 'in';
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight?: number; above: boolean }>({
    left: 0, top: 0, above: false
  });
  const allWorkspaces = selectedWorkspaceIds === null;
  const allPanels = selectedPanelIds === null;
  const currentWorkspaceSelected = Boolean(
    currentWorkspaceId && selectedWorkspaceIds?.length === 1 && selectedWorkspaceIds[0] === currentWorkspaceId
  );
  const workspaceChecked = (id: string): boolean => allWorkspaces || selectedWorkspaceIds?.includes(id) === true;
  const panelChecked = (id: BoardFilterPanel): boolean => allPanels || selectedPanelIds?.includes(id) === true;

  useOverlayDismiss(open, () => {
    onClose();
    anchorRef.current?.focus({ preventScroll: true });
  });

  useLayoutEffect(() => {
    if (!presence.mounted) return;
    const updatePosition = (): void => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = Math.min(MAX_HEIGHT, menu.scrollHeight + menu.offsetHeight - menu.clientHeight);
      const left = Math.min(Math.max(MARGIN, rect.right - width), Math.max(MARGIN, window.innerWidth - width - MARGIN));
      const roomBelow = window.innerHeight - MARGIN - rect.bottom - ANCHOR_GAP;
      const roomAbove = rect.top - ANCHOR_GAP - MARGIN;
      const above = height > roomBelow && roomAbove > roomBelow;
      const maxHeight = Math.max(0, Math.min(MAX_HEIGHT, above ? roomAbove : roomBelow));
      const top = above ? rect.top - ANCHOR_GAP - Math.min(height, maxHeight) : Math.max(MARGIN, rect.bottom + ANCHOR_GAP);
      setPosition(previous => previous.left === left && previous.top === top
        && previous.maxHeight === maxHeight && previous.above === above ? previous : { left, top, maxHeight, above });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, presence.mounted, workspaceOptions.length, panelOptions.length]);

  useLayoutEffect(() => {
    if (interactive) menuRef.current?.querySelector<HTMLElement>('button:not(:disabled), input')?.focus({ preventScroll: true });
  }, [interactive]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [anchorRef, onClose, open]);

  if (!presence.mounted) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="board-filter-menu filter-popover-surface mp-pop"
      data-mp-stage={presence.stage}
      data-overlay-root=""
      data-above={position.above || undefined}
      aria-hidden={!interactive || undefined}
      {...(!interactive ? { inert: '' } : {})}
      role="dialog"
      aria-label={t('过滤')}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="board-filter-section" role="group" aria-label={t('工作区')}>
        <div className="board-filter-section-head">
          <strong>{t('工作区')}</strong>
        </div>
        <div className="board-filter-options">
          <button
            type="button"
            className="filter-checkbox-row board-filter-command"
            aria-pressed={currentWorkspaceSelected}
            disabled={!currentWorkspaceId}
            onClick={onSelectCurrentWorkspace}
          >
            <IconLocate size={13} />
            <span className="filter-row-label">{t('当前工作区')}</span>
          </button>
          <SelectAll label={t('全选工作区')} selected={allWorkspaces} onClick={onSelectAllWorkspaces} />
          {workspaceOptions.map(option => (
            <FilterCheckbox key={option.id || 'unassigned'} label={option.label}
              checked={workspaceChecked(option.id)} onChange={() => onToggleWorkspace(option.id)} />
          ))}
        </div>
      </div>
      <div className="board-filter-section" role="group" aria-label={t('面板')}>
        <div className="board-filter-section-head">
          <strong>{t('面板')}</strong>
        </div>
        <div className="board-filter-options">
          <SelectAll label={t('全选面板')} selected={allPanels} onClick={onSelectAllPanels} />
          {panelOptions.map(option => (
            <FilterCheckbox key={option.id} label={option.label} color={PANEL_COLORS[option.id]}
              checked={panelChecked(option.id)} onChange={() => onTogglePanel(option.id)} />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
