import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { FeedbackEntryPoint } from '../../src/renderer/src/components/FeedbackCenter';
import { AboutPane } from '../../src/renderer/src/components/settings/AboutPane';

function App() {
  const [settings, setSettings] = useState(false);
  return <main>
    <button type="button" onClick={() => void (window.api as any).fixture.propose()}>Fixture: propose feedback</button>
    <button type="button" onClick={() => setSettings(true)}>Fixture: open settings</button>
    <FeedbackEntryPoint/>
    {settings && <section aria-label="反馈设置"><button type="button" onClick={() => setSettings(false)}>Fixture: close settings</button><AboutPane/></section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
