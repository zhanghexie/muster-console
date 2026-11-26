import React from 'react';
import { useTranslation } from 'react-i18next';
import { IconClose } from './icons';
import { usePresenceValue } from './motion';

export interface BackgroundViewTab {
  id: string;
  label: string;
  onSelect: () => void;
  onClose: () => void;
}

/** A background entry points to the existing view; it never renders a second instance. */
export function BackgroundViewTabs({ tabs }: { tabs: readonly BackgroundViewTab[] }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { presence, value } = usePresenceValue(tabs.length ? tabs : null);
  if (!presence.mounted || !value) return null;
  return <div className="center-background-tabs mp-pop" {...presence.spread} aria-hidden={presence.stage === 'out' || undefined}
    {...(presence.stage === 'out' ? { inert: '' } : {})}>
    {value.map(tab => <div className="center-background-tab" key={tab.id}>
      <button type="button" className="center-background-select" onClick={tab.onSelect}>{tab.label}</button>
      <button type="button" className="center-background-close" aria-label={`${t('关闭')} ${tab.label}`} onClick={tab.onClose}><IconClose size={12}/></button>
    </div>)}
  </div>;
}
