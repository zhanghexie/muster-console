import { SettingsResourceItem } from './SettingsResource';
import React, { useEffect, useId, useState } from 'react';
import { usePresence } from '../motion';
import { SettingsDetailHeadingScope } from './SettingsSectionJump';
import './settings-content.css';

export interface SettingsView { id: string; label: string; content: React.ReactNode }

/** One navigation style for peer tasks; editing scope controls remain inside each task. */
export function SettingsTabs<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: T; options: { value: T; label: string }[];
  onChange: (value: T) => void; disabled?: boolean;
}): React.JSX.Element {
  return <div className="settings-task-tabs" role="group" aria-label={label}>
    {options.map((option, index) => <button key={option.value} type="button" aria-pressed={value === option.value}
      disabled={disabled} onClick={() => onChange(option.value)} onKeyDown={event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : event.key === 'ArrowRight' ? (index + 1) % options.length
            : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : -1;
        if (next >= 0) {
          event.preventDefault(); onChange(options[next].value);
          (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
        }
      }}>{option.label}</button>)}
  </div>;
}

function View({ selected, children, label, id }: { selected: boolean; children: React.ReactNode; label: string; id: string }): React.JSX.Element {
  const presence = usePresence(selected);
  return <div id={id} role="region" aria-label={label} aria-hidden={!selected}
    className={`settings-task-view xfade${selected && presence.stage === 'in' ? ' is-shown' : ''}`}
    ref={node => { if (node) node.inert = !selected; }}>{children}</div>;
}

/** Keep visited forms mounted so task navigation never discards a draft or in-flight result. */
export function SettingsViews({ label, views, requestedView, requestKey, navigation = 'tabs' }: { label: string; views: SettingsView[]; requestedView?: string; requestKey?: number; navigation?: 'tabs' | 'list' }): React.JSX.Element {
  const id = useId();
  const [selected, setSelected] = useState(requestedView ?? views[0]?.id);
  const [visited, setVisited] = useState<string[]>([requestedView ?? views[0]?.id]);
  const current = views.some(view => view.id === selected) ? selected : views[0]?.id;
  const select = (next: string) => {
    setSelected(next); setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
  };
  useEffect(() => { if (requestedView) select(requestedView); }, [requestedView, requestKey]);
  return <div className={`settings-task-layout${navigation === 'list' ? ' settings-entity-layout settings-resource-layout' : ''}`}>
    {navigation === 'list' ? <nav className="settings-entity-list settings-resource-nav" aria-label={label}>
      {views.map(view => <SettingsResourceItem key={view.id} name={view.label} selected={current === view.id} onClick={() => select(view.id)}/>)}
    </nav> : <SettingsTabs label={label} value={current} options={views.map(view => ({ value: view.id, label: view.label }))} onChange={select}/> }
    <div className={`settings-task-pages xfade-stack${navigation === 'list' ? ' settings-resource-detail' : ''}`}>{navigation === 'list' ? <SettingsDetailHeadingScope>{views.filter(view => view.id === current || visited.includes(view.id)).map(view =>
      <View key={view.id} id={`${id}-${view.id}`} selected={view.id === current} label={view.label}>{view.content}</View>)}</SettingsDetailHeadingScope> : views.filter(view => view.id === current || visited.includes(view.id)).map(view =>
      <View key={view.id} id={`${id}-${view.id}`} selected={view.id === current} label={view.label}>{view.content}</View>)}
    </div>
  </div>;
}
