import { randomUuid } from '../../../../shared/randomUuid';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSystemShortcut, normalizeSystemShortcuts, systemShortcutKeys, type SystemShortcut } from '../../../../shared/systemShortcuts';
import { IconPencil } from '../icons';
import { FieldRow, SettingsSection } from './shared';
import { eventToChord, serializeChord } from '../../../../shared/keybindings';
import { useKeybindingsOptional } from '../../keybindings/KeybindingHost';

export function SystemShortcutsSettings({ active = true, onStartRecording }: { active?: boolean; onStartRecording?: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [items, setItems] = useState<SystemShortcut[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [chord, setChord] = useState('');
  const [recording, setRecording] = useState(false);
  const chordButton = useRef<HTMLButtonElement>(null);
  const setRecordingHost = useKeybindingsOptional()?.setRecording;
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const edit = (item: SystemShortcut, record = false): void => { setEditing(item.id); setName(item.name); setChord(item.chord); if (record) onStartRecording?.(); setRecording(record); };
  useEffect(() => {
    if (!recording || !active) return;
    setRecordingHost?.(true);
    chordButton.current?.focus();
    const finish = (): void => { setRecording(false); chordButton.current?.focus(); };
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { finish(); return; }
      const value = eventToChord(event);
      if (!value) return;
      const serialized = serializeChord(value);
      if (!systemShortcutKeys(serialized)) {
        setError(t('请输入名称和有效组合键，例如 Ctrl+Alt+A、Win+Shift+S、F9 或 PrintScreen'));
        return;
      }
      setChord(serialized); setError(''); finish();
    };
    const cancel = (): void => setRecording(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => { setRecordingHost?.(false); window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', cancel); };
  }, [recording, active, setRecordingHost, t]);
  useEffect(() => { if (!active) setRecording(false); }, [active]);
  useEffect(() => {
    let alive = true;
    void window.api.config.get().then(config => {
      if (alive) { setItems(normalizeSystemShortcuts(config.systemShortcuts)); setLoaded(true); }
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, []);
  const persist = async (next: SystemShortcut[]): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const saved = await window.api.config.update({ systemShortcuts: normalizeSystemShortcuts(next) });
      setItems(normalizeSystemShortcuts(saved.systemShortcuts));
      setName(''); setChord(''); setEditing(null); setRecording(false);
    } catch (e) { setError(String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <SettingsSection title={t('系统快捷操作')} desc={t('在输入框加号菜单中调用截图、录屏等工具。支持 Windows、macOS 和 Linux。')}>
    {items.map(item => <div className="kb-row" key={item.id}>
      <div className="kb-row-main"><span className="kb-row-title">{item.name}</span></div>
      <button type="button" className="kb-chord" disabled={busy} aria-label={t('修改 {{name}} 的快捷键', { name: item.name })}
        onClick={() => edit(item, true)}>{formatSystemShortcut(item.chord, navigator.platform)}</button>
      <button type="button" className="kb-icon-btn" disabled={busy} title={t('编辑 {{name}}', { name: item.name })} aria-label={t('编辑 {{name}}', { name: item.name })}
        onClick={() => edit(item)}><IconPencil size={12} /></button>
      <button type="button" className="kb-icon-btn" disabled={busy} aria-label={t('删除 {{name}}', { name: item.name })}
        onClick={() => void persist(items.filter(row => row.id !== item.id))}>×</button>
    </div>)}
    <form className="system-shortcut-form" onSubmit={e => {
      e.preventDefault();
      if (!name.trim() || !systemShortcutKeys(chord)) { setError(t('请输入名称和有效组合键，例如 Ctrl+Alt+A、Win+Shift+S、F9 或 PrintScreen')); return; }
      const item = { id: editing ?? randomUuid(), name: name.trim(), chord };
      void persist(editing ? items.map(row => row.id === editing ? item : row) : [...items, item]);
    }}>
      <FieldRow label={t('操作名称')}><input className="s-input" aria-label={t('操作名称')} placeholder={t('操作名称，如截图')} maxLength={40} value={name} disabled={!loaded || busy} onChange={e => setName(e.target.value)} /></FieldRow>
      <FieldRow label={t('系统组合键')}><button ref={chordButton} type="button" className={`kb-chord${recording ? ' is-recording' : ''}`} aria-label={t('系统组合键')} aria-pressed={recording} disabled={!loaded || busy} onBlur={() => setRecording(false)}
        title={recording ? t('按下新快捷键，Esc 取消') : t('点击后按下新快捷键')} onClick={() => { onStartRecording?.(); setRecording(value => !value); }}>
        {recording ? t('按下快捷键…') : chord ? formatSystemShortcut(chord, navigator.platform) : t('未绑定')}
      </button></FieldRow>
      <div className="s-sec-actions"><button className="btn tiny" type="submit" disabled={!loaded || busy || (!editing && items.length >= 20)}>{busy ? t('保存中…') : editing ? t('保存修改') : t('添加快捷操作')}</button>
      {editing && <button className="btn tiny" type="button" disabled={busy} onClick={() => { setEditing(null); setName(''); setChord(''); setRecording(false); }}>{t('取消')}</button>}</div>
    </form>
    <p className="hint-muted">{t('点击按键后直接按下组合键，Esc 取消。系统保留的组合键可能被系统接管。请先在目标工具中启用相同的全局快捷键；最多 20 项。')}</p>
    {/mac/i.test(navigator.platform) && <p className="hint-muted">{t('macOS 需允许工作台的辅助功能和自动化权限。')}</p>}
    {/linux/i.test(navigator.platform) && <p className="hint-muted">{t('Linux：X11 需 xdotool；Wayland 需 ydotool 1.x、运行中的 ydotoold 及设备/socket 权限。')}</p>}
    {error && <p role="alert">{error}</p>}
  </SettingsSection>;
}
