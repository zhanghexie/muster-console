import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { builtinTheme } from '../../src/shared/theme';
import { applyTheme } from '../../src/renderer/src/theme';
import { ChannelsSettingsPanel } from '../../src/renderer/src/components/settings/ChannelsSettingsPanel';
import { ChannelRemoteInput } from '../../src/renderer/src/components/settings/ChannelRemoteInput';
import { SettingsContent } from '../../src/renderer/src/components/settings/SettingsContent';
import '../../src/renderer/src/styles/settings.css';

applyLocaleSetting('zh-CN', 'zh-CN');
applyTheme(builtinTheme('dark')!);
(window as unknown as { setChannelTestTheme: (mode: 'light' | 'dark') => void }).setChannelTestTheme = mode => applyTheme(builtinTheme(mode)!);
function Fixture() {
  const [remote, setRemote] = useState(false);
  return <main className="settings-page settings-page--embedded" data-mp-stage="in" style={{ position: 'relative', display: 'block', padding: 20, height: 'auto', minHeight: '100vh' }}><SettingsContent>{remote
    ? <div className="settings-section"><ChannelRemoteInput onOpenChannels={() => setRemote(false)} /></div>
    : <ChannelsSettingsPanel workspaceId="fixture-workspace" onOpenRemote={() => setRemote(true)} />}
  </SettingsContent></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
