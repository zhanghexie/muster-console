import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ExtensionNavigationSnapshot } from '../../src/shared/extension';
import { useExtensionWorkbenchNavigation } from '../../src/renderer/src/extensionWorkbench';
import { currentApiMock } from './helpers/api-mock';

it('ignores a late navigation response after switching projects away and back', async () => {
  const snapshot = (root: string, selectionRevision: number): ExtensionNavigationSnapshot => ({ workspaceId: 'nav-extension', sourceRootId: root, selectionRevision, revision: 1, libraryExpanded: false, nodes: [{ id: root, kind: 'folder', title: root, parentId: null, expanded: false }] });
  currentApiMock().override('workbench.navigation', async () => snapshot('one', 0));
  const view = renderHook(() => useExtensionWorkbenchNavigation('nav-extension'));
  await waitFor(() => expect(view.result.current.sourceRootId).toBe('one'));
  await act(async () => currentApiMock().emit('workbench:changed', snapshot('two', 1)));
  await act(async () => currentApiMock().emit('workbench:changed', snapshot('one', 2)));
  await act(async () => currentApiMock().emit('workbench:changed', snapshot('two', 1)));
  expect(view.result.current.sourceRootId).toBe('one');
  expect(view.result.current.selectionRevision).toBe(2);
});
