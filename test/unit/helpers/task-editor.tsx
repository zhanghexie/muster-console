import type { ReactElement } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { StoreProvider } from '../../../src/renderer/src/store';

export function renderTask(element: ReactElement) {
  return render(element, { wrapper: StoreProvider });
}

export function enterTask(editor: HTMLElement, text: string) {
  editor.focus();
  editor.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(editor.lastChild ?? editor);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}
