// Production components/theme, with isolated IPC/clipboard. No real sessions or app data.
import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { Segmented } from '@workbench/src/renderer/src/components/settings/shared';
import { ChatHoverbar } from '@workbench/src/renderer/src/components/ChatMessageView';
import { MarkdownBody } from '@workbench/src/renderer/src/components/MarkdownBody';
import { IconMore } from '@workbench/src/renderer/src/components/icons';
import {
  setInteractionPreferences, useInteractionPreferences
} from '@workbench/src/renderer/src/interactionPreferences';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ChatMessage } from '@workbench/src/shared/types';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
setInteractionPreferences({ scrollFeel: 'native', scrollDistance: 1, motion: 'system' });
const diagnostics = { clipboardWrites: [] as string[], rejectClipboard: false };
Object.assign(window, { __interactionMotion: diagnostics });
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string): Promise<void> => {
    if (diagnostics.rejectClipboard) throw new Error('fixture clipboard denied');
    diagnostics.clipboardWrites.push(text);
  } }
});
const message: ChatMessage = {
  id: 'interaction-motion-message', role: 'assistant', createdAt: 1,
  content: '复制这段说明，确认成功反馈不改变旁边时间与按钮位置。'
};
const options = [
  { value: 'short', label: '短' },
  { value: 'long', label: '较长标签' },
  { value: 'last', label: '末项' }
];

function Fixture() {
  const preferences = useInteractionPreferences();
  const [focused, setFocused] = React.useState<string | null>(null);
  const [value, setValue] = React.useState('short');
  const [mounted, setMounted] = React.useState(false);
  const [visible, setVisible] = React.useState(true);
  const [drop, setDrop] = React.useState('');
  const [clipboardFailure, setClipboardFailure] = React.useState(false);
  const activate = (id: string) => ({
    onClick: () => setFocused(id),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocused(id); }
    }
  });
  return <main className="interaction-motion-fixture">
    <style>{`
      .interaction-motion-fixture { height:100vh; overflow:auto; box-sizing:border-box; padding:16px; display:flex; flex-direction:column; gap:14px; background:var(--surface-frame); color:var(--fg-primary); }
      .interaction-motion-fixture h1 { font-size:var(--font-title); font-weight:500; }
      .interaction-motion-fixture h2 { font-size:var(--font-control); font-weight:500; margin:0 0 10px; }
      .interaction-motion-fixture p { font-size:var(--font-ui); line-height:1.5; margin:0 0 8px; }
      .interaction-fixture-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:var(--font-ui); }
      .interaction-fixture-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:14px; }
      @media (min-width:650px) { .interaction-fixture-grid { grid-template-columns:minmax(0,1fr) minmax(0,1fr); } }
      .interaction-fixture-panel { min-width:0; padding:12px; border:1px solid var(--border-subtle); border-radius:var(--radius-card); background:var(--surface-canvas); }
      .interaction-fixture-panel .left-panel { height:auto; }
      .interaction-fixture-panel .settings-tabpane { padding:6px 0; }
      .interaction-fixture-copy { margin:0; min-width:0; }
      .interaction-fixture-note { color:var(--fg-secondary); }
    `}</style>
    <h1>局部交互反馈</h1>
    <div className="interaction-fixture-controls" aria-label="夹具动效设置">
      <span>动效档位</span>
      {(['system', 'subtle', 'reduced'] as const).map((motion, index) =>
        <button className="ui-btn" type="button" key={motion} data-motion={motion}
          aria-pressed={preferences.motion === motion} onClick={() => setInteractionPreferences({ motion })}>
          {['跟随系统', '轻微', '减少'][index]}
        </button>)}
      <button className="ui-btn" type="button" id="clear-focus" onClick={() => setFocused(null)}>清除行指示</button>
    </div>
    <div className="interaction-fixture-grid">
      <section className="interaction-fixture-panel">
        <h2>侧栏焦点指示</h2>
        <p className="interaction-fixture-note">以下三行仅检验生产 CSS，不代表 LeftPanel 或扩展树状态逻辑。</p>
        <div className="left-panel">
          <div role="button" tabIndex={0} data-row="session" aria-pressed={focused === 'session'}
            className={`session-item${focused === 'session' ? ' active is-pane-focused' : ''}`} {...activate('session')}>
            <span className="session-name">检查会话滚动</span>
            <button className="session-action" type="button" aria-label="示例会话更多"
              onClick={event => event.stopPropagation()}><IconMore size={12}/></button>
          </div>
          <button type="button" data-row="utility" aria-pressed={focused === 'utility'}
            className={`utility-feature-item session-item${focused === 'utility' ? ' active is-pane-focused' : ''}`}
            onClick={() => setFocused('utility')}>使用统计</button>
        </div>
        <div className="ext-nav">
          <div role="button" tabIndex={0} data-row="extension" aria-pressed={focused === 'extension'}
            className={`ext-nav-row${focused === 'extension' ? ' is-selected is-pane-focused' : ''}`}
            style={{ '--nav-depth': 0 } as React.CSSProperties} data-drop={drop || undefined} {...activate('extension')}>
            <span className="ext-nav-title">项目工具目录</span>
            <button className="ext-nav-icon ext-nav-more" type="button" aria-label="示例目录更多"
              onClick={event => event.stopPropagation()}><IconMore size={12}/></button>
          </div>
        </div>
        <label className="interaction-fixture-controls">拖放 CSS 标记
          <select aria-label="拖放 CSS 标记" value={drop} onChange={event => setDrop(event.target.value)}>
            <option value="">无</option><option value="before">前方</option><option value="after">后方</option>
          </select>
        </label>
      </section>
      <section className="interaction-fixture-panel">
        <h2>生产分段选择</h2>
        <div className="interaction-fixture-controls">
          <button className="ui-btn" type="button" id="mount-segment" disabled={mounted} onClick={() => setMounted(true)}>首次挂载分段</button>
          <button className="ui-btn" type="button" id="toggle-segment" disabled={!mounted} onClick={() => setVisible(shown => !shown)}>
            {visible ? '隐藏分段' : '显示分段'}
          </button>
        </div>
        {mounted ? <div className="settings-tabpane" aria-hidden={!visible || undefined} style={{ display: visible ? 'block' : 'none' }}>
          <Segmented label="不同宽标签" value={value} options={options} onChange={setValue}/>
        </div> : null}
        <p className="interaction-fixture-note">按钮文字与点击区域保持原位，只有共享选中底片移动。</p>
      </section>
    </div>
    <section className="interaction-fixture-panel interaction-fixture-copy">
      <h2>生产复制按钮</h2>
      <div className="chat-msg chat-quiet assistant" data-copy="chat">
        <p>{message.content}</p><ChatHoverbar message={message} timeLabel="12:34"/>
      </div>
      <div data-copy="code"><MarkdownBody text={'```ts\nconst ready = true;\nconsole.log(ready);\n```'}/></div>
      <label className="interaction-fixture-controls"><input type="checkbox" checked={clipboardFailure}
        onChange={event => { setClipboardFailure(event.target.checked); diagnostics.rejectClipboard = event.target.checked; }}/>
        模拟剪贴板失败
      </label>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StoreProvider><Fixture/></StoreProvider>);
