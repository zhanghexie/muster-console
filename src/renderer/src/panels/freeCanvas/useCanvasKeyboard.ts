/**
 * 自由视图画布 · 键盘手势：Space 平移态、Delete/Backspace 删选集、Ctrl+G 打组、
 * Ctrl+Shift+D 解散（原 Ctrl+Shift+G 与 keybindings 目录 globalBoard.toggle 默认键相撞：
 * KeybindingHost 在 window capture 阶段先吞事件，画布 bubble 监听收不到——board-free-view
 * F-01 / keybindings F-02 换键；画布自管键须避开目录默认键，新增前对照
 * src/shared/keybindings.ts 的 defaultChord 清单）、Ctrl+A 全选、Ctrl+Shift+L 自动布局。
 * window 级监听，active 为假（切回状态视图）时全部停用。
 * 从 FreeCanvas.tsx 原样拆出；输入态（input/textarea/contentEditable）不接管。
 */
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

export interface CanvasKeyboardOptions {
  active: boolean;
  deleteSelection: () => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  itemIds: string[];
  stickyIds: string[];
  runAutoArrange: () => void;
  setSelNodes: Dispatch<SetStateAction<string[]>>;
  setSelEdges: Dispatch<SetStateAction<string[]>>;
  setSelGroups: Dispatch<SetStateAction<string[]>>;
}

export function useCanvasKeyboard(options: CanvasKeyboardOptions): {
  spaceRef: RefObject<boolean>;
  spaceDown: boolean;
} {
  const {
    active,
    deleteSelection,
    groupSelection,
    ungroupSelection,
    itemIds,
    stickyIds,
    runAutoArrange,
    setSelNodes,
    setSelEdges,
    setSelGroups
  } = options;
  const spaceRef = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);

  useEffect(() => {
    if (!active) return;
    const isTyping = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTyping(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          setSpaceDown(true);
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        // 解散组用 Ctrl+Shift+D：Ctrl+Shift+G 让给 globalBoard.toggle（见文件头注释）
        e.preventDefault();
        ungroupSelection();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        groupSelection();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelNodes([...itemIds, ...stickyIds]);
        setSelEdges([]);
        setSelGroups([]);
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        runAutoArrange();
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [active, deleteSelection, groupSelection, ungroupSelection, itemIds, stickyIds, runAutoArrange, setSelNodes, setSelEdges, setSelGroups]);

  return { spaceRef, spaceDown };
}
