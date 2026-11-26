import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelParameterState } from '../../../shared/modelParameters';

export type PickerColumnId = 'harness' | 'models' | 'parameters';

export function ModelPickerLayout({ columns, query, searchLabel, onQuery, onConfirm, canConfirm, pendingColumn, selectionKey, narrowSummary, children }: {
  columns: Array<{ id: PickerColumnId; label: string; content: React.ReactNode; selectable: boolean; pending?: boolean }>;
  query: string;
  searchLabel: string;
  onQuery: (query: string) => void;
  onConfirm: () => void;
  canConfirm: boolean;
  pendingColumn?: PickerColumnId;
  selectionKey: string;
  narrowSummary?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const root = React.useRef<HTMLDivElement>(null);
  const search = React.useRef<HTMLInputElement>(null);
  const initialized = React.useRef(false);
  const lastFocused = React.useRef<Partial<Record<PickerColumnId, string>>>({});
  const pendingFocus = React.useRef<PickerColumnId | null>(null);
  const awaitingColumn = React.useRef<{ from: HTMLButtonElement; column: PickerColumnId; key: string; selectFirst: boolean; confirm: boolean } | null>(null);
  const [active, setActive] = React.useState<PickerColumnId>();
  const selectable = columns.filter(column => column.selectable);
  const current = active && columns.some(column => column.id === active) ? active : selectable[0]?.id ?? columns[0]?.id;
  const rows = (id: PickerColumnId): HTMLButtonElement[] => Array.from(root.current?.querySelectorAll<HTMLButtonElement>(
    `[data-picker-column="${id}"] [data-picker-choice]:not(:disabled)`
  ) ?? []);
  const isSelected = (row: HTMLButtonElement): boolean => row.getAttribute('aria-selected') === 'true' || row.getAttribute('aria-checked') === 'true';
  const best = (id: PickerColumnId): HTMLButtonElement | undefined => {
    const choices = rows(id);
    return choices.find(row => row.dataset.pickerChoice === lastFocused.current[id]) ??
      choices.find(isSelected) ?? choices[0];
  };
  const focus = (button?: HTMLButtonElement): void => {
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: 'nearest' });
  };
  const focusColumn = (id: PickerColumnId): void => {
    const row = best(id);
    if (row) focus(row);
    else root.current?.querySelector<HTMLElement>(`[data-picker-column="${id}"]`)?.focus({ preventScroll: true });
  };
  const enter = (id: PickerColumnId): void => {
    if (id === current) focusColumn(id);
    else { pendingFocus.current = id; setActive(id); }
  };
  React.useLayoutEffect(() => {
    const awaited = awaitingColumn.current;
    if (awaited) {
      if (document.activeElement !== awaited.from || (!awaited.selectFirst && awaited.key !== selectionKey)) awaitingColumn.current = null;
      else if (!awaited.selectFirst || isSelected(awaited.from)) {
        awaited.selectFirst = false;
        awaited.key = selectionKey;
        const index = selectable.findIndex(column => column.id === awaited.column);
        const destination = selectable[index + 1];
        if (destination) { awaitingColumn.current = null; enter(destination.id); }
        else if (!pendingColumn || pendingColumn === awaited.column) {
          awaitingColumn.current = null;
          if (awaited.confirm && canConfirm) onConfirm();
        }
      }
    }
    for (const { id } of selectable) {
      const tab = best(id);
      for (const row of rows(id)) row.tabIndex = row === tab ? 0 : -1;
    }
    if (pendingFocus.current && pendingFocus.current === current) {
      focusColumn(pendingFocus.current);
      pendingFocus.current = null;
    } else if (!initialized.current && current && best(current)) {
      initialized.current = true;
      const owningTab = root.current?.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby');
      if (document.activeElement !== search.current && (!owningTab || document.activeElement?.id !== owningTab)) focus(best(current));
    }
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    if (target.closest('input, textarea, [contenteditable=true]')) {
      if (target === search.current && event.key === 'ArrowDown' && selectable[0]) {
        event.preventDefault(); enter(selectable[0].id);
      }
      return;
    }
    if (event.key === '/') {
      awaitingColumn.current = null;
      event.preventDefault(); search.current?.focus(); search.current?.select();
      return;
    }
    if (event.shiftKey) return;
    const row = target.closest<HTMLButtonElement>('button[data-picker-choice]');
    const id = row?.closest<HTMLElement>('[data-picker-column]')?.dataset.pickerColumn as PickerColumnId | undefined;
    if (!row || !id || !['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    awaitingColumn.current = null;
    const index = selectable.findIndex(column => column.id === id);
    if (index < 0) return;
    if (event.key === 'Enter' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (event.key !== 'ArrowLeft' && !isSelected(row)) {
        awaitingColumn.current = { from: row, column: id, key: selectionKey, selectFirst: true, confirm: event.key === 'Enter' && !event.repeat };
        row.click();
        return;
      }
      const destination = selectable[index + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (destination) enter(destination.id);
      else if (event.key !== 'ArrowLeft' && pendingColumn && pendingColumn !== id) {
        awaitingColumn.current = { from: row, column: id, key: selectionKey, selectFirst: false, confirm: event.key === 'Enter' && !event.repeat };
      }
      else if (event.key === 'Enter' && !event.repeat && canConfirm) onConfirm();
      return;
    }
    const choices = rows(id);
    if (!choices.length) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = event.key === 'Home' ? choices[0] : event.key === 'End' ? choices.at(-1)
      : choices[(choices.indexOf(row) + step + choices.length) % choices.length];
    focus(next);
    next?.click();
  };

  return <div className="harness-picker" ref={root} onKeyDown={onKeyDown} onBlur={event => {
    if (event.relatedTarget !== event.target) awaitingColumn.current = null;
  }}>
    <input ref={search} className="model-picker-search" aria-label={searchLabel} placeholder={searchLabel}
      type="search" value={query} onChange={event => onQuery(event.target.value)} />
    {columns.length > 1 ? <nav className="harness-picker-stages" aria-label={searchLabel}>
      {columns.map(column => <button key={column.id} type="button" className="btn tiny" aria-current={column.id === current ? 'step' : undefined} disabled={column.pending}
        onClick={() => enter(column.id)}>{column.label}</button>)}
    </nav> : null}
    {current === 'parameters' && narrowSummary ? <p className="harness-picker-narrow-summary" title={narrowSummary}>{narrowSummary}</p> : null}
    <div className="harness-picker-columns" data-active-column={current} data-columns={columns.map(column => column.id).join(' ')}>
      {columns.map(column => <div key={column.id} className="harness-picker-column" data-picker-column={column.id} tabIndex={-1}
        onFocus={event => {
          const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-picker-choice]');
          if (!row) return;
          lastFocused.current[column.id] = row.dataset.pickerChoice;
          if (current !== column.id) setActive(column.id);
          else for (const other of rows(column.id)) other.tabIndex = other === row ? 0 : -1;
        }}>{column.content}</div>)}
    </div>
    {children}
  </div>;
}

/** Parameter values come from the selected model's descriptor, never a fixed list. */
export function ModelPickerParameterFields({ controls, disabled, pending, onChange }: {
  controls: ModelParameterState[];
  disabled?: boolean;
  pending?: boolean;
  onChange: (id: string, value: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const sources = { session: t('本会话'), model: t('模型默认'), runtime: t('运行时默认'), engine: t('引擎默认') };
  return <div role="group" aria-label={t('模型参数')} aria-busy={pending || undefined}>
    {controls.map(({ descriptor, override, effectiveValue, source }) => {
      const effective = descriptor.options.find(option => option.value === effectiveValue)?.label;
      return <div key={descriptor.id} className="model-picker-parameter-group">
        <div className="model-picker-heading" title={pending ? t('读取中…') : `${sources[source]} · ${t('运行中修改将在下一轮生效')}`}>
          <span>{descriptor.label}{pending ? ` · ${t('读取中…')}` : effective ? ` · ${effective}` : ''}</span>
        </div>
        <div role="radiogroup" aria-label={descriptor.label}>
          {descriptor.supportsDefault ? <button type="button" role="radio" aria-checked={!pending && override === null}
            data-picker-choice={`${descriptor.id}:default`} className="model-picker-option" disabled={disabled || pending}
            onClick={() => onChange(descriptor.id, null)}>{t('跟随默认')}</button> : null}
          {descriptor.options.map(option => <button key={option.value} type="button" role="radio"
            aria-checked={!pending && override === option.value} className="model-picker-option" disabled={disabled || pending}
            data-picker-choice={`${descriptor.id}:value:${option.value}`}
            title={option.label} onClick={() => onChange(descriptor.id, option.value)}>{option.label}</button>)}
        </div>
      </div>;
    })}
  </div>;
}
