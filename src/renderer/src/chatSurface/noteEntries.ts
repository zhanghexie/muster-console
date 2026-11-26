/**
 * 会话批注三入口合同：正文角标、消息操作行「批注N」、输入框药丸。
 * 点外关气泡必须把这三处都当成「里面」——否则 mousedown 先关、click 再开，
 * 操作行无法收起、输入框药丸刚打开就被同一轮 document 监听掐死。
 * 锚点 span（.msg-note-anchor）是量位/高亮用的易失 DOM，不是开气泡的前提。
 */

/** 三入口与气泡本身：点下去不算点外 */
export function isSessionNoteEntryTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return !!el.closest('[data-note-entry], .msg-note-bubble');
}

/**
 * 待录入气泡（create 模式）本身是编辑面：点输入框聚焦、点 ✓ 保存都发生在这里，
 * mousedown 若当「入口/点外」处理会先取消 pending，click 落空保存必失败——
 * 必须最先豁免（回归 test/unit/chat-note-entries.spec.tsx「待录入气泡」节）。
 */
export function isSessionNotePendingTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return !!el.closest('[data-note-pending]');
}

/** 跳到批注：优先文字锚点（闪一下），锚点被折叠/重挂卸掉则滚到所属消息 */
export function revealNoteInView(
  root: ParentNode | null | undefined,
  args: { noteId: string; messageId?: string }
): void {
  if (!root) return;
  const anchor = root.querySelector<HTMLElement>(
    `.msg-note-anchor[data-note-id="${args.noteId}"]`
  );
  if (anchor) {
    anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    anchor.classList.add('is-flash');
    window.setTimeout(() => anchor.classList.remove('is-flash'), 1500);
    return;
  }
  if (!args.messageId) return;
  root
    .querySelector<HTMLElement>(`[data-mid="${args.messageId}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
