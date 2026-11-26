/**
 * 独立浏览器页的标签栏列表（自 BrowserPage 抽出，行为保持）：
 * 行渲染（favicon/加载态/关闭钮）+ 多选（Ctrl/⌘ 点选、Shift 范围，横向轴）
 * + 右键菜单（关闭选中 N 个 / 关闭其他 / 关闭右侧）。
 * 激活与关闭的 IPC 由父级经 onActivate / onCloseMany 执行，本组件只管交互。
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserTabInfo } from '../../../shared/browser';
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from './ContextMenu';
import { useListSelection } from '../hooks/useListSelection';

export function BrowserTabList({ tabs, activeId, onActivate, onCloseMany }: {
  tabs: BrowserTabInfo[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onCloseMany: (ids: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [faviconBroken, setFaviconBroken] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<ContextMenuPoint & { id?: string } | null>(null);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const selection = useListSelection({ orderedIds: tabIds, axis: 'horizontal' });
  const target = tabs.find((tab) => tab.id === menu?.id) ?? null;
  const multiClose = Boolean(menu?.id && selection.isSelected(menu.id) && selection.selectedIds.size > 1);
  const items: ContextMenuItem[] = [
    ...(multiClose
      ? [{ id: 'close-selected', label: t('关闭选中的 {{n}} 个标签页', { n: selection.selectedIds.size }) }]
      : []),
    { id: 'close', label: t('关闭标签页'), disabled: !target },
    { id: 'others', label: t('关闭其他标签页'), disabled: !target || tabs.length < 2 },
    { id: 'right', label: t('关闭右侧标签页'), disabled: !target || tabs.at(-1)?.id === target.id }
  ];
  return (
    <div
      className="browser-tabbar-list"
      tabIndex={0}
      onKeyDown={(e) => {
        // Ctrl+A / Esc / Shift+←→（扩展选区；焦点不随动，激活仍靠 Enter/单击）
        selection.handleKeyDown(e, { currentId: activeId, onMoveFocus: () => {} });
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`browser-tab-item${tab.id === activeId ? ' is-active' : ''}${selection.isSelected(tab.id) ? ' is-multiselected' : ''}`}
          role="button"
          tabIndex={0}
          aria-selected={tab.id === activeId || selection.isSelected(tab.id)}
          title={tab.url}
          onClick={(e) => {
            if (selection.click(tab.id, e) !== 'plain') return;
            onActivate(tab.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onActivate(tab.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget, id: tab.id });
          }}
        >
          {tab.favicon && !faviconBroken[tab.id] ? (
            <img
              src={tab.favicon}
              alt=""
              className="browser-tab-favicon"
              onError={() => setFaviconBroken((m) => ({ ...m, [tab.id]: true }))}
            />
          ) : (
            <span className="browser-tab-favicon browser-tab-favicon-fallback" aria-hidden>
              •
            </span>
          )}
          <span className={`browser-tab-title${tab.loading ? ' is-loading' : ''}`}>
            {tab.title || tab.url}
          </span>
          <button
            type="button"
            className="git-btn ghost tiny browser-tab-close"
            title={t('关闭标签页')}
            onClick={(e) => {
              e.stopPropagation();
              onCloseMany([tab.id]);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          items={items}
          onClose={() => setMenu(null)}
          onSelect={(action) => {
            if (action === 'close-selected') {
              onCloseMany(tabIds.filter((id) => selection.isSelected(id)));
              selection.clear();
            } else if (action === 'close' && target) {
              onCloseMany([target.id]);
            } else if (action === 'others' && target) {
              onCloseMany(tabs.filter((tab) => tab.id !== target.id).map((tab) => tab.id));
            } else if (action === 'right' && target) {
              onCloseMany(tabs.slice(tabs.indexOf(target) + 1).map((tab) => tab.id));
            }
            setMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}
