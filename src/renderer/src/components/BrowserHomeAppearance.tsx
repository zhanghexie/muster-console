import { ErrorTip } from './ErrorTip';
import { randomUuid } from '../../../shared/randomUuid';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  deleteHomeWallpaper, HOME_APPEARANCE_CHANGED, homeTransparencyFromSlider, homeTransparencyToSlider,
  MAX_HOME_MATERIAL_BLUR, readHomeAppearance, readHomeWallpaper, saveHomeWallpaper,
  validateHomeWallpaper, writeHomeAppearance, type HomeAppearance, type HomeWallpaper
} from '../browserHomeAppearance';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconImage, IconTrash, IconUpload } from './icons';
import { usePresence } from './motion';

export function useHomeAppearance(): { appearance: HomeAppearance; imageUrl: string | null; loadError: string } {
  const { t } = useTranslation();
  const [appearance, setAppearance] = useState(readHomeAppearance);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const update = () => setAppearance(readHomeAppearance());
    window.addEventListener(HOME_APPEARANCE_CHANGED, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(HOME_APPEARANCE_CHANGED, update); window.removeEventListener('storage', update); };
  }, []);
  useEffect(() => {
    let alive = true, url: string | null = null;
    setImageUrl(null); setLoadError('');
    if (appearance.wallpaper === 'custom' && appearance.wallpaperId) {
      void readHomeWallpaper(appearance.wallpaperId).then(file => {
        if (!alive) return;
        url = URL.createObjectURL(file);
        setImageUrl(url);
      }).catch(error => { if (alive) setLoadError(t('读取壁纸失败：{{error}}', { error: String(error) })); });
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [appearance.wallpaper, appearance.wallpaperId, t]);
  return { appearance, imageUrl, loadError };
}

export function BrowserHomeAppearanceDialog({ open, appearance, imageUrl, loadError, onClose, onError }: {
  open: boolean; appearance: HomeAppearance; imageUrl: string | null; loadError: string; onClose: () => void; onError: (message: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open); openRef.current = open;
  useEffect(() => { if (open) setError(''); }, [open]);
  useOverlayDismiss(open && presence.mounted && presence.stage !== 'out', onClose);

  const reportError = (message: string) => { setError(message); if (!openRef.current) onError(message); };

  const removeOld = async (id?: string) => {
    if (!id || readHomeAppearance().wallpaperId === id) return;
    try { await deleteHomeWallpaper(id); }
    catch (cause) { reportError(t('壁纸已更换，但旧图片清理失败：{{error}}', { error: String(cause) })); }
  };
  const selectMode = (wallpaper: Exclude<HomeWallpaper, 'custom'>) => {
    setError('');
    const previous = readHomeAppearance();
    try {
      const next = { ...previous, wallpaper }; delete next.wallpaperId;
      writeHomeAppearance(next);
      void removeOld(previous.wallpaperId);
    } catch (cause) { reportError(t('新标签页外观保存失败：{{error}}', { error: String(cause) })); }
  };
  const pickFile = async (file: File) => {
    setBusy(true); setError('');
    let newId: string | null = null;
    try {
      await validateHomeWallpaper(file);
      newId = randomUuid();
      await saveHomeWallpaper(newId, file);
      const previous = readHomeAppearance();
      try { writeHomeAppearance({ ...previous, wallpaper: 'custom', wallpaperId: newId }); }
      catch (cause) { await deleteHomeWallpaper(newId); throw cause; }
      void removeOld(previous.wallpaperId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      reportError(message === 'size' ? t('图片不能超过 20 MB') : message === 'type' || message === 'decode' ? t('请选择有效的图片文件') : t('壁纸保存失败：{{error}}', { error: message }));
    } finally { setBusy(false); }
  };
  if (!presence.mounted) return null;
  const imageStyle = appearance.wallpaper === 'custom' && imageUrl ? { backgroundImage: `url("${imageUrl}")` } : undefined;
  const transparencyLabel = `${Math.round(appearance.transparency)}%`;
  return createPortal(<div className="modal-mask app-confirm-mask mp-scrim" data-overlay-root {...presence.spread} aria-hidden={!open} {...(open ? {} : { inert: '' })} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal confirm-modal browser-home-dialog browser-home-appearance-dialog mp-panel" {...presence.spread} role="dialog" aria-modal="true" aria-label={t('壁纸与透明度')}>
      <div className="modal-head"><h3>{t('壁纸与透明度')}</h3><button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>×</button></div>
      <div className="browser-home-appearance-content">
        <div className="browser-home-appearance-preview" aria-hidden="true"><div className={`browser-home-wallpaper-image${appearance.wallpaper === 'default' ? ' browser-home-wallpaper-default' : ''}`} style={imageStyle}/><span style={{ background: `color-mix(in srgb, var(--surface-raised) ${100 - appearance.transparency}%, transparent)`, ...(appearance.blur ? { backdropFilter: `blur(${appearance.blur}px)` } : {}) }}/></div>
        <div className="browser-home-wallpaper-actions">
          <button type="button" className={`btn${appearance.wallpaper === 'default' ? ' is-selected' : ''}`} aria-pressed={appearance.wallpaper === 'default'} disabled={busy} onClick={() => selectMode('default')}><IconImage size={15}/>{t('默认壁纸')}</button>
          <button type="button" className={`btn${appearance.wallpaper === 'custom' ? ' is-selected' : ''}`} aria-pressed={appearance.wallpaper === 'custom'} disabled={busy} onClick={() => fileRef.current?.click()}><IconUpload size={15}/>{t('选择图片')}</button>
          <button type="button" className={`btn${appearance.wallpaper === 'none' ? ' is-selected' : ''}`} aria-pressed={appearance.wallpaper === 'none'} disabled={busy} onClick={() => selectMode('none')}><IconTrash size={15}/>{t('无壁纸')}</button>
          <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" aria-label={t('选择壁纸图片')} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void pickFile(file); }}/>
        </div>
        <label className="browser-home-transparency"><span>{t('材质透明度')}</span><input type="range" aria-label={t('材质透明度')} aria-valuetext={transparencyLabel} min={0} max={100} step={1} value={homeTransparencyToSlider(appearance.transparency)} onChange={event => {
          setError('');
          try { writeHomeAppearance({ ...readHomeAppearance(), transparency: homeTransparencyFromSlider(Number(event.target.value)) }); }
          catch (cause) { reportError(t('新标签页外观保存失败：{{error}}', { error: String(cause) })); }
        }}/><span>{transparencyLabel}</span></label>
        <label className="browser-home-transparency"><span>{t('材质模糊')}</span><input type="range" aria-label={t('材质模糊')} min={0} max={MAX_HOME_MATERIAL_BLUR} step={1} value={appearance.blur} onChange={event => {
          setError('');
          try { writeHomeAppearance({ ...readHomeAppearance(), blur: Number(event.target.value) }); }
          catch (cause) { reportError(t('新标签页外观保存失败：{{error}}', { error: String(cause) })); }
        }}/><span>{appearance.blur}px</span></label>
        {error || loadError ? <ErrorTip message={error || loadError} /> : null}
      </div>
    </div>
  </div>, document.body);
}
