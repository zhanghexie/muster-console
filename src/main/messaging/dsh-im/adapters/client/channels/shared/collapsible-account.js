import * as React from 'react';
import { h } from '../../i18n.js';
import { SettingsGlyph } from '../../channel-card-meta.js';

const AccountSectionContext = React.createContext(null);
export const AccountDisclosureContext = React.createContext(null);

export function AccountSettingsToggle() {
  const { open, toggle, contentId, hasDetails } = React.useContext(AccountSectionContext);
  const labels = React.useContext(AccountDisclosureContext);
  if (!hasDetails) return null;
  return h('button', {
    type: 'button',
    className: 'dim-accountSettingsToggle',
    'aria-label': open ? labels.closeLabel : labels.openLabel,
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': contentId,
    onClick: (event) => {
      event.stopPropagation();
      toggle();
    },
  }, h(SettingsGlyph),
  h('svg', {
    className: 'dim-collapsibleChevron',
    viewBox: '0 0 12 16',
    width: 12,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: 'M2 6 6 10 10 6' })));
}

export function CollapsibleAccountSection({
  header, defaultOpen = false, open: controlledOpen, onToggle, id, className = '', children,
}) {
  const { Disclosure } = React.useContext(AccountDisclosureContext);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const generatedId = React.useId();
  const open = controlledOpen ?? uncontrolledOpen;
  const contentId = (id ?? generatedId) + '-content';
  const hasDetails = React.Children.toArray(children).length > 0;

  const toggle = () => {
    if (controlledOpen === undefined) setUncontrolledOpen((value) => !value);
    onToggle?.(!open);
  };

  return h(AccountSectionContext.Provider, { value: { open, toggle, contentId, hasDetails } },
    h('div', { className: ['dim-collapsibleAccount', open ? 'is-open' : '', className].filter(Boolean).join(' '),
      'data-open': open ? 'true' : 'false' },
      h('div', { className: 'dim-collapsibleHead', onClick: hasDetails ? toggle : undefined },
        h('div', { className: 'dim-collapsibleHeaderContent' }, header)),
      hasDetails ? h(Disclosure, { id: contentId, open }, children) : null));
}
