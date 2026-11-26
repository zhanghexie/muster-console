/**
 * 右上角右栏开关的「收起前姿态」记忆（localStorage）：收起动作本身必须退专注/
 * 关 VS（Git 页随右栏隐藏），但折叠前是什么姿态（专注布局，或 VS 开且驻留哪页）
 * 要跨收起/展开周期保留，展开时原样恢复——否则展开总是「VS 开 + Git 页」，
 * 折叠前的驻留页/专注意愿丢失（2026-10-10 用户反馈「没有记忆」）。
 */
export type RightPanelRestore = { focus: boolean; dock: 'terminal' | 'git' };

const KEY = 'muster.rightPanelRestore.v1';
/** 旧版只记「收起前是专注」的布尔键；读取时迁移，保存时清除 */
const LEGACY_FOCUS_KEY = 'muster.rightPanelRestoreFocus.v1';

export function loadRightPanelRestore(): RightPanelRestore | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RightPanelRestore>;
      if (parsed && (parsed.dock === 'terminal' || parsed.dock === 'git')) {
        return { focus: parsed.focus === true, dock: parsed.dock };
      }
    }
    if (localStorage.getItem(LEGACY_FOCUS_KEY) === '1') return { focus: true, dock: 'git' };
  } catch {
    /* ignore */
  }
  return null;
}

export function saveRightPanelRestore(v: RightPanelRestore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
    localStorage.removeItem(LEGACY_FOCUS_KEY);
  } catch {
    /* ignore */
  }
}
