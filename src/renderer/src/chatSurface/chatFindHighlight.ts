/**
 * 在已渲染的会话正文里包 <mark> 高亮。只扫 .chat-text / .md-body 文本节点，
 * 跳过思考卡 / 工具栈 / 审批提问卡。React 重渲会抹掉 mark，由调用方 useLayoutEffect 再刷。
 */

export const CHAT_FIND_MARK = 'chat-find-hit';

const SKIP_CLOSEST =
  'mark.chat-find-hit, script, style, .thinking-card, .tool-stack, .ac-approval, .user-question-card, .chat-hoverbar, .turn-fold, .msg-note-badge, .msg-note-bubble';

export function clearChatFindMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll(`mark.${CHAT_FIND_MARK}`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = (node as Text).parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest(SKIP_CLOSEST)) return NodeFilter.FILTER_REJECT;
      if (!el.closest('.chat-text, .md-body')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

export function applyChatFindMarks(
  root: HTMLElement,
  query: string,
  active?: { messageId: string; indexInMessage: number } | null
): HTMLElement | null {
  clearChatFindMarks(root);
  const q = query.trim();
  if (!q) return null;
  const needle = q.toLowerCase();
  const nodes = collectTextNodes(root);
  type Piece = { node: Text; start: number; end: number; messageId: string };
  const pieces: Piece[] = [];
  for (const node of nodes) {
    const wrap = node.parentElement?.closest<HTMLElement>('[data-mid]');
    const messageId = wrap?.dataset.mid ?? '';
    const raw = node.data;
    const lower = raw.toLowerCase();
    let from = 0;
    while (from < raw.length) {
      const hit = lower.indexOf(needle, from);
      if (hit < 0) break;
      pieces.push({ node, start: hit, end: hit + needle.length, messageId });
      from = hit + needle.length;
    }
  }

  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]!;
    const range = document.createRange();
    try {
      range.setStart(p.node, p.start);
      range.setEnd(p.node, p.end);
      const mark = document.createElement('mark');
      mark.className = CHAT_FIND_MARK;
      range.surroundContents(mark);
    } catch {
      /* surroundContents 遇跨节点选区会抛，跳过该片 */
    }
  }

  if (!active) return null;
  const marks = root.querySelectorAll<HTMLElement>(
    `[data-mid="${cssEscape(active.messageId)}"] mark.${CHAT_FIND_MARK}`
  );
  const el = marks[active.indexInMessage] ?? marks[0] ?? null;
  if (el) el.classList.add('is-active');
  return el;
}

function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  return id.replace(/"/g, '\\"');
}
