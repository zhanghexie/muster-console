import '../../.agents/skills/ui-verification/assets/fixture-api';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ContextMenu } from '@workbench/src/renderer/src/components/ContextMenu';
import { CustomSelect } from '@workbench/src/renderer/src/components/CustomSelect';
import { TooltipHost } from '@workbench/src/renderer/src/components/Tooltip';
import { KeybindingProvider } from '@workbench/src/renderer/src/keybindings/KeybindingHost';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);

const options = Array.from({ length: 20 }, (_, index) => ({ value: String(index + 1), label: `工作区 ${index + 1}` }));
const menuItems = [{ id: 'move', label: '移动到', children: [
  { id: 'unavailable', label: '离线工作区', disabled: true },
  { id: 'archive', label: '归档工作区' },
  { id: 'shared', label: '共享工作区' }
] }];

function Fixture(): React.JSX.Element {
  const [value, setValue] = useState('15');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return <KeybindingProvider>
    <TooltipHost />
    <main style={{ minHeight: '100vh', padding: '40px 16px', background: 'var(--surface-canvas)', color: 'var(--fg-primary)' }}>
      <h1>工作区操作</h1>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <CustomSelect ariaLabel="选择工作区" value={value} onChange={setValue} options={options} />
        <button type="button" className="btn" title="当前工作区仍有未提交的更改">工作区状态</button>
        <button type="button" className="btn" onClick={({ currentTarget }) => {
          const { left, bottom } = currentTarget.getBoundingClientRect();
          setMenu({ x: left, y: bottom });
        }}>工作区菜单</button>
      </div>
      {menu ? <ContextMenu {...menu} items={menuItems} onClose={() => setMenu(null)} onSelect={() => setMenu(null)} /> : null}
    </main>
  </KeybindingProvider>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
