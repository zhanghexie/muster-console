import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { emptyUiWidgetState, uiWidgetIdentity, validateUiWidgetAction, type UiWidgetSnapshot, type UiWidgetStatePatch, type UiWidgetActionResult, type UiRenderStatus, type UiWidgetDiagnostic } from '../../../shared/uiWidgetProtocol';
import { subscribeAppearance } from '../theme';
import { subscribeUiFont } from '../uiFont';
import { uiWidgetAppearance } from './uiWidgetAppearance';
import { UI_FOLLOWUP_EVENT, type UiFollowupDetail } from './uiWidgetEvents';
import { localizeUiWidgetHostError } from '../../../shared/uiWidgetHostErrors';
import { subscribeLocale } from '../../../shared/i18n';
import { ChatLinkOwnerContext } from './chatLinkOwner';

export function uiWidgetScrollContainer(node: Element | null): HTMLElement | null {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

export function useUiWidgetBridge(filePath: string, card: RefObject<HTMLElement | null>, frame: RefObject<HTMLIFrameElement | null>, attempt: number, sessionPage = false,
  onSessionDraft?: (sessionId: string, text: string) => void) {
  const { t } = useTranslation();
  const owner = useContext(ChatLinkOwnerContext);
  const [title, setTitle] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [warning, setWarning] = useState<{ text: string; host: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const saved = useRef<UiWidgetSnapshot | null>(null);
  const boot = useRef<Promise<void>>(Promise.resolve());
  const live = useRef(true);
  const receiptSource = useRef(crypto.randomUUID());
  const collapsedRef = useRef(collapsed); collapsedRef.current = collapsed;
  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ __ma: true, ...message }, '*');
  }, [frame]);
  const postAppearance = useCallback(() => post({ type: 'appearance', ...uiWidgetAppearance(card.current) }), [post, card]);

  useEffect(() => {
    const source = crypto.randomUUID(); receiptSource.current = source;
    return () => { void window.api.uiWidgets?.releaseReceipt?.(filePath, source).catch(() => { /* The artifact may already have been removed. */ }); };
  }, [filePath]);

  useEffect(() => {
    live.current = true;
    let active = true;
    setLoaded(false);
    boot.current = (async () => {
      try {
        const snapshot = await window.api.uiWidgets?.read?.(filePath);
        if (!active || !snapshot?.state) return;
        saved.current = snapshot; setTitle(snapshot.title); setCollapsed(snapshot.state.presentation.collapsed);
      } catch (error) { if (active) setWarning({ text: String((error as Error).message), host: true }); }
      finally { if (active) setLoaded(true); }
    })();
    return () => { active = false; live.current = false; };
  }, [filePath, attempt]);

  useEffect(() => {
    const off = window.api.on('uiWidget:changed', snapshot => {
      if (uiWidgetIdentity(snapshot.path) !== uiWidgetIdentity(filePath)) return;
      saved.current = snapshot; setCollapsed(snapshot.state.presentation.collapsed);
      post({ type: 'state-sync', state: snapshot.state });
    });
    const offAppearance = subscribeAppearance(postAppearance), offFont = subscribeUiFont(postAppearance), offLocale = subscribeLocale(postAppearance);
    return () => { off(); offAppearance(); offFont(); offLocale(); };
  }, [filePath, post, postAppearance]);

  const receipt = useCallback((status: UiRenderStatus, visible: boolean, error?: string, diagnostics?: UiWidgetDiagnostic[]) => {
    void window.api.uiWidgets?.receipt?.(filePath, {
      status, visible: visible && !collapsedRef.current, ...(error ? { error } : {}), ...(diagnostics ? { diagnostics } : {})
    }, receiptSource.current).catch(() => { /* telemetry failure does not destroy otherwise usable content */ });
  }, [filePath]);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsedRef.current;
    uiWidgetScrollContainer(card.current)?.dispatchEvent(new CustomEvent('chat-scroll:user-interaction'));
    setCollapsed(next);
    void window.api.uiWidgets.save(filePath, { presentation: { collapsed: next } }).then(snapshot => {
      if (snapshot?.state) saved.current = snapshot;
    }).catch(error => setWarning({ text: String(error.message), host: true }));
  }, [filePath, card]);

  /** Caller has already checked event.source and the __ma marker. */
  const process = useCallback((data: Record<string, any>): boolean => {
    const origin = frame.current?.contentWindow;
    const reply = (message: Record<string, unknown>): void => {
      if (live.current && origin === frame.current?.contentWindow) origin?.postMessage({ __ma: true, ...message }, '*');
    };
    if (data.type === 'ready') {
      void boot.current.then(() => reply({ type: 'init', state: saved.current?.state ?? emptyUiWidgetState(), ...uiWidgetAppearance(card.current) }));
      return true;
    }
    if (data.type === 'wheel') {
      if (typeof data.deltaY !== 'number' || !Number.isFinite(data.deltaY)) return true;
      const owner = uiWidgetScrollContainer(card.current);
      if (owner) {
        owner.dispatchEvent(new CustomEvent('chat-scroll:user-interaction'));
        const scale = data.deltaMode === 1 ? 16 : data.deltaMode === 2 ? owner.clientHeight : 1;
        owner.scrollTop += data.deltaY * scale;
      }
      return true;
    }
    if (data.type === 'state-warning') { setWarning({ text: String(data.message || t('交互状态保存失败')), host: false }); return true; }
    if (data.type === 'state') {
      void (async () => {
        try {
          await boot.current;
          const snapshot = await window.api.uiWidgets.save(filePath, data.state as UiWidgetStatePatch);
          if (!snapshot?.state) throw new Error(t('交互状态保存失败'));
          saved.current = snapshot; setWarning(null);
          reply({ type: 'state-result', id: data.id, ok: true, state: snapshot.state });
        } catch (error) {
          const message = String((error as Error).message); setWarning({ text: message, host: true });
          reply({ type: 'state-result', id: data.id, ok: false, error: message });
        }
      })();
      return true;
    }
    if (data.type !== 'action') return false;
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      reply({ type: 'action-result', id: data.id, ok: false, error: t('请点击或用键盘触发此操作') }); return true;
    }
    void (async () => {
      try {
        const action = validateUiWidgetAction(data.action);
        await boot.current;
        let result: UiWidgetActionResult;
        result = await (sessionPage ? window.api.uiWidgets.sessionAction : window.api.uiWidgets.action)(filePath, action, data.state);
        if (!live.current) return;
        if (!result?.ok) throw new Error(result?.error || t('交互操作失败'));
        if (sessionPage && !result.cancelled && result.type === 'followup' && result.mode !== 'send' && result.text) {
          if (!result.sessionId || !onSessionDraft) throw new Error(t('找不到所属会话输入框'));
          onSessionDraft(result.sessionId, result.text);
        }
        if (!sessionPage && !result.cancelled && result.type === 'openUrl' && result.url) await window.api.browser.open({ url: result.url, ...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}), ...(owner.sessionId ? { sessionId: owner.sessionId } : {}), ...(owner.scope ? { scope: owner.scope } : {}) });
        if (!sessionPage && !result.cancelled && result.type === 'followup' && result.text) {
          const text = result.text, mode = result.mode;
          result = await new Promise<UiWidgetActionResult>(resolve => {
            let claimed = false;
            const detail: UiFollowupDetail = { text, mode, el: card.current,
              claim: () => { if (claimed) return false; claimed = true; return true; }, respond: resolve };
            window.dispatchEvent(new CustomEvent(UI_FOLLOWUP_EVENT, { detail }));
            if (!claimed) resolve({ ok: false, error: t('找不到所属会话输入框') });
          });
        }
        if (!result.ok) throw new Error(result.error || t('交互操作失败'));
        reply({ type: 'action-result', id: data.id, ok: true, result });
      } catch (error) { reply({ type: 'action-result', id: data.id, ok: false, error: String((error as Error).message) }); }
    })();
    return true;
  }, [filePath, frame, card, t, sessionPage, onSessionDraft, owner.workspaceId, owner.sessionId, owner.scope]);
  return { title, collapsed, warning: warning ? warning.host ? localizeUiWidgetHostError(warning.text) : warning.text : '', loaded, toggleCollapsed, postAppearance, receipt, process };
}
