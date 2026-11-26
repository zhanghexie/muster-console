import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { WORKSPACE_ACCENTS } from '../../../shared/workspaceAccent';
import { FilterCheckbox, FilterColorDot } from '../components/FilterCheckbox';
import { IconFilter, IconPencil, IconPlus, IconTrash } from '../components/icons';
import { MOTION, usePresence } from '../components/motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { overviewStatusName, UNMARKED_STATUS, type SchedulerOverviewStatus, type SchedulerOverviewStatuses } from './schedulerOverviewStatuses';

function useOutsidePress(open: boolean, host: RefObject<HTMLDivElement>, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.isPrimary === false) return;
      if (event.target instanceof Node && !host.current?.contains(event.target)) dismissRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [host, open]);
}

export function SchedulerStatusPicker({ active, status, kinds, onChoose }: {
  active: boolean;
  status: SchedulerOverviewStatus;
  kinds: readonly SchedulerOverviewStatus[];
  onChoose: (id: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [requested, setRequested] = useState(false);
  const choices = kinds.filter(kind => kind.id !== status.id);
  const open = active && requested && choices.length > 0;
  const presence = usePresence(open, MOTION.microMs);
  const interactive = open && presence.stage === 'in';

  function dismiss(restoreFocus: boolean): void {
    if (restoreFocus && hostRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
    setRequested(false);
  }

  useOverlayDismiss(open, () => dismiss(true));
  useOutsidePress(open, hostRef, () => dismiss(false));
  useLayoutEffect(() => {
    if (!active) setRequested(false);
  }, [active]);

  const label = t('更改面板状态（{{name}}）', { name: overviewStatusName(status, t) });
  return (
    <div ref={hostRef} className="scheduler-status-picker"
      onPointerLeave={event => {
        if (event.pointerType !== 'touch' && !event.currentTarget.querySelector(':focus-visible')) dismiss(false);
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) dismiss(false);
      }}>
      <button ref={triggerRef} type="button" className="agent-chat-clear-btn agent-panel-icon-btn"
        disabled={!active || !choices.length} aria-label={label}
        title={overviewStatusName(status, t)} aria-expanded={open} aria-controls={presence.mounted ? id : undefined}
        onPointerEnter={event => { if (event.pointerType !== 'touch') setRequested(true); }}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setRequested(true); }}
        onClick={() => setRequested(true)}>
        <FilterColorDot color={status.color} />
      </button>
      {presence.mounted ? (
        <div id={id} className="scheduler-status-strip filter-popover-surface mp-pop" role="group" aria-label={t('选择面板状态')}
          {...presence.spread} aria-hidden={!interactive || undefined} {...(!interactive ? { inert: '' } : {})}>
          {choices.map(kind => {
            const name = overviewStatusName(kind, t);
            return (
              <button key={kind.id} type="button" className="agent-chat-clear-btn agent-panel-icon-btn"
                aria-label={name} title={name} onClick={() => { dismiss(true); onChoose(kind.id); }}>
                <FilterColorDot color={kind.color} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SchedulerStatusEditor({ status, kinds, onSave, onRemove, onCancel }: {
  status?: SchedulerOverviewStatus;
  kinds: readonly SchedulerOverviewStatus[];
  onSave: (status: SchedulerOverviewStatus) => void;
  onRemove: (id: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const colorNames = [t('蓝色'), t('紫色'), t('粉色'), t('红色'), t('橙色'), t('黄色'), t('绿色'), t('灰色')];
  const radioName = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const colorsInUse = new Set(kinds.filter(kind => kind.id !== status?.id).map(kind => kind.color));
  const [name, setName] = useState(status ? overviewStatusName(status, t) : '');
  const [color, setColor] = useState(() =>
    status?.color ?? WORKSPACE_ACCENTS.find(candidate => !colorsInUse.has(candidate)) ?? '#348e9d'
  );
  const taken = colorsInUse.has(color);
  useLayoutEffect(() => { nameRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <form className="scheduler-status-editor" onSubmit={event => {
      event.preventDefault();
      const label = name.trim();
      if (label && !taken) onSave({ id: status?.id ?? crypto.randomUUID(), color, name: label });
    }}>
      <label className="scheduler-status-field">
        {t('状态名称')}
        <input ref={nameRef} className="scheduler-status-name" value={name} required
          onChange={event => setName(event.target.value)} />
      </label>
      <fieldset className="scheduler-status-colors">
        <legend>{t('状态颜色')}</legend>
        <div className="scheduler-status-swatches">
          {WORKSPACE_ACCENTS.map((choice, index) => (
            <label key={choice} className="scheduler-status-swatch" title={colorNames[index]}>
              <input type="radio" name={radioName} value={choice} aria-label={colorNames[index]}
                disabled={colorsInUse.has(choice)} checked={color === choice} onChange={() => setColor(choice)} />
              <FilterColorDot color={choice} />
            </label>
          ))}
          <input className="scheduler-status-custom-color" type="color" value={color} aria-label={t('自定义颜色')}
            title={t('自定义颜色')} onChange={event => setColor(event.target.value)} />
        </div>
      </fieldset>
      {taken ? <div role="status" className="scheduler-status-color-error">{t('这个颜色已用于其他状态')}</div> : null}
      <div className="scheduler-status-editor-actions">
        {status ? (
          <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn scheduler-status-delete"
            aria-label={t('删除状态')} title={t('删除状态，相关面板将改为未标记')} onClick={() => onRemove(status.id)}>
            <IconTrash size={15} />
          </button>
        ) : null}
        <button type="button" className="btn" onClick={onCancel}>{t('取消')}</button>
        <button type="submit" className="btn primary" disabled={!name.trim() || taken}>{t('保存')}</button>
      </div>
    </form>
  );
}

export function SchedulerOverviewFilter({ open, onOpenChange, triggerRef, statuses }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement>;
  statuses: SchedulerOverviewStatuses;
}): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<SchedulerOverviewStatus | 'new' | null>(null);
  const presence = usePresence(open, MOTION.microMs);
  const interactive = open && presence.stage === 'in';
  const filtered = statuses.hidden.size > 0;
  const label = t('按状态筛选');

  useOverlayDismiss(open, () => {
    if (editor) setEditor(null);
    else {
      onOpenChange(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
  });
  useOutsidePress(open, hostRef, () => onOpenChange(false));
  useLayoutEffect(() => {
    if (interactive && !editor) allRef.current?.focus({ preventScroll: true });
  }, [editor, interactive]);
  useLayoutEffect(() => {
    if (!presence.mounted) setEditor(null);
  }, [presence.mounted]);
  return (
    <div ref={hostRef} className="scheduler-status-filter">
      <button ref={triggerRef} type="button" className="agent-chat-clear-btn agent-panel-icon-btn scheduler-status-filter-trigger"
        aria-label={label} title={label} aria-expanded={open} aria-controls={presence.mounted ? id : undefined}
        data-filtered={filtered || undefined} onClick={() => onOpenChange(!open)}>
        <IconFilter size={16} />
      </button>
      {presence.mounted ? (
        <div id={id} role="group" aria-label={label} className="scheduler-status-menu filter-popover-surface mp-pop" data-overlay-root=""
          {...presence.spread} aria-hidden={!interactive || undefined} {...(!interactive ? { inert: '' } : {})}>
          {editor ? (
            <SchedulerStatusEditor key={editor === 'new' ? editor : editor.id}
              status={editor === 'new' ? undefined : editor} kinds={statuses.kinds}
              onSave={status => { statuses.save(status); setEditor(null); }}
              onRemove={statusId => { statuses.remove(statusId); setEditor(null); }}
              onCancel={() => setEditor(null)} />
          ) : (
            <>
              <FilterCheckbox className="scheduler-status-all" inputRef={allRef} label={t('显示全部状态')}
                checked={!filtered} mixed={filtered && statuses.hidden.size < statuses.kinds.length}
                onChange={statuses.showAll} />
              <div className="scheduler-status-items">
                {statuses.kinds.map(kind => {
                  const name = overviewStatusName(kind, t);
                  const editLabel = t('编辑状态 {{name}}', { name });
                  return (
                    <div className="scheduler-status-item" key={kind.id}>
                      <FilterCheckbox label={name} color={kind.color} checked={!statuses.hidden.has(kind.id)}
                        onChange={checked => statuses.setShown(kind.id, checked)} />
                      {kind.id !== UNMARKED_STATUS.id ? (
                        <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn"
                          aria-label={editLabel} title={editLabel} onClick={() => setEditor(kind)}>
                          <IconPencil size={13} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <button type="button" className="scheduler-status-add agent-chat-clear-btn" onClick={() => setEditor('new')}>
                <IconPlus size={14} />
                {t('新增状态')}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
