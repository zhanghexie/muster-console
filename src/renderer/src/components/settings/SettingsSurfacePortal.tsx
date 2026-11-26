import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Move one settings subtree between trusted hosts without creating a second draft. */
export function SettingsSurfacePortal({ target, children, onAttached }: {
  target: HTMLElement | null;
  children: React.ReactNode;
  onAttached?: (host: HTMLElement) => void;
}): React.JSX.Element {
  const attachedRef = useRef(onAttached);
  attachedRef.current = onAttached;
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'settings-surface-host';
    element.style.display = 'contents';
    return element;
  });
  useLayoutEffect(() => {
    if (!target) { host.remove(); return; }
    if (host.parentElement === target) return;
    const moveBefore = (target as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
    if (moveBefore && host.isConnected && target.isConnected) {
      try { moveBefore.call(target, host, null); attachedRef.current?.(host); return; } catch { /* fall back when moving across unsupported roots */ }
    }
    target.appendChild(host);
    attachedRef.current?.(host);
  }, [host, target]);
  useLayoutEffect(() => () => { host.remove(); }, [host]);
  return createPortal(children, host);
}
