import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import { MailEnvelopeViewport } from '../../src/renderer/src/components/MailEnvelopeViewport';
import type { MailActivity, MailDepartureRequest } from '../../src/shared/mailActivity';
import type { WorkbenchApi } from '../../src/preload/index';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);

const activityListeners = new Set<(letter: MailActivity) => void>();
const departureListeners = new Set<(request: MailDepartureRequest) => void>();
const viewports = new Map<string, string>();
const pending = new Map<string, MailDepartureRequest>();
const store = (letter: MailActivity) => { for (const fn of activityListeners) fn(letter); };
let commitGate: Promise<void> | undefined;
let releaseCommit: (() => void) | undefined;
let commitWaiting = false;
window.api = {
  on: (channel: string, fn: unknown) => {
    if (channel === 'messages:activity') {
      const listener = fn as (letter: MailActivity) => void;
      activityListeners.add(listener); return () => activityListeners.delete(listener);
    }
    if (channel === 'messages:departure') {
      const listener = fn as (request: MailDepartureRequest) => void;
      departureListeners.add(listener); return () => departureListeners.delete(listener);
    }
    return () => {};
  },
  mailPresentation: {
    async setViewport(viewportId: string, mailboxId: string, active: boolean) {
      if (active) viewports.set(mailboxId, viewportId);
      else {
        viewports.delete(mailboxId);
        for (const [id, request] of pending) if (request.viewportId === viewportId) { pending.delete(id); store(request.letter); }
      }
      return { ok: true };
    },
    async depart(viewportId: string, ids: string[]) {
      commitWaiting = true;
      await commitGate;
      commitWaiting = false;
      for (const id of ids) {
        const request = pending.get(id);
        if (request?.viewportId !== viewportId) return { ok: false, error: 'Preview cancelled' };
        pending.delete(id);
        store(request.letter);
      }
      return { ok: true };
    }
  }
} as unknown as WorkbenchApi;
let seq = 0;
const raf = window.requestAnimationFrame.bind(window);
const caf = window.cancelAnimationFrame.bind(window);
const pendingFrames = new Set<number>();
window.requestAnimationFrame = callback => {
  const id = raf(now => { pendingFrames.delete(id); callback(now); });
  pendingFrames.add(id); return id;
};
window.cancelAnimationFrame = id => { pendingFrames.delete(id); caf(id); };
interface FixtureWindow extends Window {
  mailFixture?: { freeze: () => void; reset: () => void; hold: () => void; release: () => void; waiting: () => boolean };
}

function Fixture() {
  const [mailbox, setMailbox] = useState('a');
  const [enabled, setEnabled] = useState(true);
  const [run, setRun] = useState(0);
  const emit = () => {
    for (let i = 0; i < 3; i++) {
      const text = ['已核对按钮布局与交互反馈。\n主面板留白和字号已统一，正在继续验证窄屏显示。',
        '回归结果：界面事件顺序正确，等待期间没有占用用户输入。', '下一步核对键盘导航，完成后继续向你寄信。'][i]!;
      const letter: MailActivity = { id: `fixture-${++seq}`, mailboxWorkspaceId: 'ws', from: 'a', to: 'b',
        fromName: '像素 · 界面设计', toName: '罗盘 · 交互核对', subject: ['按钮布局检查', '回归结果', '后续验证'][i], text, totalChars: text.length, ts: Date.now() };
      const viewportId = viewports.get(letter.from);
      if (viewportId) {
        const request = { requestId: letter.id, viewportId, letter };
        pending.set(request.requestId, request);
        for (const fn of departureListeners) fn(request);
      } else store(letter);
    }
  };
  (window as FixtureWindow).mailFixture = {
    freeze() {
      // Freeze only frames already pending. Future screenshot/layout RAFs must still run.
      for (const id of pendingFrames) caf(id);
      pendingFrames.clear();
      document.querySelectorAll<HTMLElement>('.es-flight').forEach(el => el.getAnimations({ subtree: true }).forEach(track => track.pause()));
    },
    reset() { setRun(value => value + 1); },
    hold() { commitGate = new Promise(resolve => { releaseCommit = resolve; }); },
    release() { releaseCommit?.(); commitGate = undefined; releaseCommit = undefined; },
    waiting() { return commitWaiting; }
  };
  return <main style={{ margin: 16, fontFamily: 'var(--font-sans)', color: 'var(--fg-primary)' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      <button onClick={() => setMailbox('a')}>查看发送方</button>
      <button onClick={() => setMailbox('b')}>查看收件方</button>
      <button onClick={emit}>寄三封信</button>
      <button onClick={() => setEnabled(value => !value)}>切换前台</button>
    </div>
    <section data-fixture="mail" style={{ position: 'relative', height: 600, background: 'var(--surface-canvas)', borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ padding: 24, lineHeight: 2 }}><p>当前会话正在核对界面布局。</p><p>这里是不断变化的聊天正文。信件显示在当前会话上方，不打断工作，也不需要用户回答。</p></div>
      <MailEnvelopeViewport key={run} mailboxId={mailbox} enabled={enabled} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
