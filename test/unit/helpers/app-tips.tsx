import type { ReactNode } from 'react';
import { render, waitFor, type RenderOptions } from '@testing-library/react';
import { AppTipHost } from '../../../src/renderer/src/components/AppTip';

/** Mount the window's feedback host alongside the component under test. */
export function renderWithAppTips(ui: ReactNode, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  return render(ui, {
    ...options,
    wrapper: ({ children }) => <>{Wrapper ? <Wrapper>{children}</Wrapper> : children}<AppTipHost /></>
  });
}

export function queryAppTip(): HTMLElement | null {
  return document.querySelector('.app-tip-region[role="status"] .app-tip:not([aria-hidden="true"])');
}

export function getAppTip(): HTMLElement {
  const tip = queryAppTip();
  if (!tip) throw new Error('The application did not show a tip');
  return tip;
}

export function findAppTip(): Promise<HTMLElement> {
  return waitFor(getAppTip);
}
