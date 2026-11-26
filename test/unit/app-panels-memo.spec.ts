/**
 * App 大面板 memo 契约（2026-09-15 卡顿普查回归）：
 * 普查发现 App 根组件每次面板开/合重渲 3-5 次，而这些面板未 memo，CenterPanel
 * 常驻的全部会话 ChatSurface（真机 26 个实例）跟着级联重渲（设置开关累计长任务
 * 1.24s、命令面板 1.3s）。契约：六大面板必须保持 React.memo 包装——App 级渲染
 * 不得级联进面板子树。若某面板被重构回裸导出函数，本用例转红。
 * （配套的 props 稳定化在 App.tsx：onCloseUtilityPanel 等 5 个回调已 useCallback。）
 */
import { describe, it, expect } from 'vitest';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { CenterPanel } from '../../src/renderer/src/panels/CenterPanel';
import { SideToolsPanel } from '../../src/renderer/src/panels/SideToolsPanel';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { AgentChatView } from '../../src/renderer/src/agentChat/AgentChatView';
import { ChromeBar } from '../../src/renderer/src/components/ChromeBar';


describe('App 大面板 memo 契约（性能回归）', () => {
  const panels: Array<[string, unknown]> = [
    ['LeftPanel', LeftPanel],
    ['CenterPanel', CenterPanel],
    ['SideToolsPanel', SideToolsPanel],
    ['AgentFloat', AgentFloat],
    ['AgentChatView', AgentChatView],
    ['ChromeBar', ChromeBar]
  ];

  it.each(panels)('%s 保持 React.memo 包装', (_name, Cmp) => {
    expect((Cmp as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});
