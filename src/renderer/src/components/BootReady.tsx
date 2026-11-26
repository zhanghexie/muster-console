import { useLayoutEffect } from 'react';

/** The HTML overlay is outside the React root, so its animation never remounts. */
export function finishBoot(): void {
  document.getElementById('boot-overlay')?.remove();
  document.querySelector('.boot-diag')?.remove();
}

/** Must be inside Suspense: layout effects only run after the real tree commits. */
export function BootReady(): null {
  useLayoutEffect(finishBoot, []);
  return null;
}
