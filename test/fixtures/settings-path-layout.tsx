/** Real path controls in the settings contexts that apply their own layout rules. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { SettingsPathField } from '../../src/renderer/src/components/settings/SettingsPathField';

const path = '/home/example/a-long-path-to-the-configuration-directory';
createRoot(document.getElementById('root')!).render(<main className="settings-page">
  <section id="resource" className="settings-resource-detail worker-detail"><div className="worker-page"><SettingsPathField label="资源目录" path={path}/></div></section>
  <section id="capability" className="cm-pane"><div className="cm-detail settings-resource-detail"><SettingsPathField label="技能目录" path={path}/></div></section>
  <section id="content" className="settings-content"><SettingsPathField label="存储目录" path={path} onChange={() => {}} action={<button className="btn tiny">选择目录</button>}/></section>
</main>);
