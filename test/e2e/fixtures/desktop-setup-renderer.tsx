import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/src/i18n';
import { DesktopSetupNotice } from '../../../src/renderer/src/components/DesktopSetupCard';
import { GeneralPane } from '../../../src/renderer/src/components/settings/GeneralPane';
import { applyTheme } from '../../../src/renderer/src/theme';
import { builtinTheme } from '../../../src/shared/theme';
import type { AppConfig } from '../../../src/shared/types';

const setTheme = (theme: 'light' | 'dark') => applyTheme(builtinTheme(theme)!);
Object.assign(window, { setDesktopSetupFixtureTheme: setTheme });
setTheme('dark');

function DesktopSetupFixture() {
  return <main className="app-shell">
    <DesktopSetupNotice />
    <div className="settings-page settings-tabpane"
      style={{ position: 'static', display: 'block', flex: 1, paddingTop: 20, background: 'var(--surface-canvas)' }}>
      <div className="settings-col">
        <GeneralPane cfg={{} as AppConfig} set={() => {}} />
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<DesktopSetupFixture />);
