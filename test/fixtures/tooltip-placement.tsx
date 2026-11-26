import React from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipHost } from '@workbench/src/renderer/src/components/Tooltip';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const long = '查看当前工作区的提交历史与分支变化，包含提交说明、文件路径和对应修改。'.repeat(4);
function App() {
  return <main style={{ height: '100vh', background: 'var(--surface-canvas)', color: 'var(--fg-primary)' }}>
    <TooltipHost />
    <div className="toolbar" style={{ position: 'absolute', top: 100, left: 16, display: 'flex', gap: 4 }}>
      <button>main ▾</button><button>origin/main ↑0</button>
      <button id="history" title="历史">◷</button><button id="neighbor">⑂</button><button>↻</button>
    </div>
    <p style={{ position: 'absolute', top: 170, left: 16 }}>工作区内容 · 提示应避开同排工具按钮</p>
    <button id="top" title="上方不足时显示在下方" style={{ position: 'absolute', top: 8, right: 8 }}>顶部</button>
    <button id="edge" title={long} style={{ position: 'absolute', top: 310, right: 8 }}>长提示</button>
    <button id="bottom" title="底部提示保持在上方" style={{ position: 'absolute', bottom: 8, left: 8 }}>底部</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
