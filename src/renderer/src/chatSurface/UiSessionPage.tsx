import React from 'react';
import { useTranslation } from 'react-i18next';
import type { UiWidgetSnapshot } from '../../../shared/uiWidgetProtocol';
import { UiWidgetCard } from './UiWidgetCard';
import { localizeUiWidgetHostError } from '../../../shared/uiWidgetHostErrors';

/** UI-only transcript: reuse GUI cards, without chat or tool logs. */
export function UiSessionPage({ sessionId, visible, onDraft }: { sessionId: string; visible: boolean; onDraft?: (text: string) => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [widgets, setWidgets] = React.useState<UiWidgetSnapshot[]>([]);
  const [error, setError] = React.useState('');
  const [retry, setRetry] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);
  const latest = React.useRef<string | null>(null);
  const onSessionDraft = React.useCallback((ownerId: string, text: string) => {
    if (ownerId !== sessionId || !onDraft) throw new Error(t('找不到所属会话输入框'));
    onDraft(text);
  }, [sessionId, onDraft, t]);
  React.useEffect(() => {
    let live = true, revision = 0;
    const load = async (): Promise<void> => {
      const request = ++revision;
      try {
        const result = await window.api.uiWidgets.list(sessionId);
        if (!live || request !== revision) return;
        const ordered = result.slice().sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
        latest.current ??= ordered.at(-1)?.path.replace(/\\/g, '/') ?? null;
        setWidgets(ordered);
        setError('');
      } catch (cause) { if (live && request === revision) setError(String((cause as Error).message)); }
    };
    const off = window.api.on('uiWidget:updated', event => {
      if (event.path.replace(/\\/g, '/').split('/').slice(-3)[0] === sessionId) {
        latest.current = event.path.replace(/\\/g, '/'); void load();
      }
    });
    const offPresent = window.api.on('uiWidget:present', event => { if (event.sessionId === sessionId) void load(); });
    void load();
    return () => { live = false; off(); offPresent(); };
  }, [sessionId, retry]);
  React.useEffect(() => {
    if (!visible) return;
    const target = latest.current;
    const card = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-ui-path]') ?? []).find(node => node.dataset.uiPath === target);
    if (card) { card.scrollIntoView?.({ block: 'start' }); latest.current = null; }
  }, [widgets, visible]);
  return <div ref={root} className="ui-session-page" aria-label={t('交互 UI')} style={visible ? undefined : { display: 'none' }} aria-hidden={!visible} {...(visible ? {} : { inert: '' })}>
    {error ? <div role="alert">{localizeUiWidgetHostError(error)} <button type="button" className="ui-btn tiny" onClick={() => setRetry(value => value + 1)}>{t('重试')}</button></div> : null}
    {widgets.map(widget => <div key={widget.path} data-ui-path={widget.path.replace(/\\/g, '/')}>
      <UiWidgetCard match={{ path: widget.path, mode: 'inline' }} sessionPage presentationVisible={visible} onSessionDraft={onSessionDraft}/>
    </div>)}
  </div>;
}
