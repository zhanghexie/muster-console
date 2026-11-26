import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import { ReadMailCards } from '../../src/renderer/src/components/ReadMailCards';
import { MailEnvelopeViewport } from '../../src/renderer/src/components/MailEnvelopeViewport';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const text = '**真实证据（本工作区）**\n\n- **加粗**与`inline`\n- 第二项\n\n> 引用说明\n\n| 名称 | 结果 |\n| --- | --- |\n| Markdown | 可读 |\n\n```ts\nconst longValue = "' + 'long'.repeat(30) + '";\n```\n\n' + '- 长列表正文\n'.repeat(25) + '\n```ts\n未闭合围栏';
const listeners = new Set<Function>();
window.api = { on: ((channel: string, fn: Function) => { if (channel === 'messages:activity') listeners.add(fn); return () => listeners.delete(fn); }) as typeof window.api.on } as typeof window.api;
function emit() { for (const fn of listeners) fn({ id: String(Date.now()), mailboxWorkspaceId: 'ws', from: 'a', to: 'b', fromName: '设计师', toName: '工程师', subject: '渲染核对', text, totalChars: 6000, ts: Date.now() }); }
createRoot(document.getElementById('root')!).render(<main style={{ padding: 16, background: 'var(--surface-canvas)' }}>
  <button onClick={emit}>展示信纸</button>
  <section style={{ position: 'relative', height: 480 }}><MailEnvelopeViewport mailboxId="b" /></section>
  <ReadMailCards pages={[{ key: 'one', text, offset: 0, nextOffset: 5000, sender: { sessionId: 'a', name: '设计师' } }, { key: 'two', text: '**后一封依旧正常**', offset: 0, sender: { sessionId: 'b', name: '工程师' } }]} />
</main>);
