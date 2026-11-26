/**
 * GitPanel 垫片（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * 实现体迁至 gitpanel/GitPanelCore.tsx；本文件保留原 import 路径再导出，
 * SideToolsPanel 的 lazy import 与 GitPanelHandle 类型引用不受影响。
 * 源码文本合同跟随实现位置：workspace.json 持久化接线断言现读 gitpanel/useGitPrefs.ts
 * 与本文件（test/workspace-ui-persist.mjs）。
 */
export { GitPanelCore as GitPanel, type GitPanelHandle } from './gitpanel/GitPanelCore';
