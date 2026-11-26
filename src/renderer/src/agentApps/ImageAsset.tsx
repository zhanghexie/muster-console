import { ErrorTip } from '../components/ErrorTip';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function ImageAsset({ workspaceId, appId, assetId, thumbnail = false, alt, className }: { workspaceId: string; appId: string; assetId: string; thumbnail?: boolean; alt: string; className?: string }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(''), [error, setError] = useState(false);
  useEffect(() => {
    let active = true, objectUrl = ''; setUrl(''); setError(false);
    void window.api.agentApps.readImage(workspaceId, appId, assetId, thumbnail).then(result => {
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.bytes).buffer], { type: result.mime }));
      setUrl(objectUrl);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [workspaceId, appId, assetId, thumbnail]);
  if (error) return <span className="ap-muted" role="status">{t('图片无法读取')}</span>;
  return url ? <img className={className} src={url} alt={alt}/> : null;
}

export function ImageField({ workspaceId, appId, id, label, value, set, setPending, invalid }: { workspaceId: string; appId: string; id: string; label: string; value: unknown; set: (id: string) => void; setPending: (pending: boolean) => void; invalid?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const importImage = async (file?: File) => {
    if (busy) return;
    setBusy(true); setPending(true); setError('');
    try {
      const picked = file ? { canceled: false as const, asset: await window.api.agentApps.dropImage(workspaceId, appId, file) } : await window.api.agentApps.pickImage(workspaceId, appId);
      if (picked.canceled) return;
      if (!alive.current) { await window.api.agentApps.releaseImage(workspaceId, appId, picked.asset.id); return; }
      if (typeof value === 'string' && value && value !== picked.asset.id) await window.api.agentApps.releaseImage(workspaceId, appId, value);
      set(picked.asset.id);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); else console.error('[agentApps] image cleanup failed', cause); }
    finally { if (alive.current) { setBusy(false); setPending(false); } }
  };
  return <div className="ap-field ap-image-field" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void importImage(file); }}>
    <span>{label}</span>
    {typeof value === 'string' && value && <ImageAsset workspaceId={workspaceId} appId={appId} assetId={value} thumbnail alt={label} className="ap-image-preview"/>}
    <button id={`phone-field-${id}`} type="button" className="ap-image-pick" aria-invalid={invalid || undefined} aria-describedby={invalid ? `phone-field-${id}-error` : undefined} disabled={busy} aria-label={t('选择{{field}}', { field: label })} onClick={() => void importImage()}>{busy ? t('处理中…') : t('选择图片或拖入')}</button>
    {invalid && <span id={`phone-field-${id}-error`} className="sr-only">{t('请选择{{field}}', { field: label })}</span>}
    {error && <ErrorTip message={error} />}
  </div>;
}
