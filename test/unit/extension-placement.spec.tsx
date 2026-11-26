import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { currentApiMock } from './helpers/api-mock';
import { setExtensionPlacement as setExtensionPlacement, useExtensionWorkbenchNavigation as useWorkbenchNavigation } from '../../src/renderer/src/extensionWorkbench';
import type { ExtensionNavigationSnapshot as ExtensionNavigationSnapshot } from '../../src/shared/extension';
import { ExtensionSurface, ExtensionTabHost, extensionSurfaceKey } from '../../src/renderer/src/components/ExtensionSurface';

it('serializes multiple tab recalls against the latest navigation snapshot', async () => {
  let saved: ExtensionNavigationSnapshot = { workspaceId: 'placement-queue', sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: true,
    nodes: ['a', 'b'].map(id => ({ id, title: id, parentId: null, kind: 'extension', extensionId: id, viewId: 'panel', placement: 'tab' })) };
  const pending: (() => void)[] = [];
  currentApiMock().override('workbench.navigation', async () => saved);
  currentApiMock().override('workbench.saveNavigation', (value: ExtensionNavigationSnapshot) => new Promise(resolve => {
    pending.push(() => { saved = { ...value, revision: value.revision + 1 }; resolve(saved); });
  }));
  const view = renderHook(() => useWorkbenchNavigation('placement-queue'));
  await waitFor(() => expect(view.result.current.nodes).toHaveLength(2));
  const first = setExtensionPlacement('placement-queue', 'a', 'center');
  const second = setExtensionPlacement('placement-queue', 'b', 'center');
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => { pending.shift()!(); await first; });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => { pending.shift()!(); await second; });
  expect(view.result.current.nodes.map(node => node.placement)).toEqual(['center', 'center']);
});

it('restores a prepared surface to its tab when saving a recall fails', async () => {
  const snapshot: ExtensionNavigationSnapshot = { workspaceId: 'failed-placement', sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: true,
    nodes: [{ id: 'a', title: 'a', parentId: null, kind: 'extension', extensionId: 'a', viewId: 'panel', placement: 'tab' }] };
  currentApiMock().override('workbench.navigation', async () => snapshot);
  currentApiMock().override('workbench.saveNavigation', async () => { throw Error('save failed'); });
  const move = vi.fn(function(this: HTMLElement, node: Node, child: Node | null) { this.insertBefore(node, child); });
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value: move });
  try {
    const hook = renderHook(() => useWorkbenchNavigation('failed-placement'));
    await waitFor(() => expect(hook.result.current.nodes).toHaveLength(1));
    const key = extensionSurfaceKey('failed-placement', 'a');
    const view = render(<><ExtensionSurface surfaceKey={key} inTab onError={vi.fn()}><input aria-label="draft" defaultValue="keep"/></ExtensionSurface><ExtensionTabHost surfaceKey={key}/></>);
    const draft = screen.getByLabelText('draft') as HTMLInputElement;
    expect(view.container.querySelector('.extension-tab-host')?.contains(draft)).toBe(true);
    await act(async () => { await expect(setExtensionPlacement('failed-placement', 'a', 'center')).rejects.toThrow('save failed'); });
    expect(view.container.querySelector('.extension-tab-host')?.contains(draft)).toBe(true);
    expect(draft.value).toBe('keep');
    expect(hook.result.current.nodes[0].placement).toBe('tab');
  } finally { delete (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore; }
});

