// Isolated production components; no real preload, sessions, or app data.
import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { ChatTranscript } from '@workbench/src/renderer/src/chatSurface/ChatTranscript';
import type { TranscriptModelBinding } from '@workbench/src/renderer/src/chatSurface/ChatTranscript';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ChatMessage } from '@workbench/src/shared/types';
import { setInteractionPreferences, useInteractionPreferences, type ScrollFeel } from '@workbench/src/renderer/src/interactionPreferences';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const model: TranscriptModelBinding<ChatMessage> = { toDisplay: message => message };
const initial: ChatMessage[] = Array.from({ length: 80 }, (_, i) => ({
  id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', createdAt: Date.now(),
  content: i % 2 === 0 ? `问题 ${i}` : `回复 ${i}\n\n` + Array.from({ length: 30 }, (_, j) => `第 ${j} 段：检查滚动布局以及离屏内容的真实高度。`).join('\n\n')
}));
// One ordinary Markdown paragraph: once visible, it has no skipped siblings
// whose intrinsic estimates could obscure an exact detent-distance assertion.
const realized: ChatMessage[] = [{ id: 'steady', role: 'assistant', createdAt: Date.now(),
  content: Array.from({ length: 280 }, (_, i) => `第 ${i} 行普通正文，验证已经实现的连续文本滚动距离。`).join(' ') }];

function FeelToolbar({ visible, contained, onVisible, onContained, onPreset, onAppend, onJump }: {
  visible: boolean; contained: boolean; onVisible: () => void; onContained: (value: boolean) => void;
  onPreset: (sample: 'normal' | 'nested' | 'realized') => void; onAppend: () => void; onJump: () => void;
}) {
  const prefs = useInteractionPreferences();
  return <div data-scroll-feel-controls style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8, alignItems: 'center', background: 'var(--surface-raised)' }}>
    <label>滚动手感 <select aria-label="滚动手感" value={prefs.scrollFeel} onChange={event => setInteractionPreferences({ scrollFeel: event.target.value as ScrollFeel })}>
      <option value="native">原生</option><option value="crisp">利落</option><option value="soft">柔和</option>
    </select></label>
    <label>每格距离 <select aria-label="每格距离" value={prefs.scrollDistance} disabled={prefs.scrollFeel === 'native'} onChange={event => setInteractionPreferences({ scrollDistance: Number(event.target.value) })}>
      {[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
    </select></label>
    <label>动态效果 <select aria-label="动态效果" value={prefs.motion} onChange={event => setInteractionPreferences({ motion: event.target.value as 'system' | 'subtle' | 'reduced' })}>
      <option value="system">跟随系统</option><option value="subtle">轻微</option><option value="reduced">减少动态</option>
    </select></label>
    <button type="button" onClick={() => onPreset('normal')}>正文样本</button>
    <button type="button" onClick={() => onPreset('nested')}>嵌套样本</button>
    <button type="button" onClick={() => onPreset('realized')}>单块正文样本</button>
    <button type="button" onClick={onAppend}>追加尾段</button>
    <button type="button" onClick={onJump}>跳到历史 m20</button>
    <button type="button" onClick={onVisible}>{visible ? '隐藏会话' : '显示会话'}</button>
    <label><input type="checkbox" checked={contained} onChange={event => onContained(event.target.checked)} />内部阻断滚动链</label>
    <textarea aria-label="手感输入" rows={1} placeholder="验证输入空格不干扰跟随" />
  </div>;
}

function App() {
  const [messages, setMessages] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [controls, setControls] = React.useState(false);
  const [visible, setVisible] = React.useState(true);
  const [contained, setContained] = React.useState(false);
  const [sample, setSample] = React.useState(0);
  const nested = () => {
    setBusy(true);
    setMessages([...initial.slice(0, -1), { ...initial.at(-1)!, content: '', thinking: '内部思考滚动测试\n'.repeat(300) }]);
  };
  const append = () => setMessages(previous => [
    ...previous.slice(0, -1), { ...previous.at(-1)!, content: previous.at(-1)!.content + '\n\n新增尾段。'.repeat(80) }
  ]);
  Object.assign(window, {
    nestedScrollFixture: nested,
    appendScrollFixture: append,
    // Opt-in fixture preparation; the original scenario keeps its exact UI/layout.
    enableScrollFeelFixture: () => setControls(true)
  });
  React.useEffect(() => {
    if (!controls) return;
    const list = document.querySelector<HTMLElement>('.chat-list');
    if (list) list.tabIndex = 0;
    document.querySelectorAll<HTMLElement>('.thinking-body').forEach(element => { element.style.overscrollBehaviorY = contained ? 'contain' : 'auto'; });
  }, [controls, contained, messages]);
  const surface = <div className="chat-surface-view" data-scroll-feel-surface={controls || undefined}
    style={{ height: controls ? '100%' : '100vh', visibility: visible ? 'visible' : 'hidden' }} aria-hidden={!visible || undefined} inert={!visible || undefined}>
    <ChatTranscript messages={messages} busy={busy} sessionId={controls ? `scroll-feel-${sample}` : 'scroll-fixture'} model={model} interactionActive={visible} />
  </div>;
  return <StoreProvider>{controls ? <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <FeelToolbar visible={visible} contained={contained} onVisible={() => setVisible(value => !value)} onContained={setContained}
      onAppend={append} onPreset={preset => {
        setSample(value => value + 1); setContained(false);
        if (preset === 'nested') nested(); else { setBusy(false); setMessages(preset === 'realized' ? realized : initial); }
      }} onJump={() => {
        const list = document.querySelector<HTMLElement>('.chat-list');
        list?.focus({ preventScroll: true }); list?.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm20' }));
      }} />
    <div style={{ flex: 1, minHeight: 0 }}>{surface}</div>
  </div> : surface}</StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
