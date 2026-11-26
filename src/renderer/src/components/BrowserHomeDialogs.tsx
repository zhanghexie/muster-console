import { ErrorTip } from './ErrorTip';
import { randomUuid } from '../../../shared/randomUuid';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresence, usePresenceValue } from './motion';
import { homeSearchEngineLabel, validSearchTemplate, type HomeSearchPreferences } from '../browserHomePreferences';
import '../styles/browser-home.css';

export interface HomeEditorRequest {
  kind: 'folder' | 'bookmark' | 'rename' | 'description';
  id?: string;
  parentId?: string | null;
  label?: string;
  url?: string;
  description?: string;
}

export function BrowserHomeEditor({ request, onClose, onSave }: {
  request: HomeEditorRequest | null;
  onClose: () => void;
  onSave: (request: HomeEditorRequest, value: { label: string; url: string; description: string }) => string | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { presence, value: current } = usePresenceValue(request);
  const [label, setLabel] = useState(''), [url, setUrl] = useState(''), [description, setDescription] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    if (!request) return;
    setLabel(request.label ?? ''); setUrl(request.url ?? ''); setDescription(request.description ?? ''); setError('');
  }, [request]);
  useOverlayDismiss(!!request && presence.stage !== 'out', onClose);
  if (!presence.mounted || !current) return null;
  const title = current.kind === 'folder' ? t('新建文件夹') : current.kind === 'bookmark' ? t('新建收藏') : current.kind === 'rename' ? t('重命名') : t('编辑描述');
  return createPortal(<div className="modal-mask app-confirm-mask mp-scrim" data-overlay-root {...presence.spread} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal confirm-modal browser-home-dialog mp-panel" {...presence.spread} role="dialog" aria-modal="true" aria-label={title} onSubmit={event => {
      event.preventDefault();
      if (!request) return;
      const problem = onSave(request, { label, url, description });
      if (problem) setError(problem); else onClose();
    }}>
      <div className="modal-head"><h3>{title}</h3><button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>×</button></div>
      <div className="browser-home-dialog-fields">
        {current.kind !== 'description' ? <label>{t('名称')}<input className="ui-input" autoFocus value={label} onChange={event => setLabel(event.target.value)} /></label> : null}
        {current.kind === 'bookmark' ? <label>{t('网址')}<input className="ui-input" value={url} onChange={event => setUrl(event.target.value)} /></label> : null}
        {current.kind === 'description' ? <label>{t('描述')}<textarea className="ui-input" autoFocus value={description} onChange={event => setDescription(event.target.value)} maxLength={10000}/></label> : null}
        {error ? <ErrorTip message={error} /> : null}
      </div>
      <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>{t('取消')}</button><button type="submit" className="btn primary">{t('保存')}</button></div>
    </form>
  </div>, document.body);
}

export function BrowserHomeEngines({ open, value, onClose, onChange }: {
  open: boolean;
  value: HomeSearchPreferences;
  onClose: () => void;
  onChange: (value: HomeSearchPreferences) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open);
  const [editing, setEditing] = useState<string | null>(null), [name, setName] = useState(''), [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => { if (open) { setEditing(null); setName(''); setUrl(''); setError(''); } }, [open]);
  useOverlayDismiss(open && presence.stage !== 'out', onClose);
  if (!presence.mounted) return null;
  const reset = () => { setEditing(null); setName(''); setUrl(''); setError(''); };
  return createPortal(<div className="modal-mask app-confirm-mask mp-scrim" data-overlay-root {...presence.spread} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal confirm-modal browser-home-dialog mp-panel" {...presence.spread} role="dialog" aria-modal="true" aria-label={t('管理搜索引擎')}>
      <div className="modal-head"><h3>{t('管理搜索引擎')}</h3><button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>×</button></div>
      <div className="browser-home-engines">
        {value.engines.map(engine => <div className="browser-home-engine-row" key={engine.id}>
          <label><input type="radio" name="home-default-engine" checked={value.defaultId === engine.id} onChange={() => onChange({ ...value, defaultId: engine.id })}/><span>{homeSearchEngineLabel(engine, t)}</span></label>
          <button type="button" className="btn" onClick={() => { setEditing(engine.id); setName(engine.name); setUrl(engine.url); setError(''); }}>{t('编辑')}</button>
          <button type="button" className="btn" disabled={value.engines.length <= 1} onClick={() => {
            const engines = value.engines.filter(item => item.id !== engine.id);
            onChange({ engines, defaultId: value.defaultId === engine.id ? engines[0].id : value.defaultId });
            if (editing === engine.id) reset();
          }}>{t('删除')}</button>
        </div>)}
      </div>
      <form className="browser-home-dialog-fields" onSubmit={event => {
        event.preventDefault();
        const cleanName = name.trim(), cleanUrl = url.trim();
        if (!cleanName || !validSearchTemplate(cleanUrl)) { setError(t('请输入名称和包含 %s 的 HTTP 或 HTTPS 搜索网址')); return; }
        if (!editing && value.engines.length >= 12) { setError(t('最多可保存 12 个搜索引擎')); return; }
        const next = editing ? value.engines.map(engine => engine.id === editing ? { ...engine, name: cleanName, url: cleanUrl } : engine) : [...value.engines, { id: randomUuid(), name: cleanName, url: cleanUrl }];
        onChange({ ...value, engines: next }); reset();
      }}>
        <label>{t('名称')}<input className="ui-input" value={name} onChange={event => setName(event.target.value)} /></label>
        <label>{t('搜索网址')}<input className="ui-input" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/search?q=%s" /></label>
        {error ? <ErrorTip message={error} /> : null}
        <div className="modal-actions"><button type="button" className="btn" onClick={reset}>{t('清空')}</button><button type="submit" className="btn primary">{editing ? t('保存') : t('添加')}</button></div>
      </form>
    </div>
  </div>, document.body);
}
