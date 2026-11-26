import React from 'react';
import './settings-resource.css';

/** One native-button row for all settings resource browsers. */
export function SettingsResourceItem({ name, icon, meta, trailing, selected, className = '', ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  name: string; icon?: React.ReactNode; meta?: React.ReactNode; trailing?: React.ReactNode; selected: boolean;
}): React.JSX.Element {
  return <button {...props} type="button" aria-pressed={selected} title={props.title ?? name}
    className={`settings-resource-item${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}>
    {icon && <span className="settings-resource-icon" aria-hidden="true">{icon}</span>}
    <span className="settings-resource-copy"><span className="settings-resource-name">{name}</span>
      {meta && <span className="settings-resource-meta">{meta}</span>}
    </span>
    {trailing && <span className="settings-resource-trailing">{trailing}</span>}
  </button>;
}

export function SettingsResourceStatus({ children, state = 'neutral' }: { children: React.ReactNode; state?: 'neutral' | 'success' | 'warning' }): React.JSX.Element {
  return <span className={`settings-resource-status is-${state}`}><i aria-hidden="true"/>{children}</span>;
}

/** Detail groups have one heading/help/body rhythm, independent of resource type. */
export function SettingsDetailSection({ title, desc, actions, children, item }: {
  title: React.ReactNode; desc?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; item?: string;
}): React.JSX.Element {
  const id = React.useId();
  return <section className="settings-detail-section" aria-labelledby={id} data-settings-item={item}>
    <div className="settings-detail-section-head"><div><h3 id={id}>{title}</h3>{desc && <p>{desc}</p>}</div>{actions && <div className="settings-detail-section-actions">{actions}</div>}</div>
    <div className="settings-detail-section-body settings-group-body">{children}</div>
  </section>;
}
