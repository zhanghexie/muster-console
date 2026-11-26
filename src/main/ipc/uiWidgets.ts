import { sendSessionMail } from '../messages/assignment';
import { uiWidgetSessionFromDirectory } from '../../shared/uiWidgetSession';
import { app, clipboard, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { AppContext } from '../context';
import { handle } from './handle';
import { getUiWidgetStore } from '../uiWidgetStore';
import { validateUiWidgetAction, uiWidgetIdentity, type UiWidgetReceipt, type UiWidgetActionResult, type UiWidgetSnapshot } from '../../shared/uiWidgetProtocol';
import { parseExternalFileUrl } from '../../shared/filePreview';
import { t } from '../../shared/i18n';
import { localizeMailboxUserText } from '../../shared/mailboxUserErrors';

export function registerUiWidgetIpc(ctx: AppContext): void {
  const store = getUiWidgetStore(app.getPath('userData'));
  const guestSources = new Map<number, { generation: number; paths: Set<string> }>();
  const guestSource = (event: IpcMainInvokeEvent, filePath: string): string => {
    const id = event.sender.id;
    let entry = guestSources.get(id);
    if (!entry) {
      entry = { generation: 0, paths: new Set() }; guestSources.set(id, entry);
      const retire = (): void => {
        const current = guestSources.get(id); if (!current) return;
        const source = `guest:${id}:${current.generation++}`, paths = [...current.paths]; current.paths.clear();
        for (const item of paths) void store.releaseReceipt(item, source).catch(error => console.warn('Widget receipt release failed:', error));
      };
      event.sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) retire(); });
      event.sender.once('destroyed', () => { retire(); guestSources.delete(id); });
    }
    entry.paths.add(filePath);
    return `guest:${id}:${entry.generation}`;
  };
  const cardSource = (event: IpcMainInvokeEvent, source: string): string => {
    if (typeof source !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(source)) throw new Error('Invalid widget presentation identity');
    return `card:${event.sender.id}:${source}`;
  };
  const cardSources = new Map<number, Map<string, { path: string; source: string }>>();
  const trackCard = (event: IpcMainInvokeEvent, filePath: string, source: string): void => {
    const id = event.sender.id;
    let entries = cardSources.get(id);
    if (!entries) {
      entries = new Map(); cardSources.set(id, entries);
      const retire = (): void => {
        const current = cardSources.get(id); if (!current) return;
        const items = [...current.values()]; current.clear();
        for (const item of items) void store.releaseReceipt(item.path, item.source).catch(error => console.warn('Widget receipt release failed:', error));
      };
      event.sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) retire(); });
      event.sender.once('destroyed', () => { retire(); cardSources.delete(id); });
    }
    entries.set(JSON.stringify([filePath, source]), { path: filePath, source });
  };
  const isUiGuest = (contents: WebContents): boolean => !contents.isDestroyed()
    && contents.getType() === 'webview';
  const guestPath = (event: IpcMainInvokeEvent): string => {
    const parsed = parseExternalFileUrl(event.sender.getURL());
    if (!isUiGuest(event.sender) || !parsed) throw new Error(t('交互页面未连接宿主'));
    return parsed.absPath; // The store validates real containment; guests cannot supply another path.
  };
  const publish = (snapshot: UiWidgetSnapshot): void => {
    ctx.getWindow()?.webContents.send('uiWidget:changed', snapshot);
    for (const guest of webContents.getAllWebContents()) {
      if (!isUiGuest(guest)) continue;
      const parsed = parseExternalFileUrl(guest.getURL());
      if (parsed && uiWidgetIdentity(parsed.absPath) === uiWidgetIdentity(snapshot.path)) guest.send('uiWidget:changed', snapshot);
    }
  };
  const save = async (filePath: string, patch: unknown) => { const snapshot = await store.writeState(filePath, patch); publish(snapshot); return snapshot; };
  const act = async (filePath: string, request: unknown, state?: unknown, guest = false, background = false, sessionPage = false, opener?: { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session'; openerId: string } | null): Promise<UiWidgetActionResult> => {
    const action = validateUiWidgetAction(request);
    const snapshot = state ? await save(filePath, state) : await store.read(filePath);
    const sessionId = uiWidgetSessionFromDirectory(snapshot.path.split('/').slice(-3)[0]!);
    if (action.type === 'copy') { clipboard.writeText(action.text); return { ok: true, type: 'copy' }; }
    if (action.type === 'openUrl') {
      if (guest) {
        if (!ctx.browser) throw new Error(t('网页区未就绪'));
        ctx.browser.createTab(action.url, opener ?? { sessionId, workspaceId: ctx.sessions.get(sessionId)?.workspaceId, scope: 'session' }, { background });
      }
      return { ok: true, type: 'openUrl', url: action.url };
    }
    if (action.mode === 'send') {
      const confirmation = await ctx.ui.confirm(action.title || t('继续提问'), action.text);
      if (!confirmation.confirmed) return { ok: true, cancelled: true, type: 'followup' };
      if (guest) {
        try {
          const sent = await sendSessionMail(ctx, { sessionId, text: action.text }) as { stored?: boolean; error?: string };
          if (!sent.stored) throw new Error(sent.error || t('消息未发送'));
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const detail = localizeMailboxUserText(error.message);
          if (detail === error.message) throw error;
          throw new Error(detail, { cause: error });
        }
      }
    } else if (guest) {
      const session = ctx.sessions.get(sessionId);
      if (!session) throw new Error(t('所属会话已关闭'));
      if (!sessionPage) {
        const window = ctx.getWindow(); if (!window) throw new Error(t('会话窗口已关闭'));
        window.webContents.send('uiWidget:draft', { sessionId, text: action.text });
      }
    }
    return { ok: true, type: 'followup', text: action.text, mode: action.mode || 'draft', sessionId };
  };
  handle('uiWidget:read', (_event, filePath: string) => store.read(filePath));
  handle('uiWidget:list', (_event, sessionId: string) => store.list(sessionId));
  handle('uiWidget:session-action', (_event, filePath: string, request: unknown, state?: unknown) => act(filePath, request, state, true, false, true));
  handle('uiWidget:save', (_event, filePath: string, patch: unknown) => save(filePath, patch));
  handle('uiWidget:receipt', (event, filePath: string, receipt: Omit<UiWidgetReceipt, 'updatedAt'>, source: string) => {
    const key = cardSource(event, source); trackCard(event, filePath, key); return store.writeReceipt(filePath, receipt, key);
  });
  handle('uiWidget:release-receipt', (event, filePath: string, source: string) => {
    const key = cardSource(event, source); cardSources.get(event.sender.id)?.delete(JSON.stringify([filePath, key]));
    return store.releaseReceipt(filePath, key);
  });
  handle('uiWidget:action', (_event, filePath: string, request: unknown, state?: unknown) => act(filePath, request, state));
  handle('uiWidget:guest-read', event => store.read(guestPath(event)));
  handle('uiWidget:guest-save', (event, patch: unknown) => save(guestPath(event), patch));
  handle('uiWidget:guest-receipt', (event, receipt: Omit<UiWidgetReceipt, 'updatedAt'>) => {
    const filePath = guestPath(event);
    return store.writeReceipt(filePath, receipt, guestSource(event, filePath));
  });
  handle('uiWidget:guest-action', (event, request: unknown, state?: unknown) => {
    // The initiating input may finish while the durable widget state is being read/written.
    // Capture its trusted source before the first await, rather than consulting current UI state.
    const background = ctx.browser?.shouldOpenInBackground(event.sender.id) === true;
    const opener = ctx.browser?.ownerForContents?.(event.sender.id);
    return act(guestPath(event), request, state, true, background, false, opener);
  });
}
