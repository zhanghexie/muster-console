import React, { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { RIGHT_UTILITY_IDS, type RightUtilityId } from '../../shared/rightWorkspace';
import type { SplitPaneRef } from '../../shared/centerSplit';
import type { ExtensionNavigationNode } from '../../shared/extensionNavigation';
import { useUiStore, useWorkspaceStore } from './store';
import { setExtensionPlacement as setExtensionPlacement, useExtensionWorkbenchNavigation as useWorkbenchNavigation } from './extensionWorkbench';
import { jumpToSession } from './sessionJump';

/**
 * 固定到右侧：会话（终端 / GUI）与内置实用功能在中栏只有一个视图实例（TerminalView 按 sessionId
 * 注册截图/粘贴并推送 pty 尺寸，GUI 会话持有 composer 草稿），挂两份会互相抢。右侧标签登记宿主，
 * 中栏的 DockSurface 把同一 DOM 移过去；标签关闭后移回中栏原位。同一 key 有多个宿主时优先正在显示的，
 * 其次最近登记的。扩展导航入口沿用 ExtensionSurface 与 navigation placement，不走这里的宿主表。
 */
interface DockTarget { element: HTMLElement; shown: boolean; order: number }
export interface RightDockSnapshot { docked: ReadonlySet<string>; shown: ReadonlySet<string> }

export const rightDockKey = (ref: SplitPaneRef): string | null =>
  ref.kind === 'session' ? `session:${ref.sessionId}` : ref.kind === 'utility' && isRightUtility(ref.sel) ? `utility:${ref.sel}` : null;
export const isRightUtility = (sel: string): sel is RightUtilityId => (RIGHT_UTILITY_IDS as readonly string[]).includes(sel);
export const centerFileDockKey = (tabId: string): string => `center-file:${tabId}`;
export const centerFileHostKey = (tabId: string): string => `center-file-host:${tabId}`;

const targets = new Map<string, Map<string, DockTarget>>();
interface DockSource { host: HTMLElement; home: HTMLElement; preserveEmbeddedState: boolean }
const sources = new Map<string, Set<DockSource>>();
const returningDockKeys = new Set<string>();
const listeners = new Set<() => void>();
let nextOrder = 0;
let snapshot: RightDockSnapshot = { docked: new Set(), shown: new Set() };

function emit(): void {
  const docked = new Set<string>(), shown = new Set<string>();
  for (const [key, hosts] of targets) {
    if (!hosts.size) continue;
    docked.add(key);
    if ([...hosts.values()].some(host => host.shown)) shown.add(key);
  }
  snapshot = { docked, shown };
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const rightDockSnapshot = (): RightDockSnapshot => snapshot;
export const useRightDock = (): RightDockSnapshot => useSyncExternalStore(subscribe, rightDockSnapshot);

function targetFor(key: string): HTMLElement | undefined {
  const hosts = [...(targets.get(key)?.values() ?? [])];
  return (hosts.find(host => host.shown) ?? hosts.sort((a, b) => b.order - a.order)[0])?.element;
}

type DockReturnResult = { ok: true } | { ok: false; error: string };
/** Move all surfaces home while retaining their hosts until the caller commits or rolls back. */
export function beginDockReturn(requests: readonly { dockKey: string; hostKey: string }[]):
  { ok: true; commit(): DockReturnResult; rollback(): DockReturnResult } | { ok: false; error: string } {
  const records: Array<{ dockKey: string; hostKey: string; hosts: Map<string, DockTarget>; target: DockTarget; source: DockSource; original: HTMLElement }> = [];
  const seen = new Set<string>();
  for (const { dockKey, hostKey } of requests) {
    if (seen.has(dockKey)) return { ok: false, error: 'Duplicate dock target' };
    if (returningDockKeys.has(dockKey)) return { ok: false, error: 'Dock return is already pending' };
    seen.add(dockKey);
    const hosts = targets.get(dockKey), target = hosts?.get(hostKey);
    if (!hosts || !target) return { ok: false, error: 'Dock target is unavailable' };
    const matching = [...(sources.get(dockKey) ?? [])];
    if (hosts.size !== 1 || matching.length !== 1) return { ok: false, error: 'Dock target or surface is ambiguous' };
    const source = matching[0]!, original = source.host.parentElement;
    if (!source.host.isConnected || !source.home.isConnected || !target.element.isConnected ||
        (original !== target.element && original !== source.home)) return { ok: false, error: 'Dock surface or target is no longer current' };
    records.push({ dockKey, hostKey, hosts, target, source, original });
  }
  for (const { dockKey } of records) returningDockKeys.add(dockKey);
  const unlock = (): void => { for (const { dockKey } of records) returningDockKeys.delete(dockKey); };
  const restore = (): string[] => {
    const failures: string[] = [];
    for (const { source, original } of [...records].reverse()) {
      try { moveDockSurface(source.host, original, source.preserveEmbeddedState); }
      catch (rollback) { failures.push(rollback instanceof Error ? rollback.message : String(rollback)); }
    }
    return failures;
  };
  try {
    for (const { source } of records) {
      moveDockSurface(source.host, source.home, source.preserveEmbeddedState);
      if (source.host.parentElement !== source.home) throw new Error('Surface return was not confirmed');
    }
    for (const { dockKey, hostKey, hosts, target, source } of records) {
      if (targets.get(dockKey) !== hosts || hosts.size !== 1 || hosts.get(hostKey) !== target || !sources.get(dockKey)?.has(source)) {
        throw new Error('Dock state changed during return; inspect before retrying');
      }
    }
  } catch (error) {
    const failures = restore();
    unlock();
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: failures.length ? `${message}; rollback failed, inspect views: ${failures.join('; ')}` : message };
  }
  let finished = false;
  const completed = (): DockReturnResult => ({ ok: false, error: 'Dock return transaction is already finished' });
  return { ok: true,
    rollback: () => {
      if (finished) return completed();
      finished = true;
      const failures = restore();
      unlock();
      return failures.length ? { ok: false, error: `Rollback failed, inspect views: ${failures.join('; ')}` } : { ok: true };
    },
    commit: () => {
      if (finished) return completed();
      for (const { dockKey, hostKey, hosts, target, source } of records) {
        if (targets.get(dockKey) !== hosts || hosts.size !== 1 || hosts.get(hostKey) !== target ||
            !sources.get(dockKey)?.has(source) || source.host.parentElement !== source.home) {
          finished = true;
          const failures = restore();
          unlock();
          return { ok: false, error: `Dock state changed during return; inspect before retrying${failures.length ? `; rollback failed: ${failures.join('; ')}` : ''}` };
        }
      }
      finished = true;
      for (const { dockKey, hostKey, hosts } of records) {
        hosts.delete(hostKey);
        if (!hosts.size && targets.get(dockKey) === hosts) targets.delete(dockKey);
      }
      unlock();
      if (records.length) emit();
      return { ok: true };
    }
  };
}

/** Return every surface before unregistering any host; roll back earlier moves on failure. */
export function releaseDockTargets(requests: readonly { dockKey: string; hostKey: string }[]): DockReturnResult {
  const transaction = beginDockReturn(requests);
  return transaction.ok ? transaction.commit() : transaction;
}

/** Remove an explicitly managed host only after its live surface has safely returned home. */
export function releaseDockTarget(dockKey: string, hostKey: string): { ok: true } | { ok: false; error: string } {
  return releaseDockTargets([{ dockKey, hostKey }]);
}

export function releaseCenterFileDock(tabId: string): { ok: true } | { ok: false; error: string } {
  const key = centerFileDockKey(tabId);
  return rightDockSnapshot().docked.has(key) ? releaseDockTarget(key, centerFileHostKey(tabId)) : { ok: true };
}

export function RightDockHost({ dockKey, hostKey, shown }: { dockKey: string; hostKey: string; shown: boolean }): React.JSX.Element {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useLayoutEffect(() => {
    if (!element) return;
    const hosts = targets.get(dockKey) ?? new Map<string, DockTarget>();
    targets.set(dockKey, hosts);
    hosts.set(hostKey, { element, shown: shownRef.current, order: nextOrder++ });
    emit();
    return () => {
      if (targets.get(dockKey) !== hosts || hosts.get(hostKey)?.element !== element) return;
      hosts.delete(hostKey);
      if (!hosts.size) targets.delete(dockKey);
      emit();
    };
  }, [element, dockKey, hostKey]);
  useLayoutEffect(() => {
    const host = targets.get(dockKey)?.get(hostKey);
    if (!host || host.shown === shown) return;
    host.shown = shown;
    emit();
  }, [dockKey, hostKey, shown]);
  return <div className="right-dock-host" ref={setElement} data-dock-host={dockKey}/>;
}

/** Preserve embedded browsing/media state when a file surface changes hosts. */
export function moveDockSurface(host: HTMLElement, destination: HTMLElement, preserveEmbeddedState = false): void {
  if (host.parentElement === destination) return;
  if (preserveEmbeddedState && host.isConnected && !destination.isConnected) throw new Error('Destination is disconnected');
  const connectedMove = host.isConnected && destination.isConnected;
  if (connectedMove && preserveEmbeddedState && host.querySelector('webview')) throw new Error('Moving a live webview cannot preserve its guest');
  const moveBefore = (destination as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
  if (moveBefore && connectedMove) {
    try {
      moveBefore.call(destination, host, null);
      if (host.parentElement !== destination) throw new Error('Surface move was not confirmed');
      return;
    }
    catch (error) { if (preserveEmbeddedState) throw error; }
  }
  if (connectedMove && preserveEmbeddedState && host.querySelector('iframe, audio, video')) throw new Error('Moving this view would reload embedded content');
  destination.appendChild(host);
}

export function DockSurface({ dockKey, children, preserveEmbeddedState = false, onMoveError, onMoveStatus }: { dockKey: string; children: React.ReactNode;
  preserveEmbeddedState?: boolean; onMoveError?: (error: unknown) => void; onMoveStatus?: (success: boolean) => void }): React.JSX.Element {
  const home = useRef<HTMLDivElement>(null);
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'right-dock-surface'; return element; });
  const onMoveErrorRef = useRef(onMoveError); onMoveErrorRef.current = onMoveError;
  const onMoveStatusRef = useRef(onMoveStatus); onMoveStatusRef.current = onMoveStatus;
  useLayoutEffect(() => {
    const homeElement = home.current;
    if (!homeElement) return;
    const source: DockSource = { host, home: homeElement, preserveEmbeddedState };
    const registered = sources.get(dockKey) ?? new Set<DockSource>();
    registered.add(source); sources.set(dockKey, registered);
    const move = (): void => {
      if (returningDockKeys.has(dockKey)) return;
      const destination = targetFor(dockKey) ?? home.current;
      if (!destination) return;
      if (host.parentElement === destination) { onMoveStatusRef.current?.(true); return; }
      try { moveDockSurface(host, destination, preserveEmbeddedState); onMoveStatusRef.current?.(true); }
      catch (error) { onMoveStatusRef.current?.(false); if (onMoveErrorRef.current) onMoveErrorRef.current(error); else throw error; }
    };
    move();
    listeners.add(move);
    return () => { listeners.delete(move); registered.delete(source); if (!registered.size && sources.get(dockKey) === registered) sources.delete(dockKey); };
  }, [host, dockKey, preserveEmbeddedState]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return <><div className="right-dock-home" ref={home}/>{createPortal(children, host)}</>;
}

// ── 固定请求通道：左栏/中栏发起，右侧工作面（SideToolsPanel）持有标签并执行 ──
export type RightPinCommand = 'pin' | 'unpin' | 'reveal';
export interface RightPinRequest { workspaceId: string; ref: Extract<SplitPaneRef, { kind: 'session' | 'utility' }>; command: RightPinCommand }
const pinListeners = new Set<(request: RightPinRequest) => void>();
export function onRightPinRequest(listener: (request: RightPinRequest) => void): () => void {
  pinListeners.add(listener);
  return () => { pinListeners.delete(listener); };
}
export function requestRightPin(request: RightPinRequest): void {
  pinListeners.forEach(listener => listener(request));
}

/** 「移回中栏」后在中栏选中：会话走 jumpToSession（sessions:reveal 收工具层并露出会话页），工具交给 App 的选择入口 */
const centerUtilityListeners = new Set<(sel: string) => void>();
export function onCenterUtilityRequest(listener: (sel: string) => void): () => void {
  centerUtilityListeners.add(listener);
  return () => { centerUtilityListeners.delete(listener); };
}
export function showInCenter(ref: SplitPaneRef): Promise<unknown> {
  if (ref.kind === 'session') return jumpToSession({ sessionId: ref.sessionId });
  if (ref.kind === 'utility') centerUtilityListeners.forEach(listener => listener(ref.sel));
  return Promise.resolve();
}

/** 右侧发布当前项目已固定的会话 / 工具 dock key */
let pins: { workspaceId: string; keys: ReadonlySet<string> } = { workspaceId: '', keys: new Set() };
const pinStateListeners = new Set<() => void>();
export function publishRightPins(workspaceId: string, keys: string[]): void {
  if (pins.workspaceId === workspaceId && pins.keys.size === keys.length && keys.every(key => pins.keys.has(key))) return;
  pins = { workspaceId, keys: new Set(keys) };
  pinStateListeners.forEach(listener => listener());
}
export const rightPinsSnapshot = (): typeof pins => pins;
const useRightPins = (): typeof pins => useSyncExternalStore(listener => { pinStateListeners.add(listener); return () => { pinStateListeners.delete(listener); }; }, rightPinsSnapshot);

const navExtensionNode = (ref: SplitPaneRef, nodes: ExtensionNavigationNode[]): ExtensionNavigationNode | undefined =>
  ref.kind === 'utility' && ref.sel.startsWith('nav:') ? nodes.find(node => node.id === ref.sel.slice(4) && node.kind === 'extension') : undefined;

export interface RightPinApi {
  /** 会话、内置实用功能与扩展导航入口可固定；文件夹、空选择器与直接扩展面板不可 */
  canPin: (ref: SplitPaneRef) => boolean;
  isPinned: (ref: SplitPaneRef) => boolean;
  pin: (ref: SplitPaneRef) => void;
  unpin: (ref: SplitPaneRef) => void;
  /** 取下并在中栏选中（左栏菜单 / 右侧工具栏的「移回中栏」） */
  moveToCenter: (ref: SplitPaneRef) => void;
  reveal: (ref: SplitPaneRef) => void;
}

export function useRightPin(): RightPinApi {
  const { t } = useTranslation();
  const { activeWorkspaceId } = useWorkspaceStore();
  const { flashTip } = useUiStore();
  const workspaceId = activeWorkspaceId ?? '';
  const navigation = useWorkbenchNavigation(workspaceId);
  const state = useRightPins();
  const canPin = useCallback((ref: SplitPaneRef): boolean => !!rightDockKey(ref) || !!navExtensionNode(ref, navigation.nodes), [navigation.nodes]);
  const isPinned = useCallback((ref: SplitPaneRef): boolean => {
    const node = navExtensionNode(ref, navigation.nodes);
    if (node) return node.placement === 'tab';
    const key = rightDockKey(ref);
    return !!key && state.workspaceId === workspaceId && state.keys.has(key);
  }, [navigation.nodes, state, workspaceId]);
  const send = useCallback((ref: SplitPaneRef, command: RightPinCommand): void => {
    if (!workspaceId) return;
    const node = navExtensionNode(ref, navigation.nodes);
    if (node) {
      if (command === 'reveal') { requestRightPin({ workspaceId, ref: { kind: 'utility', sel: `nav:${node.id}` }, command }); return; }
      if (command === 'pin' && !('moveBefore' in document.body)) { flashTip(t('当前浏览器不支持保留扩展页面的跨屏移动，请升级浏览器或使用桌面应用')); return; }
      void setExtensionPlacement(navigation.workspaceId, node.id, command === 'pin' ? 'tab' : 'center').catch(error => flashTip(String(error instanceof Error ? error.message : error)));
      if (command === 'pin') requestRightPin({ workspaceId, ref: { kind: 'utility', sel: `nav:${node.id}` }, command: 'reveal' });
      return;
    }
    if ((ref.kind === 'session' || ref.kind === 'utility') && rightDockKey(ref)) requestRightPin({ workspaceId, ref, command });
  }, [workspaceId, navigation.nodes, navigation.workspaceId, flashTip, t]);
  return {
    canPin, isPinned,
    pin: useCallback(ref => send(ref, 'pin'), [send]),
    unpin: useCallback(ref => send(ref, 'unpin'), [send]),
    moveToCenter: useCallback(ref => {
      send(ref, 'unpin');
      void showInCenter(ref).catch(error => flashTip(String(error instanceof Error ? error.message : error)));
    }, [send, flashTip]),
    reveal: useCallback(ref => send(ref, 'reveal'), [send])
  };
}
