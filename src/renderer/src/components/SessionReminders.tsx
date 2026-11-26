import { ErrorTip } from './ErrorTip';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SessionReminder, SessionReminderSnapshot, SessionReminderTarget } from '../../../shared/sessionReminders';
import { AnimatedDetails } from './AnimatedDetails';
import { IconCheckSquare, IconChevronDown, IconClose, IconTrash } from './icons';
import { MOTION, usePresence } from './motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { isInsideOverlay } from '../keybindings/overlayStack';

type Props = {
  kind: SessionReminderTarget['kind'];
  id: string;
  visible: boolean;
  onOpenSource?: (messageId: string) => boolean;
  /** CLI 弹层位于可拖动输入区之外，避免被输入框的滚动容器裁切。 */
  popupHostRef?: React.RefObject<HTMLDivElement | null>;
};

export function SessionReminders({ kind, id, visible, onOpenSource, popupHostRef }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const target = useMemo<SessionReminderTarget>(() => kind === 'scheduler'
    ? { kind: 'scheduler', workspaceId: id } : { kind: 'session', sessionId: id }, [kind, id]);
  const targetKey = `${kind}:${id}`;
  const [state, setState] = useState<{ key: string; snapshot: SessionReminderSnapshot } | null>(null);
  const [open, setOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const sequence = useRef(0);
  const actionSequence = useRef(0);
  const current = useRef({ key: targetKey, visible });
  current.current = { key: targetKey, visible };
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [inlinePanelWidth, setInlinePanelWidth] = useState<number | null>(null);
  const focusId = useRef<string | null>(null);
  const presence = usePresence(open && visible, MOTION.microMs);
  const close = useCallback(() => setOpen(false), []);
  useOverlayDismiss(visible && presence.mounted && presence.stage !== 'out' && open, close);

  useLayoutEffect(() => {
    if (!open || !visible || popupHostRef?.current) {
      setInlinePanelWidth(null);
      return;
    }
    const overlay = wrapperRef.current;
    const shell = overlay?.closest<HTMLElement>('.chat-input-shell');
    if (!overlay || !shell) return;
    const update = (): void => {
      const trigger = overlay.getBoundingClientRect();
      const shellBounds = shell.getBoundingClientRect();
      const viewportRight = typeof window === 'undefined' ? shellBounds.right : window.innerWidth;
      const available = Math.max(0, Math.min(shellBounds.right, viewportRight) - trigger.left - 8);
      setInlinePanelWidth(Math.min(344, available));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(shell);
    observer?.observe(overlay);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [open, popupHostRef, visible]);

  const refresh = useCallback(async (): Promise<void> => {
    if (current.current.key !== targetKey || !current.current.visible) return;
    const request = ++sequence.current;
    try {
      const snapshot = await window.api.sessionReminders.list(target);
      if (request !== sequence.current || current.current.key !== targetKey || !current.current.visible) return;
      if (!snapshot || !Array.isArray(snapshot.items)) throw new Error('Invalid reminder response.');
      setState({ key: targetKey, snapshot });
      setError('');
    } catch (reason) {
      if (request === sequence.current && current.current.key === targetKey && current.current.visible) setError(t('待办提醒读取失败：{{error}}', { error: String(reason) }));
    }
  }, [target, targetKey, t]);

  useEffect(() => {
    actionSequence.current++;
    focusId.current = null;
    setBusyId(null);
    setError('');
    if (!visible || !id) { setOpen(false); return; }
    void refresh();
    const offChanged = window.api.on('sessionReminders:changed', changed => {
      const matches = changed.kind === target.kind && (changed.kind === 'session'
        ? target.kind === 'session' && changed.sessionId === target.sessionId
        : target.kind === 'scheduler' && changed.workspaceId === target.workspaceId);
      if (matches) void refresh();
    });
    const offHistory = kind === 'scheduler' ? window.api.on('agent:history', event => {
      if (Array.isArray(event) || !event.workspaceId || event.workspaceId === id) void refresh();
    }) : () => {};
    return () => { sequence.current++; actionSequence.current++; offChanged(); offHistory(); };
  }, [id, kind, refresh, target, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target) &&
          !panelRef.current?.contains(event.target) && !isInsideOverlay(event.target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [close, open, visible]);

  const snapshot = state?.key === targetKey ? state.snapshot : null;
  const items = snapshot?.items ?? [];
  const pending = items.filter(item => item.completedAt === null);
  const completed = items.filter(item => item.completedAt !== null);
  useLayoutEffect(() => {
    const idToFocus = focusId.current;
    if (!idToFocus || !open || !visible || busyId) return;
    const input = Array.from(panelRef.current?.querySelectorAll<HTMLInputElement>('input[data-reminder-id]') ?? [])
      .find(element => element.dataset.reminderId === idToFocus);
    if (input) input.focus();
    else panelRef.current?.querySelector<HTMLElement>('.session-reminders-done summary')?.focus();
    focusId.current = null;
  }, [snapshot, open, visible, busyId]);

  const toggle = async (item: SessionReminder): Promise<void> => {
    if (!snapshot?.scope || busyId) return;
    const action = ++actionSequence.current;
    const stillCurrent = (): boolean => actionSequence.current === action && current.current.key === targetKey && current.current.visible;
    setBusyId(item.id);
    try {
      await window.api.sessionReminders.setCompleted(target, snapshot.scope, item.id, item.completedAt === null);
      if (!stillCurrent()) return;
      focusId.current = item.id;
      await refresh();
    } catch (reason) {
      if (!stillCurrent()) return;
      await refresh();
      if (stillCurrent()) setError(t('待办提醒更新失败：{{error}}', { error: String(reason) }));
    } finally { if (stillCurrent()) setBusyId(null); }
  };

  const remove = async (item: SessionReminder): Promise<void> => {
    if (!snapshot?.scope || busyId) return;
    const action = ++actionSequence.current;
    const stillCurrent = (): boolean => actionSequence.current === action && current.current.key === targetKey && current.current.visible;
    const group = item.completedAt === null ? pending : completed;
    const index = group.findIndex(entry => entry.id === item.id);
    setBusyId(item.id);
    try {
      await window.api.sessionReminders.delete(target, snapshot.scope, item.id);
      if (!stillCurrent()) return;
      focusId.current = group[index + 1]?.id ?? group[index - 1]?.id ?? item.id;
      await refresh();
    } catch (reason) {
      if (!stillCurrent()) return;
      await refresh();
      if (stillCurrent()) setError(t('待办提醒删除失败：{{error}}', { error: String(reason) }));
    } finally { if (stillCurrent()) setBusyId(null); }
  };

  const row = (item: SessionReminder): React.JSX.Element => (
    <div className={`session-reminder-row${item.completedAt !== null ? ' is-complete' : ''}`} key={item.id}>
      <input type="checkbox" data-reminder-id={item.id} checked={item.completedAt !== null} disabled={busyId !== null}
        aria-label={item.completedAt !== null ? t('重新打开：{{text}}', { text: item.text }) : t('标记完成：{{text}}', { text: item.text })}
        onChange={() => void toggle(item)}/>
      <div className="session-reminder-copy">
        <span className="session-reminder-text">{item.text}</span>
        <div className="session-reminder-meta">
          <span>{item.completedAt === null ? t('AI 添加') : item.completedBy === 'ai' ? t('由 AI 完成') : t('由你完成')}</span>
          {item.sourceMessageId && onOpenSource ? <>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => {
              if (onOpenSource(item.sourceMessageId!)) close();
              else setError(t('原消息已不可用'));
            }}>{t('查看原消息')}</button>
          </> : null}
        </div>
      </div>
      <button className="session-reminder-delete" type="button" disabled={busyId !== null}
        title={t('删除提醒')} aria-label={t('删除提醒：{{text}}', { text: item.text })} onClick={() => void remove(item)}>
        <IconTrash size={14}/>
      </button>
    </div>
  );

  // Keep the regular panel under its trigger so the left edge follows the
  // reminder icon, just like the mode menu. CLI still supplies a dedicated
  // positioned host because its dialog clips overflow.
  const host = popupHostRef?.current;
  const panel = presence.mounted ? <section ref={panelRef} className="session-reminder-panel mp-pop mp-pop-up"
    style={inlinePanelWidth === null ? undefined : { width: `${inlinePanelWidth}px`, maxWidth: `${inlinePanelWidth}px` }}
    {...presence.spread} role="dialog" aria-label={t('用户待办提醒')}
    data-overlay-root={open && visible ? '' : undefined}
    aria-hidden={!open || !visible} {...(!open || !visible ? { inert: '' } : {})}>
      <div className="session-reminder-head"><div><strong>{t('用户待办提醒')}</strong>
        <div className="session-reminder-sub">{snapshot && pending.length > 0
          ? t('当前会话 · {{number}} 项待处理', { number: pending.length }) : t('当前会话')}</div></div>
        <button className="session-reminder-close" type="button" aria-label={t('关闭用户待办提醒')} onClick={close}><IconClose size={15}/></button>
      </div>
      {error ? <><ErrorTip message={error} /><button type="button" onClick={() => void refresh()}>{t('重试')}</button></> : null}
      <div className="session-reminder-list">{pending.length ? pending.map(row)
        : <div className="session-reminder-empty">{snapshot ? t('当前没有待处理的提醒') : t('正在读取…')}</div>}</div>
      <AnimatedDetails className="session-reminders-done" open={doneOpen} onToggle={setDoneOpen}
        summary={<><IconChevronDown size={14}/><span>{t('已完成 · {{number}}', { number: completed.length })}</span></>}>
        <div className="session-reminder-list">{completed.map(row)}</div>
      </AnimatedDetails>
      <div className="session-reminder-foot">{t('AI 添加提醒 · 你和 AI 都可以完成')}</div>
    </section> : null;

  return <div className="session-reminder-overlay" ref={wrapperRef} hidden={!visible} data-overlay-root={open && visible ? '' : undefined}>
    <button className="session-reminder-trigger" type="button" aria-label={t('用户待办提醒')} title={t('用户待办提醒')}
      aria-expanded={open && visible} onClick={() => setOpen(value => !value)}>
      <IconCheckSquare size={14}/><span className="session-reminder-label">{t('我的提醒')}</span>
      {error || !snapshot || pending.length > 0 ? <span className="session-reminder-count">
        {error ? '!' : snapshot ? pending.length : '–'}
      </span> : null}
    </button>
    {panel && host ? createPortal(panel, host) : panel}
  </div>;
}
