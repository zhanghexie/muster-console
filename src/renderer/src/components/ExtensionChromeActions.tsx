import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtensionToolbarItem } from '../../../shared/extension';
import { useUiStore, useWorkspaceStore } from '../store';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { MOTION, usePresence } from './motion';
import { IconMore } from './icons';
import { ExtensionIcon } from '../extensionIcons';

function Action({ item, open, inMenu, busy, toggle, run }: { item: ExtensionToolbarItem; open: boolean; inMenu: boolean; busy: boolean; toggle: () => void; run: (menuId?: string) => void }): React.JSX.Element {
  const presence = usePresence(open, MOTION.menuMs), menu = item.menu ?? [];
  const trigger = useRef<HTMLButtonElement>(null), [alignRight, setAlignRight] = useState(false);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    setAlignRight(bounds.left + 180 > window.innerWidth - 8 && bounds.right >= 188);
  }, [open]);
  return <div className={inMenu ? 'chrome-ext-menu-row' : 'chrome-ext-btn-wrap'} data-ext-id={item.id}>
    <button ref={trigger} type="button" className={inMenu ? 'ui-menu-item chrome-ext-menu-item' : 'chrome-ext-btn'} title={`${item.name}${item.description ? ` — ${item.description}` : ''}`} disabled={busy}
      aria-haspopup={menu.length ? 'menu' : undefined} aria-expanded={menu.length ? open : undefined} onClick={() => menu.length ? toggle() : run()}>
      {inMenu && <ExtensionIcon className="chrome-ext-icon" value={item.icon} size={16} fallback={item.name.slice(0, 1)} />}<span className="chrome-ext-name">{item.name}</span>{menu.length > 0 && inMenu && <span className="chrome-ext-menu-caret">▸</span>}
    </button>
    {presence.mounted && menu.length > 0 && <div className={`chrome-ext-submenu ui-menu mp-pop${inMenu ? ' is-flyout' : ''}${alignRight ? ' is-right-aligned' : ''}`} role="menu" data-mp-stage={presence.stage} aria-hidden={!open} {...(!open ? { inert: '' as unknown as boolean } : {})}>
      {menu.map(option => <button key={option.id} type="button" role="menuitem" className="ui-menu-item chrome-ext-menu-item" disabled={busy} onClick={() => run(option.id)}><span className="chrome-ext-icon" aria-hidden>·</span><span className="chrome-ext-menu-label">{option.label}</span></button>)}
    </div>}
  </div>;
}

export function ExtensionChromeActions(): React.JSX.Element | null {
  const { t } = useTranslation(), { activeWorkspaceId } = useWorkspaceStore(), { flashTip } = useUiStore();
  const [toolbar, setToolbar] = useState<{ workspaceId: string; sourceRootId: string; selectionRevision: number; items: ExtensionToolbarItem[] } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false), [openId, setOpenId] = useState<string | null>(null), [busy, setBusy] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null), generation = useRef(0), currentWorkspace = useRef(activeWorkspaceId), flashRef = useRef(flashTip);
  currentWorkspace.current = activeWorkspaceId;
  flashRef.current = flashTip;
  const presence = usePresence(overflowOpen, MOTION.menuMs);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      const sequence = ++generation.current;
      setToolbar(null); setOverflowOpen(false); setOpenId(null);
      if (!activeWorkspaceId) return;
      void window.api.extensions.toolbar(activeWorkspaceId).then(value => {
        if (alive && sequence === generation.current && value.workspaceId === currentWorkspace.current) setToolbar(value);
      }).catch(error => { if (alive && sequence === generation.current) flashRef.current(String(error)); });
    };
    const stop = window.api.on('extensions:changed', refresh); refresh();
    return () => { alive = false; generation.current++; stop(); };
  }, [activeWorkspaceId]);
  useEffect(() => {
    if (!overflowOpen && !openId) return;
    const dismiss = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) { setOverflowOpen(false); setOpenId(null); } };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [overflowOpen, openId]);
  useOverlayDismiss(overflowOpen || !!openId, () => { setOverflowOpen(false); setOpenId(null); });

  const current = toolbar?.workspaceId === activeWorkspaceId ? toolbar : null;

  const busyKey = (item: ExtensionToolbarItem): string => JSON.stringify([current?.workspaceId, current?.sourceRootId, current?.selectionRevision, item.scope, item.id]);
  const run = async (item: ExtensionToolbarItem, menuId?: string): Promise<void> => {
    if (!current) return;
    const { workspaceId, sourceRootId, selectionRevision } = current;
    const { id: extensionId, scope, name } = item;
    const input = { workspaceId, sourceRootId, selectionRevision, extensionId, scope, ...(menuId ? { menuId } : {}) };
    const key = busyKey(item);
    setOverflowOpen(false); setOpenId(null); setBusy(values => [...values, key]);
    try {
      await window.api.extensions.runToolbar(input);
    } catch (error) {
      flashRef.current(t('{{name}}：{{error}}', { name, error: String(error) }));
    } finally {
      setBusy(values => values.filter(value => value !== key));
    }
  };
  const action = (item: ExtensionToolbarItem, inMenu = false): React.JSX.Element => {
    const id = `${item.scope}:${item.id}`;
    return <Action key={id} item={item} inMenu={inMenu} open={openId === id} busy={busy.includes(busyKey(item))} toggle={() => { if (!inMenu) setOverflowOpen(false); setOpenId(value => value === id ? null : id); }} run={menuId => void run(item, menuId)}/>;
  };
  const visible = current?.items.slice(0, 5) ?? [], overflow = current?.items.slice(5) ?? [];
  return visible.length > 0 ? <div className="chrome-ext-actions extension-chrome-ext-actions" ref={root}>
      {visible.map(item => action(item))}
      {overflow.length > 0 && <div className="chrome-ext-overflow"><button type="button" className="chrome-ext-btn" title={t('还有 {{n}} 个扩展动作', { n: overflow.length })} aria-haspopup="menu" aria-expanded={overflowOpen} onClick={() => { setOpenId(null); setOverflowOpen(value => !value); }}><IconMore/></button>
        {presence.mounted && <div className="chrome-ext-menu ui-menu mp-pop" data-mp-stage={presence.stage} role="menu" aria-hidden={!overflowOpen} {...(!overflowOpen ? { inert: '' as unknown as boolean } : {})}>{overflow.map(item => action(item, true))}</div>}
      </div>}
  </div> : null;
}
