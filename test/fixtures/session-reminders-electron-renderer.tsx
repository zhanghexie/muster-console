import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import '@workbench/src/renderer/src/styles/base.css';
import '@workbench/src/renderer/src/styles/chat.css';
import '@workbench/src/renderer/src/styles/session-reminders.css';
import { SessionReminders } from '@workbench/src/renderer/src/components/SessionReminders';

function Fixture() {
  const [view, setView] = useState<'gui' | 'cli' | 'scheduler'>('gui');
  return <main><nav>
    <button onClick={() => setView('gui')}>GUI</button>
    <button onClick={() => setView('cli')}>CLI</button>
    <button onClick={() => setView('scheduler')}>调度</button>
  </nav><section style={{ position: 'relative', height: 420, background: 'var(--surface-canvas)' }}>
    <p>会话内容</p>
    <div className="chat-input-shell" style={{ position: 'absolute', bottom: 16, left: 16, right: 16 }}>
      <div className="composer-ta-wrap" style={{ minHeight: 48 }}>输入内容</div>
      <div className="agent-composer-toolbar"><div className="agent-composer-tb-left">
        <SessionReminders kind={view === 'scheduler' ? 'scheduler' : 'session'} id={view === 'scheduler' ? 'ws' : view}
          visible onOpenSource={view === 'gui' ? () => true : undefined}/>
      </div></div>
    </div>
  </section></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
