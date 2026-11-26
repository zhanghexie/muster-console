import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { WaitingTip } from '../../../../shared/waitingTips';
import { usePresence } from '../motion';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { SettingsPathField } from './SettingsPathField';

export function WaitingTipsDialog({ open, trigger, tips, loaded, error, path, onClose, onReload }: {
  open: boolean; trigger: HTMLElement | null; tips: WaitingTip[]; loaded: boolean; error: string | null; path: string;
  onClose: () => void; onReload: () => void;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const presence = usePresence(open);
  const ref = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  useOverlayDismiss(open && presence.mounted && presence.stage !== 'out', onClose);
  useEffect(() => {
    if (!open || !presence.mounted) return;
    setQuery('');
    const background = trigger?.closest<HTMLElement>('.settings-content');
    const previousInert = background?.inert ?? false;
    if (background) background.inert = true;
    ref.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    return () => { if (background) background.inert = previousInert; if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [open, presence.mounted, trigger]);
  const rows = tips.map(tip => i18n.resolvedLanguage?.startsWith('en') ? tip.en : tip['zh-CN'])
    .filter(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  if (!presence.mounted) return null;
  return createPortal(<div className="modal-mask general-tips-mask mp-scrim" {...presence.spread} data-overlay-root aria-hidden={!open}
    onMouseDown={event => { if (open && event.target === event.currentTarget) onClose(); }}>
    <div ref={node => { ref.current = node; if (node) node.inert = !open; }} role="dialog" aria-modal="true" aria-label={t('全部功能提示')}
      className="modal general-tips-dialog mp-panel" {...presence.spread} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const fields = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
        const first = fields[0], last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="modal-head"><h3>{t('全部功能提示')}</h3><button className="btn tiny" type="button" onClick={onClose}>{t('关闭')}</button></header>
      <div className="general-tips-body">
        <p>{t('查看或搜索全部提示。显示开关不会影响这里的列表；可在本机 JSON 文件中修改内容。')}</p>
        <div className="s-frow general-tips-search-wrap"><input type="search" className="ui-input s-input general-tips-search" aria-label={t('搜索功能提示')} placeholder={t('搜索功能提示')} value={query} onChange={event => setQuery(event.target.value)}/></div>
        {error ? <ErrorTip message={t('功能提示读取失败：{{error}}', { error })} /> : !loaded ? <p>{t('正在加载功能提示…')}</p>
          : !rows.length ? <p>{t(query ? '没有匹配的功能提示' : '暂无功能提示')}</p>
          : <ul className="general-tips-results">{rows.map((tip, index) => <li key={index}>{tip}</li>)}</ul>}
        {path ? <SettingsPathField label={t('功能提示文件')} path={path}/> : null}
      </div>
      <footer className="general-tips-footer"><button type="button" className="btn tiny" onClick={onReload}>{t('重新读取')}</button></footer>
    </div>
  </div>, document.body);
}
