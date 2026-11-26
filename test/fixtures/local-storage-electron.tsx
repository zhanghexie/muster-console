/** Production storage pane; its API comes from the real Electron preload. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles/base.css';
import '../../src/renderer/src/styles/dialogs.css';
import '../../src/renderer/src/styles/settings.css';
import '../../src/renderer/src/styles/float.css';
import '../../src/renderer/src/styles/responsive.css';
import '../../src/renderer/src/i18n';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { LocalStoragePane } from '../../src/renderer/src/components/settings/LocalStoragePane';
import { SettingsContent } from '../../src/renderer/src/components/settings/SettingsContent';

void applyLocaleSetting('zh-CN');
createRoot(document.getElementById('root')!).render(<div className="settings-page" style={{ position: 'relative', display: 'block', height: '100vh', padding: 0 }}>
  <div className="settings-tabpane is-shown" data-settings-item="localStorage" style={{ height: '100%', position: 'relative', background: 'var(--surface-canvas)' }}>
    <div className="settings-col"><header className="settings-pane-title"><h1>本机存储</h1></header><SettingsContent><LocalStoragePane /></SettingsContent></div>
  </div>
</div>);
