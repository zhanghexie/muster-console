import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { isOverlayPageSwitch, useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';
import { MOTION, usePresenceValue } from './motion';
import { SelectionBar } from './SelectionBar';
import { SelectionBangOverlay } from './SelectionBangOverlay';
import { buildSelectionItems, type SelectionMenuServices } from './selectionMenuAreas';
import { refreshTextTools } from './textToolsClient';
import type { TextToolFunction } from '../../../shared/types';
import {
  closeSelectionBang,
  dismissSelectionMenu,
  readSelectionUi,
  showSelectionMenu,
  subscribeSelectionUi,
  syncSelectionMenuToLiveSelection
} from './selectionMenuController';
import { isInsideOverlay } from '../keybindings/overlayStack';
import { PANEL_CLEAR_SELECTION_EVENT, PANEL_SELECTION_EVENT } from '../../../shared/panelRelay';
import { useUiStore, useWorkspaceStore, useSessionStore, useRuntimesStore } from '../store';
import { runtimeSurface } from '../../../shared/types';
import type { ChatLinkOwner } from '../chatSurface/chatLinkOwner';

/**
 * 全局划词菜单唯一宿主：全应用只挂载一次（App 根部），负责
 * - DOM 选区触发源（document mouseup + window.getSelection；终端标记 data-sel-native 自管，跳过）
 * - 渲染划词浮条与「爆炸」浮层，共用一个控制器状态
 */
export function SelectionMenuHost(): React.JSX.Element | null {
  const { flashTip, requestComposerInsert, requestOpenWorkspaceFile } = useUiStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const { sessions, activeId } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const ui = useSyncExternalStore(subscribeSelectionUi, readSelectionUi);
  const [textTools, setTextTools] = useState<TextToolFunction[]>([]);

  // 活动会话带出（文件区划词「批注」的投递目标）：GUI/CLI Agent 进工作台输入框，
  // 普通 Shell 粘贴到终端；其余（定时任务/未选中）不可批注。
  const activeSession = useMemo(() => {
    const s = sessions.find((x) => x.id === activeId);
    if (!s || s.type !== 'terminal') return null;
    const entry = s.runtime ? runtimes.find((r) => r.id === s.runtime) : undefined;
    return runtimeSurface(entry) === 'chat'
      ? { kind: 'chat' as const, id: s.id, name: s.name }
      : { kind: 'terminal' as const, id: s.id, name: s.name };
  }, [sessions, activeId, runtimes]);

  // 挂载时预取 + 每次浮条打开时刷新：设置里改完功能，下次划词即生效
  const menuOpen = ui.menu != null;
  const menuState = usePresenceValue(ui.menu, MOTION.microMs);
  useDismissOnPagePeek(menuOpen, ui.menu?.anchorElement ?? null, dismissSelectionMenu);
  useEffect(() => {
    let cancelled = false;
    void refreshTextTools().then((tt) => {
      if (!cancelled) setTextTools(tt.functions.filter((f) => f.enabled !== false));
    });
    return () => {
      cancelled = true;
    };
  }, [menuOpen]);

  // DOM 区域统一用当前工作区根解析相对路径；终端用会话 cwd（经 context 传入）
  const domCwd = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId)?.path,
    [workspaces, activeWorkspaceId]
  );

  const services = useMemo<SelectionMenuServices>(
    () => ({
      tip: flashTip,
      insertComposer: requestComposerInsert,
      openFile: requestOpenWorkspaceFile
    }),
    [flashTip, requestComposerInsert, requestOpenWorkspaceFile]
  );

  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      if (isOverlayPageSwitch(readSelectionUi().menu?.anchorElement ?? null, e.target)) return;
      const t = e.target instanceof Element ? e.target : null;
      if (isInsideOverlay(e.target)) return;
      // 终端自管选区（xterm canvas 上无 DOM 选区），交给 TerminalView 上报
      if (t?.closest('[data-sel-native]')) return;
      if (t?.closest('input, textarea')) return;
      // 可编辑区（contenteditable）不弹；除非被标成 data-sel-area（CodeMirror 预览/编辑态都要弹）
      const ce = t?.closest('[contenteditable="true"]');
      if (ce && !ce.closest('[data-sel-area]')) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (!sel || sel.isCollapsed || !text.trim()) {
        dismissSelectionMenu();
        return;
      }
      const area = t?.closest('[data-sel-area]')?.getAttribute('data-sel-area') || 'default';
      // 会话区带 data-sel-cwd（GUI 会话 cwd）：相对路径按会话 cwd 解析，
      // 与链接点击（onFileLink）同源；其它 DOM 区域退回工作区根（domCwd）
      const selCwd = t?.closest('[data-sel-cwd]')?.getAttribute('data-sel-cwd');
      const linkSource = t?.closest<HTMLElement>('[data-right-link-scope]');
      const linkScope = linkSource?.dataset.rightLinkScope;
      const rightOwner: ChatLinkOwner | undefined = linkScope === 'workspace' || linkScope === 'session' ? {
        scope: linkScope, workspaceId: linkSource?.dataset.rightLinkWorkspace, sessionId: linkSource?.dataset.rightLinkSession
      } : undefined;
      showSelectionMenu({
        source: 'dom',
        area,
        text,
        anchor: { x: e.clientX, y: e.clientY },
        anchorElement: t ?? undefined,
        context: selCwd || rightOwner ? { ...(selCwd ? { cwd: selCwd } : {}), ...(rightOwner ? { rightOwner } : {}) } : undefined
      });
      syncSelectionMenuToLiveSelection(sel);
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (isInsideOverlay(e.target)) return;
      if (isOverlayPageSwitch(readSelectionUi().menu?.anchorElement ?? null, e.target)) return;
      dismissSelectionMenu();
    };

    // 任意按键收起（对齐终端：选区内按键即清）；纯修饰键除外
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
      dismissSelectionMenu();
    };

    // 选区仍在则跟手重锚定；塌了（中间会话刷新换节点）不收——外点/按键才关
    const onSelectionChange = (): void => syncSelectionMenuToLiveSelection();
    const onViewportChange = (): void => syncSelectionMenuToLiveSelection();
    const onContextMenu = (): void => dismissSelectionMenu();

    // 沙箱面板（扩展/HTML 预览）guest 内的划词：guest postMessage 上报，
    // 宿主按来源 iframe 的视口位置换算锚点后走同一全局菜单（区域=default）。
    const onPanelSelection = (event: MessageEvent): void => {
      const data = event.data as { __ma?: boolean; type?: string; text?: string; x?: number; y?: number } | null;
      if (!data || data.__ma !== true || data.type !== PANEL_SELECTION_EVENT) return;
      let iframe: HTMLIFrameElement | null = null;
      for (const candidate of document.querySelectorAll('iframe')) {
        if (candidate.contentWindow === event.source) { iframe = candidate; break; }
      }
      if (!iframe) return;
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text.trim()) { dismissSelectionMenu('panel-guest'); return; }
      const rect = iframe.getBoundingClientRect();
      const guest = iframe;
      showSelectionMenu({
        source: 'dom',
        area: 'default',
        owner: 'panel-guest',
        text,
        anchor: { x: rect.left + (typeof data.x === 'number' ? data.x : 0), y: rect.top + (typeof data.y === 'number' ? data.y : 0) },
        anchorElement: iframe,
        context: { clearSelection: () => guest.contentWindow?.postMessage({ __ma: true, type: PANEL_CLEAR_SELECTION_EVENT }, '*') }
      });
    };
    window.addEventListener('message', onPanelSelection);

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('contextmenu', onContextMenu);
    // capture：内层滚动（chat-list / 编辑器）也跟手，不再一律 dismiss
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('message', onPanelSelection);
      window.removeEventListener('scroll', onViewportChange, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onViewportChange);
    };
  }, []);

  const menu = menuState.value;
  if (!menu && !ui.bang) return null;

  return createPortal(
    <>
      {menu ? (
        <SelectionBar
          text={menu.text}
          anchor={menu.anchor}
          anchorElement={menu.anchorElement}
          retiring={!menuOpen}
          hidden={menu.hidden}
          items={buildSelectionItems(menu.area, {
            text: menu.text,
            cwd: menu.context?.cwd ?? domCwd,
            context: menu.context,
            services,
            textTools,
            activeSession
          })}
          dragCwd={menu.context?.cwd ?? domCwd}
          dismiss={() => dismissSelectionMenu()}
          clearSelection={() => {
            if (menu.context?.clearSelection) {
              menu.context.clearSelection();
              return;
            }
            window.getSelection()?.removeAllRanges();
          }}
          onAfterAction={() => menu.context?.keepFocus?.()}
        />
      ) : null}
      {ui.bang ? (
        <SelectionBangOverlay state={ui.bang} services={services} onClose={closeSelectionBang} />
      ) : null}
    </>,
    document.body
  );
}
