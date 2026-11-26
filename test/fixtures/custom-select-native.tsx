import '../../.agents/skills/ui-verification/assets/fixture-api';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { CustomSelect } from '@workbench/src/renderer/src/components/CustomSelect';
import { TooltipHost } from '@workbench/src/renderer/src/components/Tooltip';
import { KeybindingProvider, useOverlayDismiss } from '@workbench/src/renderer/src/keybindings/KeybindingHost';
import { closeTopOverlay } from '@workbench/src/renderer/src/keybindings/overlayStack';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
const query = new URLSearchParams(location.search);
applyTheme(builtinTheme(query.get('theme') === 'light' ? 'light' : 'dark')!);
const options = Array.from({ length: 20 }, (_, i) => ({ value: String(i + 1), label: `工作区 ${i + 1}`, disabled: i === 18, group: i < 10 ? '团队' : '个人' }));
function Fixture() {
  const [value, setValue] = useState('15');
  const [permission, setPermission] = useState('safe');
  const [enabled, setEnabled] = useState(true);
  const [closed, setClosed] = useState(0);
  const [changes, setChanges] = useState(0);
  useOverlayDismiss(true, () => setClosed(n => n + 1));
  return <main style={{ minHeight: '100vh', padding: 16, background: 'var(--surface-canvas)', color: 'var(--fg-primary)' }}>
    <TooltipHost />
    <h1>主题下拉</h1>
    <button className="btn" onClick={() => setEnabled(!enabled)}>切换可用</button>
    <button className="btn" onClick={() => closeTopOverlay()}>关闭顶层</button>
    <output data-testid="value">{value}</output><output data-testid="changes">{changes}</output><output data-testid="closed">{closed}</output>
    <section style={{ maxWidth: 360, marginTop: 12 }}>
      <label htmlFor="workspace">工作区</label>
      <CustomSelect id="workspace" ariaLabel="工作区" value={value} options={options} menuEnabled={enabled}
        onChange={next => { setValue(next); setChanges(n => n + 1); }} />
      <button className="btn">后一个控件</button>
      <label htmlFor="permission">权限</label>
      <CustomSelect id="permission" ariaLabel="权限" value={permission} onChange={setPermission}
        menuClassName="task-permission-menu" options={[
          { value: 'safe', label: '安全执行', description: '允许读取文件，修改前需要确认。', icon: <span>◈</span>, badge: 'GUI' },
          { value: 'full', label: '完全访问', description: '允许修改工作区文件并执行命令。', icon: <span>◇</span>, badge: 'TUI' },
          { value: 'offline', label: '暂不可用', description: '服务离线', disabled: true }
        ]} />
      <label htmlFor="compact">紧凑权限</label>
      <CustomSelect id="compact" ariaLabel="紧凑权限" value={permission} onChange={setPermission}
        menuClassName="task-permission-menu" detailsAsTooltip options={[
          { value: 'safe', label: '安全执行', description: '允许读取文件，修改前需要确认。' },
          { value: 'full', label: '完全访问', description: '允许修改工作区文件并执行命令。' }
        ]} />
    </section>
    <section style={{ position: 'fixed', bottom: 12, left: 16, right: 16, maxWidth: 360, overflow: 'hidden' }}>
      <label htmlFor="path">运行位置</label>
      <CustomSelect id="path" ariaLabel="运行位置" value="a" onChange={() => {}}
        menuClassName="task-source-menu" className="task-path-select" options={[
          { value: 'a', label: '/workspace/projects/very-long-directory-name/项目甲/source' },
          { value: 'b', label: '/workspace/projects/another-long-directory-name/项目乙/packages/renderer' },
          { value: 'c', label: '/workspace/shared/project' }
        ]} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<KeybindingProvider><Fixture /></KeybindingProvider>);
