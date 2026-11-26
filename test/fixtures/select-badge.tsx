/** 只验 CustomSelect 的右侧胶囊（运行方式的 GUI / TUI）与胶囊对比度：
 * 挂真实组件 + 生产样式，点开菜单后截图，不涉及 IPC。 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CustomSelect } from '@workbench/src/renderer/src/components/CustomSelect';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);

const options = [
  { value: 'cursor-cli', label: 'Cursor CLI', badge: 'TUI' },
  { value: 'claude-code', label: 'Claude Code', badge: 'TUI' },
  { value: 'pi', label: 'Pi', badge: 'GUI' },
  { value: 'codex', label: 'Codex', badge: 'GUI' },
  { value: 'acp', label: 'ACP', badge: 'GUI' }
];

function Fixture(): React.JSX.Element {
  const [value, setValue] = React.useState('codex');
  return (
    <div style={{ padding: 40, width: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="s-tag">开箱</span>
        <span className="s-tag">TUI</span>
        <span className="mcp-badge on">可用</span>
        <span className="mcp-badge warn">未安装</span>
        <span className="mcp-badge off">停用</span>
      </div>
      <CustomSelect ariaLabel="运行方式" menuClassName="task-options-menu" value={value} onChange={setValue} options={options} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
