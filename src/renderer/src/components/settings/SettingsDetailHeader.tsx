import React from 'react';
import './settings-content.css';
import './settings-resource.css';

/** Resource details share one title, metadata and description hierarchy. */
export function SettingsDetailHeader({ title, icon, meta, description, actions }: {
  title: React.ReactNode; icon?: React.ReactNode; meta?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode;
}): React.JSX.Element {
  return <header className="settings-detail-header">
    <div className="settings-detail-top"><div className="settings-detail-identity">
      {icon && <span className="settings-detail-icon" aria-hidden="true">{icon}</span>}
      <h2>{title}</h2>
    </div>{actions && <div className="settings-detail-actions">{actions}</div>}</div>
    {meta && <div className="settings-detail-meta">{meta}</div>}
    {description && <p className="settings-detail-description">{description}</p>}
  </header>;
}
