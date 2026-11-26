/**
 * 网页批注二次编辑单例控制器：输入框里的「批注N」胶囊点击（web 锚）→ 这里开卡，
 * 宿主组件（WebNoteEntryHost，App 根部常驻）弹编辑卡（元素截图+备注，改/删）。
 * 保存/删除经 noteBridge 的 FileNoteEditor 通道回写会话批注（与文件批注同一路由）。
 * 与 fileNoteEntry 同配方：模块级单例状态 + 订阅，无 React 依赖。
 */

export interface WebNoteEditState {
  nonce: number;
  sessionId: string;
  noteId: string;
  web: { label: string; selector: string; url: string; shot: string };
  initialNote: string;
}

let state: WebNoteEditState | null = null;
const listeners = new Set<() => void>();

function emit(next: WebNoteEditState | null): void {
  state = next;
  for (const fn of listeners) fn();
}

export function subscribeWebNoteEdit(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readWebNoteEdit(): WebNoteEditState | null {
  return state;
}

export function openWebNoteEdit(payload: Omit<WebNoteEditState, 'nonce'>): void {
  emit({ ...payload, nonce: Date.now() });
}

export function closeWebNoteEdit(): void {
  emit(null);
}