it('restores the surface when the saved navigation does not confirm the requested placement', async () => {
  const snapshot: ExtensionNavigationSnapshot = { workspaceId: 'stale-placement', sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: true,
    nodes: [{ id: 'a', title: 'a', parentId: null, kind: 'extension', extensionId: 'a', viewId: 'panel', placement: 'tab' }] };
  currentApiMock().override('workbench.navigation', async () => snapshot);
  currentApiMock().override('workbench.saveNavigation', async () => snapshot);
  const move = vi.fn(function(this: HTMLElement, node: Node, child: Node | null) { this.insertBefore(node, child); });
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value: move });
  try {
    const hook = renderHook(() => useWorkbenchNavigation('stale-placement'));
    await waitFor(() => expect(hook.result.current.nodes).toHaveLength(1));
    const key = extensionSurfaceKey('stale-placement', 'a');
    const view = render(<><ExtensionSurface surfaceKey={key} inTab onError={vi.fn()}><input aria-label="stale-draft" defaultValue="keep"/></ExtensionSurface><ExtensionTabHost surfaceKey={key}/></>);
    const draft = screen.getByLabelText('stale-draft') as HTMLInputElement;
    await act(async () => { await expect(setExtensionPlacement('stale-placement', 'a', 'center')).rejects.toThrow(/未得到确认/); });
    expect(view.container.querySelector('.extension-tab-host')?.contains(draft)).toBe(true);
    expect(draft.value).toBe('keep');
  } finally { delete (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore; }
});

it('uses authoritative readback after an ambiguous save and rejects a different workspace', async () => {
  const base: ExtensionNavigationSnapshot = { workspaceId: 'ambiguous-placement', sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: true,
    nodes: [{ id: 'a', title: 'a', parentId: null, kind: 'extension', extensionId: 'a', viewId: 'panel', placement: 'tab' }] };
  let read = base, saves = 0;
  currentApiMock().override('workbench.navigation', async () => read);
  currentApiMock().override('workbench.saveNavigation', async () => { saves++; throw Error('response lost'); });
  const hook = renderHook(() => useWorkbenchNavigation('ambiguous-placement'));
  await waitFor(() => expect(hook.result.current.nodes).toHaveLength(1));
  read = { ...base, revision: 2, nodes: base.nodes.map(node => ({ ...node, placement: 'center' })) };
  await act(async () => { await expect(setExtensionPlacement('ambiguous-placement', 'a', 'center')).resolves.toBeUndefined(); });
  expect(saves).toBe(1);
  read = { ...base, workspaceId: 'different', revision: 3 };
  await act(async () => { await expect(setExtensionPlacement('ambiguous-placement', 'a', 'tab')).rejects.toThrow(/结果未知/); });
  expect(saves).toBe(2);
});


it('rolls back earlier surface moves if an external navigation batch cannot be prepared', async () => {
  const snapshot: ExtensionNavigationSnapshot = { workspaceId: 'external-batch', sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: true,
    nodes: ['a', 'b'].map(id => ({ id, title: id, parentId: null, kind: 'extension', extensionId: id, viewId: 'panel', placement: 'tab' })) };
  currentApiMock().override('workbench.navigation', async () => snapshot);
  let failing = false, attempts = 0;
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value: function(this: HTMLElement, node: Node, child: Node | null) {
    if (failing && ++attempts === 2) throw Error('injected failure');
    this.insertBefore(node, child);
  } });
  const errors: string[] = [];
  const onError = (event: Event) => errors.push(String((event as CustomEvent).detail));
  window.addEventListener('workbench:error', onError);
  try {
    const hook = renderHook(() => useWorkbenchNavigation('external-batch'));
    await waitFor(() => expect(hook.result.current.nodes).toHaveLength(2));
    const view = render(<>{['a', 'b'].map(id => <React.Fragment key={id}>
      <ExtensionSurface surfaceKey={extensionSurfaceKey('external-batch', id)} inTab onError={vi.fn()}><input aria-label={id} defaultValue={id}/></ExtensionSurface>
      <ExtensionTabHost surfaceKey={extensionSurfaceKey('external-batch', id)}/>
    </React.Fragment>)}</>);
    failing = true;
    act(() => currentApiMock().emit('workbench:changed', { ...snapshot, revision: 2, nodes: snapshot.nodes.map(node => ({ ...node, placement: 'center' })) }));
    const hosts = view.container.querySelectorAll('.extension-tab-host');
    expect(hosts[0].contains(screen.getByLabelText('a'))).toBe(true);
    expect(hosts[1].contains(screen.getByLabelText('b'))).toBe(true);
    expect(hook.result.current.nodes.map(node => node.placement)).toEqual(['tab', 'tab']);
    expect(errors).toHaveLength(1);
  } finally {
    window.removeEventListener('workbench:error', onError);
    delete (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore;
  }
});
