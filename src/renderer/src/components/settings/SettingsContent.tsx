import React from 'react';
import './settings-content.css';

/** Shared content width, flat groups and section rhythm for settings forms. */
export function SettingsContent({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="settings-content" data-settings-layout="flat">{children}</div>;
}
