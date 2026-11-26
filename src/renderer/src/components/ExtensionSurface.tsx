import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../shared/i18n';
import { PeekPointerShield } from './PeekPointerShield';

// App supplies the actual virtual-screen state, independently of utility-layer
// visibility. Side-by-side/focus layouts keep this false and retain native interaction.
export const ExtensionHomePeekContext = createContext(false);

// One DOM owner per navigation entry. Moving the connected portal host with
// moveBefore preserves the iframe browsing context, including unsaved drafts.
const targets = new Map<string, HTMLElement>();
const returners = new Map<string, (onlyNew: boolean) => (() => void) | undefined>();
const listeners = new Set<() => void>();
export const extensionSurfaceKey = (workspaceId: string, nodeId: string): string => JSON.stringify([workspaceId, nodeId]);
/** Move the live iframe home before the right-hand host can be unmounted. */
export function prepareExtensionSurfaceReturn(surfaceKey: string, onlyNew = false): (() => void) | undefined {
  return returners.get(surfaceKey)?.(onlyNew);
}
export function ExtensionTabHost({ surfaceKey, peek = false }: { surfaceKey: string; peek?: boolean }): React.JSX.Element {
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element) targets.set(surfaceKey, element); else targets.delete(surfaceKey);
    listeners.forEach(listener => listener());
  }, [surfaceKey]);
  // The iframe consumes guest events; the retained portal still bubbles through
  // its left-side React owner. Keep the peek hit target in the right screen tree.
  return <><div className="extension-tab-host" ref={ref}/>{peek && <PeekPointerShield className="extension-tab-peek"/>}</>;
}

export function ExtensionSurface({ surfaceKey, inTab, children, onError }: {
  surfaceKey?: string; inTab: boolean; children: React.ReactNode; onError: (message: string) => void;
}): React.JSX.Element {
  const home = useRef<HTMLDivElement>(null);
  const homePeek = useContext(ExtensionHomePeekContext);
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'extension-surface'; return element; });
  const [moved, setMoved] = useState(false);
  const returning = useRef(false);
  const rollbackReturn = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    if (!surfaceKey) return;
    const prepare = (onlyNew: boolean): (() => void) | undefined => {
      if (returning.current) return onlyNew ? undefined : rollbackReturn.current;
      const destination = home.current, previous = host.parentElement;
      if (!destination || !previous || previous === destination) return undefined;
      const moveBefore = (destination as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
      if (!destination.isConnected || !host.isConnected || !moveBefore) throw new Error(t('无法保留扩展页面并移动，请重试或保持当前页面位置'));
      try { moveBefore.call(destination, host, null); }
      catch { throw new Error(t('无法保留扩展页面并移动，请重试或保持当前页面位置')); }
      returning.current = true;
      setMoved(false);
      const rollback = (): void => {
        const restore = (previous as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
        if (!previous.isConnected || !host.isConnected || !restore) throw new Error(t('无法保留扩展页面并移动，请重试或保持当前页面位置'));
        restore.call(previous, host, null);
        returning.current = false;
        rollbackReturn.current = undefined;
        setMoved(true);
      };
      rollbackReturn.current = rollback;
      return rollback;
    };
    returners.set(surfaceKey, prepare);
    return () => { if (returners.get(surfaceKey) === prepare) returners.delete(surfaceKey); };
  }, [host, surfaceKey]);
  useLayoutEffect(() => {
    const move = (): void => {
      if (!inTab) { returning.current = false; rollbackReturn.current = undefined; }
      const target = inTab && !returning.current && surfaceKey ? targets.get(surfaceKey) : undefined;
      const destination = target ?? home.current;
      if (!destination) return;
      if (host.parentElement === destination) { setMoved(!!target); return; }
      if (host.isConnected && destination.isConnected) {
        const moveBefore = (destination as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
        if (!moveBefore) { onError(t('当前浏览器不支持保留扩展页面的跨屏移动，请升级浏览器或使用桌面应用')); return; }
        try { moveBefore.call(destination, host, null); }
        catch { onError(t('无法保留扩展页面并移动，请重试或保持当前页面位置')); return; }
      } else destination.appendChild(host);
      setMoved(!!target);
    };
    move(); listeners.add(move);
    return () => { listeners.delete(move); };
  }, [host, surfaceKey, inTab, onError]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return <><div className="extension-surface-home" ref={home} style={moved ? { display: 'none' } : undefined}/>{homePeek && !inTab && <PeekPointerShield className="extension-home-peek"/>}{createPortal(children, host)}</>;
}
