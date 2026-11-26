import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { showTip } from '../tips';
import { PANEL_ESCAPE_EVENT } from '../../../shared/panelRelay';

/** Fullscreen the document so existing body portals and iframe parents stay intact.
 * The pane's CSS temporarily fills that document; split state is never rewritten. */
export function usePaneFullscreen<T extends string | number>(identity: string, mainRef: RefObject<HTMLElement | null>, isCurrent?: (value: T) => boolean) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<{ value: T; identity: string } | null>(null);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const owner = useRef<{ identity: string; entered: boolean; pending: boolean; cancelled: boolean } | null>(null);
  const mounted = useRef(true);
  const accepts = useRef(isCurrent); accepts.current = isCurrent;
  const report = useCallback((error: unknown) => showTip(t('无法切换全屏：{{error}}', {
    error: error instanceof Error ? error.message : String(error)
  }), { tone: 'error' }), [t]);
  const exit = useCallback(async () => {
    const operation = owner.current;
    if (!operation) return;
    if (operation.pending) { operation.cancelled = true; return; }
    try {
      if (operation.entered && document.fullscreenElement === document.documentElement) await document.exitFullscreen();
      if (owner.current === operation) { owner.current = null; if (mounted.current) setTarget(null); }
    } catch (error) { report(error); }
  }, [report]);
  const enter = useCallback(async (value: T) => {
    if (owner.current) {
      if (!owner.current.pending && owner.current.identity === identity && !owner.current.cancelled && document.fullscreenElement === document.documentElement && (!accepts.current || accepts.current(value))) setTarget({ value, identity });
      return;
    }
    const operation = { identity, entered: !document.fullscreenElement, pending: true, cancelled: false };
    owner.current = operation;
    try {
      if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) throw new Error(t('当前环境不支持全屏，请在桌面应用或支持全屏的浏览器中打开'));
      if (operation.entered) await document.documentElement.requestFullscreen();
      operation.pending = false;
      if (document.fullscreenElement !== document.documentElement) throw new Error(t('请先退出其他内容的全屏，再重试'));
      if (!mounted.current || operation.cancelled || accepts.current && !accepts.current(value) || currentIdentity.current !== operation.identity || owner.current !== operation) {
        await exit(); return;
      }
      setTarget({ value, identity });
    } catch (error) {
      if (owner.current === operation) owner.current = null;
      report(error);
    }
  }, [identity, exit, report, t]);
  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement !== document.documentElement) { owner.current = null; setTarget(null); }
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => { if (owner.current && owner.current.identity !== identity) void exit(); }, [identity, exit]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !owner.current) return;
      event.preventDefault(); event.stopPropagation(); void exit();
    };
    const guestEscape = (event: MessageEvent) => {
      if (!target || event.data?.__ma !== true || event.data?.type !== PANEL_ESCAPE_EVENT) return;
      for (const iframe of mainRef.current?.querySelectorAll('iframe') ?? []) {
        if (iframe.contentWindow === event.source && !iframe.closest('[inert], [aria-hidden="true"]')) { void exit(); return; }
      }
    };
    window.addEventListener('keydown', escape, true); window.addEventListener('message', guestEscape);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('message', guestEscape); };
  }, [exit, mainRef, target]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void exit(); };
  }, [exit]);
  return { target: target?.identity === identity ? target.value : null, enter, exit };
}
