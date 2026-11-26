import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { AgentMessageLedgerEntry } from '../../shared/agentMessage';
import { MAIL_COLLECT_MS, MAIL_SEND_PREVIEW_MS, type MailActivity } from '../../shared/mailActivity';
import type { AppContext } from '../context';

// The extra time covers folding and renderer/IPC latency. A stalled renderer still sends.
const DEPARTURE_TIMEOUT_MS = MAIL_SEND_PREVIEW_MS + MAIL_COLLECT_MS + 1000;

interface PendingDeparture {
  viewportId: string;
  release: () => boolean;
  stored: Promise<boolean>;
}

interface WindowDepartures {
  viewports: Map<string, string>;
  pending: Map<string, PendingDeparture>;
  byMessage: Map<string, PendingDeparture>;
}

const departuresByWindow = new WeakMap<BrowserWindow, WindowDepartures>();

function isForeground(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && !win.isDestroyed() && !win.isMinimized?.() && win.isVisible() && win.isFocused();
}

export function foregroundMailWindow(ctx: AppContext): BrowserWindow | undefined {
  const win = ctx.getWindow?.();
  return isForeground(win) ? win : undefined;
}

function windowDepartures(win: BrowserWindow): WindowDepartures {
  const existing = departuresByWindow.get(win);
  if (existing) return existing;
  const state: WindowDepartures = { viewports: new Map(), pending: new Map(), byMessage: new Map() };
  departuresByWindow.set(win, state);
  const release = () => { for (const departure of state.pending.values()) departure.release(); };
  const reset = () => { state.viewports.clear(); release(); };
  win.on('blur', release);
  win.on('hide', release);
  win.on('minimize', release);
  win.once('closed', reset);
  win.webContents.once('destroyed', reset);
  win.webContents.on('render-process-gone', reset);
  win.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) reset();
  });
  return state;
}

export function setMailDepartureViewport(win: BrowserWindow, viewportId: string, mailboxId: string, active: boolean): void {
  if (active) {
    windowDepartures(win).viewports.set(viewportId, mailboxId);
  } else {
    const state = departuresByWindow.get(win);
    if (state?.viewports.get(viewportId) !== mailboxId) return;
    state.viewports.delete(viewportId);
    for (const departure of state.pending.values()) {
      if (departure.viewportId === viewportId) departure.release();
    }
  }
}

export async function launchMailDepartures(win: BrowserWindow, viewportId: string, requestIds: string[]): Promise<boolean> {
  const state = departuresByWindow.get(win);
  const requested = new Set(requestIds);
  const stores: Promise<boolean>[] = [];
  for (const id of requested) {
    const departure = state?.pending.get(id);
    if (departure?.viewportId === viewportId && departure.release()) stores.push(departure.stored);
  }
  const stored = await Promise.all(stores);
  return stored.length > 0 && stored.length === requested.size && stored.every(Boolean);
}

export async function releaseMailDepartures(win: BrowserWindow): Promise<void> {
  const state = departuresByWindow.get(win);
  if (!state) return;
  state.viewports.clear();
  const pending = [...state.pending.values()];
  for (const departure of pending) departure.release();
  await Promise.all(pending.map(departure => departure.stored));
}

/** Hold the write outside SQLite and its queue so background mail can pass an on-screen preview. */
export function storeMailAtDeparture(ctx: AppContext, letter: MailActivity | undefined,
  store: () => Promise<AgentMessageLedgerEntry>, alreadyStored?: () => boolean): Promise<AgentMessageLedgerEntry> {
  const win = letter ? ctx.getWindow?.() : undefined;
  const state = win && departuresByWindow.get(win);
  if (!letter || !win || !state) return store();
  const key = JSON.stringify([letter.mailboxWorkspaceId, letter.id]);
  const previous = state.byMessage.get(key);
  const viewportId = isForeground(win) ? [...state.viewports].find(([, mailboxId]) => mailboxId === letter.from)?.[0] : undefined;
  if (previous) {
    if (!viewportId) previous.release();
    return previous.stored.then(store);
  }
  if (!viewportId || alreadyStored?.()) return store();

  const requestId = randomUUID();
  let proceed!: () => void;
  const ready = new Promise<void>(resolve => { proceed = resolve; });
  const result = ready.then(store).finally(() => {
    state.pending.delete(requestId);
    state.byMessage.delete(key);
  });
  const stored = result.then(() => true, () => false);
  let waiting = true;
  const release = () => {
    if (!waiting) return false;
    waiting = false;
    clearTimeout(timer);
    proceed();
    return true;
  };
  const timer = setTimeout(release, DEPARTURE_TIMEOUT_MS);
  const departure = { viewportId, release, stored };
  state.pending.set(requestId, departure);
  state.byMessage.set(key, departure);
  try {
    win.webContents.send('messages:departure', { requestId, viewportId, letter });
  } catch (error) {
    console.warn('[mailbox] departure preview unavailable', error);
    release();
  }
  return result;
}
