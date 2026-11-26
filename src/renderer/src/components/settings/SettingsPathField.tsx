import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconFolderOpen } from '../icons';
import { FieldRow } from './shared';
import './settings-path-field.css';

export function canRevealSettingsPath(path: string): boolean { return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path); }

type SettingsPathControlProps = { label: string; path: string; onChange?: (path: string) => void;
  action?: React.ReactNode; disabled?: boolean; placeholder?: string; hideReveal?: boolean; required?: boolean; wrap?: boolean };

/** Reuse the same selectable path and open action in lists that already have a visible label. */
export function SettingsPathControl({ label, path, onChange, action, placeholder, required, disabled = false, hideReveal = false, wrap = false }: SettingsPathControlProps): React.JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => { ++generation.current; setBusy(false); setError(''); return () => { ++generation.current; }; }, [path]);
  const reveal = async (): Promise<void> => {
    const request = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await window.api.shell.revealPath(path);
      if (!result?.ok) throw new Error(result?.error || t('无法打开路径，请检查文件或目录是否存在。'));
    } catch (cause) { if (request === generation.current) setError((cause as Error).message || String(cause)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const browsable = canRevealSettingsPath(path);
  return <>
    <div className="s-path-control">
      {wrap && !onChange ? <textarea className="ui-input s-input mono" readOnly rows={1} disabled={disabled} required={required} aria-label={label} title={path} value={path} placeholder={placeholder}/> :
        <input className="ui-input s-input mono" readOnly={!onChange} disabled={disabled} required={required} aria-label={label} title={path} value={path} placeholder={placeholder} onChange={event => onChange?.(event.target.value)}/>}
      {!hideReveal && <button type="button" className="btn tiny" aria-label={t('打开{{label}}的位置', { label })} disabled={disabled || busy || !browsable}
        title={browsable ? path : t('需要完整的文件或目录路径')} onClick={() => void reveal()}>
        <IconFolderOpen size={14}/>{t(busy ? '打开中…' : '打开位置')}
      </button>}
      {action}
    </div>
    {error ? <ErrorTip message={error} /> : null}
  </>;
}

/** A discovered path is selectable, explicitly read-only, and opens through the shared shell adapter. */
export function SettingsPathField({ tip, ...props }: SettingsPathControlProps & { tip?: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  return <FieldRow label={<span className="s-path-label">{props.label}{!props.onChange ? <span className="s-field-readonly">{t('只读')}</span> : null}</span>} tip={tip}>
    <SettingsPathControl {...props}/>
  </FieldRow>;
}
