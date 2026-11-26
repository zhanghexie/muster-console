/**
 * 会话栏显隐偏好（全局 UI 偏好，存 localStorage——惯例同 hSwitchMode）。
 * 会话栏就是一个可折叠面板：open=文档流占位；折叠=不占布局，可经右上角开关
 * 或左缘热区速览唤回（见 docs/features/sessions-dock.md）。与专注模式完全解耦。
 */
const SESSIONS_OPEN_KEY = 'muster.sessionsOpen.v1';

export function loadSessionsOpen(): boolean {
  try {
    const v = localStorage.getItem(SESSIONS_OPEN_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* ignore */
  }
  return true;
}

export function saveSessionsOpen(open: boolean): void {
  try {
    localStorage.setItem(SESSIONS_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}
