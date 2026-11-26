import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render } from '@testing-library/react';
import { DockSurface, RightDockHost, beginDockReturn, moveDockSurface, releaseDockTarget, releaseDockTargets, rightDockSnapshot } from '../../src/renderer/src/rightDock';

describe('moving a file surface without losing embedded content', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('refuses to move a live iframe without state-preserving browser support', () => {
    const source = document.createElement('div'), destination = document.createElement('div');
    const host = document.createElement('div'); host.append(document.createElement('iframe')); source.append(host);
    document.body.append(source, destination);
    expect(() => moveDockSurface(host, destination, true)).toThrow(/reload embedded content/);
    expect(host.parentElement).toBe(source);
  });

  it.each(['audio', 'video'])('does not reset a live %s element through ordinary append', tag => {
    const source = document.createElement('div'), destination = document.createElement('div');
    const host = document.createElement('div'); host.append(document.createElement(tag)); source.append(host);
    document.body.append(source, destination);
    expect(() => moveDockSurface(host, destination, true)).toThrow(/reload embedded content/);
    expect(host.parentElement).toBe(source);
  });

  it('does not detach a connected surface into a disconnected host', () => {
    const source = document.createElement('div'), destination = document.createElement('div');
    const host = document.createElement('div'); host.append(document.createElement('iframe')); source.append(host);
    document.body.append(source);
    expect(() => moveDockSurface(host, destination, true)).toThrow(/destination is disconnected/i);
    expect(host.parentElement).toBe(source);
  });

  it('uses moveBefore for a live iframe and never falls back after failure', () => {
    const source = document.createElement('div'), destination = document.createElement('div');
    const host = document.createElement('div'); host.append(document.createElement('iframe')); source.append(host);
    document.body.append(source, destination);
    const mover = vi.fn((): void => { throw new Error('move failed'); });
    Object.assign(destination, { moveBefore: mover });
    expect(() => moveDockSurface(host, destination, true)).toThrow('move failed');
    expect(host.parentElement).toBe(source);
    mover.mockImplementation(() => { destination.append(host); });
    moveDockSurface(host, destination, true);
    expect(host.parentElement).toBe(destination);
    expect(mover).toHaveBeenCalledTimes(2);
  });

  it('does not report success when a move implementation leaves the host behind', () => {
    const source = document.createElement('div'), destination = document.createElement('div');
    const host = document.createElement('div'); host.append(document.createElement('iframe')); source.append(host);
    document.body.append(source, destination);
    Object.assign(destination, { moveBefore: vi.fn() });
    expect(() => moveDockSurface(host, destination, true)).toThrow(/not confirmed/);
    expect(host.parentElement).toBe(source);
  });

  it('never moves a connected webview even with moveBefore, but permits initial mounting', () => {
    const source = document.createElement('div'), destination = document.createElement('div');
    const host = document.createElement('div'); host.append(document.createElement('webview'));
    document.body.append(source, destination);
    moveDockSurface(host, source, true);
    const mover = vi.fn(); Object.assign(destination, { moveBefore: mover });
    expect(() => moveDockSurface(host, destination, true)).toThrow(/live webview/);
    expect(host.parentElement).toBe(source);
    expect(mover).not.toHaveBeenCalled();
  });

  it('keeps the host registered after a failed return and removes it only after a confirmed return', () => {
    let fail = false;
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'moveBefore');
    Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value(this: HTMLElement, node: Node) {
      if (fail) throw new Error('injected return failure');
      this.appendChild(node);
    } });
    try {
      const view = render(<><DockSurface dockKey="center-file:test" preserveEmbeddedState><iframe title="preview" /></DockSurface>
        <RightDockHost dockKey="center-file:test" hostKey="host" shown /></>);
      const iframe = view.getByTitle('preview');
      expect(view.container.querySelector('[data-dock-host] iframe')).toBe(iframe);
      const home = view.container.querySelector('.right-dock-home')!;
      home.remove();
      expect(releaseDockTarget('center-file:test', 'host')).toEqual({ ok: false, error: 'Dock surface or target is no longer current' });
      expect(rightDockSnapshot().docked.has('center-file:test')).toBe(true);
      view.container.prepend(home);
      fail = true;
      expect(releaseDockTarget('center-file:test', 'host')).toEqual({ ok: false, error: 'injected return failure' });
      expect(rightDockSnapshot().docked.has('center-file:test')).toBe(true);
      expect(view.container.querySelector('[data-dock-host] iframe')).toBe(iframe);
      fail = false;
      act(() => expect(releaseDockTarget('center-file:test', 'host')).toEqual({ ok: true }));
      expect(rightDockSnapshot().docked.has('center-file:test')).toBe(false);
      expect(view.container.querySelector('.right-dock-home iframe')).toBe(iframe);
      view.unmount();
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'moveBefore', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
    }
  });

  it('rolls back earlier returns if a later file cannot move home', () => {
    let failed = false;
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'moveBefore');
    Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value(this: HTMLElement, node: Node) {
      if (failed && this.classList.contains('right-dock-home') && (node as HTMLElement).querySelector('[title="second"]')) throw new Error('second return failed');
      this.appendChild(node);
    } });
    try {
      const view = render(<><DockSurface dockKey="center-file:first" preserveEmbeddedState><iframe title="first" /></DockSurface>
        <DockSurface dockKey="center-file:second" preserveEmbeddedState><iframe title="second" /></DockSurface>
        <RightDockHost dockKey="center-file:first" hostKey="first-host" shown />
        <RightDockHost dockKey="center-file:second" hostKey="second-host" shown /></>);
      const first = view.getByTitle('first'), second = view.getByTitle('second');
      expect(releaseDockTargets([{ dockKey: 'center-file:first', hostKey: 'first-host' }, { dockKey: 'missing', hostKey: 'none' }])).toEqual({ ok: false, error: 'Dock target is unavailable' });
      expect(first.closest('[data-dock-host]')?.getAttribute('data-dock-host')).toBe('center-file:first');
      failed = true;
      expect(releaseDockTargets([{ dockKey: 'center-file:first', hostKey: 'first-host' }, { dockKey: 'center-file:second', hostKey: 'second-host' }])).toEqual({ ok: false, error: 'second return failed' });
      expect(first.closest('[data-dock-host]')?.getAttribute('data-dock-host')).toBe('center-file:first');
      expect(second.closest('[data-dock-host]')?.getAttribute('data-dock-host')).toBe('center-file:second');
      expect(rightDockSnapshot().docked.has('center-file:first')).toBe(true);
      failed = false;
      act(() => expect(releaseDockTargets([{ dockKey: 'center-file:first', hostKey: 'first-host' }, { dockKey: 'center-file:second', hostKey: 'second-host' }])).toEqual({ ok: true }));
      expect(view.container.querySelectorAll('.right-dock-home iframe')).toHaveLength(2);
      view.unmount();
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'moveBefore', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
    }
  });

  it('restores the same view if the workspace close is rejected after preparation', () => {
    const view = render(<><DockSurface dockKey="center-file:pending" preserveEmbeddedState><div data-testid="pending-view" /></DockSurface>
      <RightDockHost dockKey="center-file:pending" hostKey="pending-host" shown /></>);
    const element = view.getByTestId('pending-view');
    const prepared = beginDockReturn([{ dockKey: 'center-file:pending', hostKey: 'pending-host' }]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error);
    expect(beginDockReturn([{ dockKey: 'center-file:pending', hostKey: 'pending-host' }])).toEqual({ ok: false, error: 'Dock return is already pending' });
    expect(element.closest('.right-dock-home')).toBeTruthy();
    const unrelated = render(<RightDockHost dockKey="unrelated" hostKey="other-host" shown />);
    expect(element.closest('.right-dock-home')).toBeTruthy();
    unrelated.unmount();
    expect(element.closest('.right-dock-home')).toBeTruthy();
    expect(rightDockSnapshot().docked.has('center-file:pending')).toBe(true);
    expect(prepared.rollback()).toEqual({ ok: true });
    expect(element.closest('[data-dock-host]')?.getAttribute('data-dock-host')).toBe('center-file:pending');
    expect(rightDockSnapshot().docked.has('center-file:pending')).toBe(true);
    expect(prepared.commit()).toEqual({ ok: false, error: 'Dock return transaction is already finished' });
    const retry = beginDockReturn([{ dockKey: 'center-file:pending', hostKey: 'pending-host' }]);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.rollback()).toEqual({ ok: true });
    view.unmount();
  });

  it('reports an unknown result if restoring a prepared surface fails', () => {
    let fail = false;
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'moveBefore');
    Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value(this: HTMLElement, node: Node) {
      if (fail && this.hasAttribute('data-dock-host')) throw new Error('restore failed');
      this.appendChild(node);
    } });
    try {
      const view = render(<><DockSurface dockKey="center-file:unknown" preserveEmbeddedState><iframe title="unknown" /></DockSurface>
        <RightDockHost dockKey="center-file:unknown" hostKey="unknown-host" shown /></>);
      const prepared = beginDockReturn([{ dockKey: 'center-file:unknown', hostKey: 'unknown-host' }]);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.error);
      fail = true;
      expect(prepared.rollback()).toEqual({ ok: false, error: 'Rollback failed, inspect views: restore failed' });
      expect(rightDockSnapshot().docked.has('center-file:unknown')).toBe(true);
      fail = false;
      view.unmount();
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'moveBefore', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
    }
  });

  it('rejects commit and restores the view if a competing host appears', () => {
    const view = render(<><DockSurface dockKey="center-file:conflict" preserveEmbeddedState><div data-testid="conflict-view" /></DockSurface>
      <RightDockHost dockKey="center-file:conflict" hostKey="original-host" shown /></>);
    const element = view.getByTestId('conflict-view');
    const prepared = beginDockReturn([{ dockKey: 'center-file:conflict', hostKey: 'original-host' }]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error);
    const competing = render(<RightDockHost dockKey="center-file:conflict" hostKey="other-host" shown />);
    expect(prepared.commit()).toEqual({ ok: false, error: 'Dock state changed during return; inspect before retrying' });
    expect(element.closest('[data-dock-host]')?.getAttribute('data-dock-host')).toBe('center-file:conflict');
    competing.unmount();
    view.unmount();
  });
});
