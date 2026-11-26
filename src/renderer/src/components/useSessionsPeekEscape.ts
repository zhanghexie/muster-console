import { useEffect } from 'react';

/** 全局快捷键层可能在冒泡阶段吞掉 Escape，速览需先在捕获阶段处理。 */
export function useSessionsPeekEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 让位更高层浮层（sessions-dock F-04 / keybindings F-05）：速览在场时再开
      // 设置弹窗/确认框等，注册更早的 capture Esc（overlay 栈）已 preventDefault
      // 关掉栈顶——此时速览不得跟着一起收，只关一层。
      if (e.defaultPrevented) return;
      const el = e.target;
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
}
