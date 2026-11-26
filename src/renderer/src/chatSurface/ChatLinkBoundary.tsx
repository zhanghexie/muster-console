import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextMenuPoint } from '../components/ContextMenu';
import { isWebGateway } from '../webGatewayEnvironment';
import { parseChatFileTarget, resolveChatFilePath } from './onFileLink';
import { ChatLinkOwnerContext } from './chatLinkOwner';

type Menu = ContextMenuPoint & { target: string; kind: 'web' | 'file' };

function targetFromEvent(event: React.MouseEvent<HTMLDivElement>): { element: HTMLElement; target: string } | null {
  if (!(event.target instanceof Element)) return null;
  const element = event.target.closest<HTMLElement>('[data-chat-link-target]');
  const target = element?.dataset.chatLinkTarget;
  return element && target && event.currentTarget.contains(element) ? { element, target } : null;
}

/** The boundary only owns conversation links; other Markdown readers retain their routing. */
export function ChatLinkBoundary({ children, cwd, workspaceId, sessionId, active, onFileLink, flashTip, showWorkspace }: {
  children: React.ReactNode;
  cwd?: string;
  workspaceId?: string;
  sessionId?: string;
  active: boolean;
  onFileLink: (href: string) => void;
  flashTip: (text: string) => void;
  showWorkspace: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<Menu | null>(null);
  const owner = useMemo(() => ({ workspaceId, sessionId, scope: 'session' as const }), [workspaceId, sessionId]);
  useEffect(() => { setMenu(null); }, [cwd, workspaceId, sessionId, active]);

  const openWeb = async (url: string): Promise<void> => {
    try {
      await window.api.browser.open({ url, ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}), scope: 'session' });
      showWorkspace();
    } catch (error) {
      flashTip(String(error));
    }
  };

  const openSystem = async (target: Menu, action: string): Promise<void> => {
    try {
      if (target.kind === 'web') {
        const result = await window.api.shell.openExternal(target.target);
        if (!result.ok) flashTip(result.error || t('无法打开链接'));
        return;
      }
      const parsed = parseChatFileTarget(target.target);
      const path = parsed && resolveChatFilePath(parsed.path, cwd);
      if (!path) { flashTip(t('无法确定文件路径')); return; }
      const result = action === 'reveal' ? await window.api.shell.revealPath(path) : await window.api.shell.openPath(path);
      if (!result.ok) flashTip(result.error || t('无法打开文件'));
    } catch (error) {
      flashTip(String(error));
    }
  };

  const openAnchor = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!active || isWebGateway()) return;
    const hit = targetFromEvent(event);
    // Inline images keep their lightbox, including when nested in a Markdown link.
    if (!hit || hit.element.tagName !== 'A' || !/^https?:\/\//i.test(hit.target)) return;
    event.preventDefault();
    event.stopPropagation();
    void openWeb(hit.target);
  };

  return <div style={{ display: 'contents' }} data-right-link-scope="session" data-right-link-workspace={workspaceId} data-right-link-session={sessionId}
    onClickCapture={openAnchor}
    onAuxClickCapture={event => { if (event.button === 1) openAnchor(event); }}
    onContextMenuCapture={event => {
      if (!active || isWebGateway()) return;
      const source = targetFromEvent(event);
      if (!source) return;
      const { element: anchor, target } = source;
      const kind = /^https?:\/\//i.test(target) ? 'web' : parseChatFileTarget(target) ? 'file' : null;
      if (!kind) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, anchor, target, kind });
    }}>
    <ChatLinkOwnerContext.Provider value={owner}>{children}</ChatLinkOwnerContext.Provider>
    {menu ? <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} onClose={() => setMenu(null)}
      items={menu.kind === 'web'
        ? [{ id: 'inside', label: t('在内置浏览器中打开') }, { id: 'system', label: t('在系统浏览器中打开') }]
        : [{ id: 'inside', label: t('在工作台中打开') }, { id: 'system', label: t('在系统默认应用中打开') }, { id: 'reveal', label: t('在文件管理器中显示') }]}
      onSelect={action => {
        if (action === 'inside') {
          if (menu.kind === 'web') void openWeb(menu.target);
          else onFileLink(menu.target);
        } else {
          void openSystem(menu, action);
        }
      }} /> : null}
  </div>;
}
