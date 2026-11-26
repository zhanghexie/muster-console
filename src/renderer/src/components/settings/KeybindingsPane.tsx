import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  eventToChord,
  formatChordSerialized,
  getKeybindingAction,
  matchKeybindingSearch,
  serializeChord
} from '../../../../shared/keybindings';
import { useKeybindings } from '../../keybindings/KeybindingHost';
import { SystemShortcutsSettings } from './SystemShortcutsSettings';
import { SettingsJumpTitle } from './SettingsSectionJump';
/**
 * 设置「快捷键」页：全量目录可改绑；文本搜动作 / 按下反查绑定 双线。
 * 即时落盘，不走设置表单保存。
 */
export function KeybindingsPane({ active = true }: { active?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const { rows, conflicts, setRecording, setOverride, resetOverride } = useKeybindings();
  const [query, setQuery] = useState('');
  const [findChord, setFindChord] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  /** 改绑/解绑/恢复默认 落盘失败的内联提示（keybindings F-03）：host 侧已回滚状态 */
  const [persistError, setPersistError] = useState<string | null>(null);

  const capturing = active && (finding || !!recordingId);
  useEffect(() => {
    if (!active) { setFinding(false); setRecordingId(null); }
  }, [active]);

  /** 统一包三条 persist 路径：失败 → 设置页内联提示（不再 unhandledRejection 零反馈） */
  const runPersist = (op: Promise<void>): void => {
    setPersistError(null);
    void op.catch((e: unknown) => {
      setPersistError(t('保存失败：{{message}}', { message: (e as Error).message || String(e) }));
    });
  };

  useEffect(() => {
    if (!capturing) return;
    setRecording(true);
    return () => setRecording(false);
  }, [capturing, setRecording]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        setFinding(false);
        setRecordingId(null);
        return;
      }
      const chord = eventToChord(ev);
      if (!chord) return;
      ev.preventDefault();
      ev.stopPropagation();
      const serialized = serializeChord(chord);
      if (finding) {
        setFindChord(serialized);
        setFinding(false);
        return;
      }
      if (recordingId) {
        runPersist(setOverride(recordingId, serialized));
        setRecordingId(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, finding, recordingId, setOverride, runPersist]);

  const filtered = useMemo(() => {
    const base = findChord ? rows.filter((r) => r.chord === findChord) : rows;
    return matchKeybindingSearch(query, base);
  }, [rows, query, findChord]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, typeof filtered>();
    for (const row of filtered) {
      if (!map.has(row.group)) {
        order.push(row.group);
        map.set(row.group, []);
      }
      map.get(row.group)!.push(row);
    }
    return order.map((g) => ({ group: g, rows: map.get(g)! }));
  }, [filtered]);

  const startFind = (): void => {
    setRecordingId(null);
    setFinding(true);
  };

  const clearFind = (): void => {
    setFindChord(null);
    setFinding(false);
  };

  return (
    <div className="settings-section kb-pane">
      <SystemShortcutsSettings active={active && !capturing} onStartRecording={() => { setFinding(false); setRecordingId(null); }}/>
      <div className="kb-workbench-section"><h2><SettingsJumpTitle>{t('工作台快捷键')}</SettingsJumpTitle></h2><div className="settings-group-body"><div className="kb-toolbar" data-settings-item="kb-list">
        <input
          className="kb-search"
          type="search"
          placeholder={t('搜索动作、分组或快捷键…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('搜索动作或快捷键')}
        />
        <button
          type="button"
          className={`btn kb-find-btn${finding ? ' is-recording' : ''}`}
          data-settings-item="kb-find"
          onClick={() => (finding ? setFinding(false) : startFind())}
        >
          {finding ? t('按下快捷键…') : t('按下查找')}
        </button>
        {findChord ? (
          <button
            type="button"
            className="btn kb-find-chip"
            title={t('清除按键筛选')}
            onClick={clearFind}
          >
            {formatChordSerialized(findChord, navigator.platform)} ×
          </button>
        ) : null}
      </div>

      {persistError ? (
        <p className="hint-muted kb-persist-error" role="alert">{persistError}</p>
      ) : null}
      {findChord && filtered.length === 0 ? (
        <p className="hint-muted kb-empty">
          {t('没有动作绑定 {{chord}}，点某行右侧按键即可绑上。', {
            chord: formatChordSerialized(findChord, navigator.platform)
          })}
        </p>
      ) : null}
      {!findChord && filtered.length === 0 ? (
        <p className="hint-muted kb-empty">{t('没有匹配的动作')}</p>
      ) : null}

      {groups.map((g) => (
        <div key={g.group} className="kb-group">
          <div className="kb-group-title">{t(g.group)}</div>
          {g.rows.map((row) => {
            const action = getKeybindingAction(row.id);
            const isDefault = action ? row.chord === action.defaultChord : true;
            const conflictIds = row.chord ? conflicts.get(row.chord) : undefined;
            const conflict = (conflictIds?.length ?? 0) > 1;
            const recording = recordingId === row.id;
            return (
              <div key={row.id} className={`kb-row${recording ? ' is-recording' : ''}`}>
                <div className="kb-row-main">
                  <span className="kb-row-title">{t(row.title)}</span>
                  {conflict ? (
                    <span className="kb-conflict" title={t('多个动作共用这一组按键')}>
                      {t('冲突')}
                    </span>
                  ) : null}
                  {!isDefault ? <span className="kb-custom">{t('已改')}</span> : null}
                </div>
                <button
                  type="button"
                  className="kb-chord"
                  title={recording ? t('按下新快捷键，Esc 取消') : t('点击后按下新快捷键')}
                  onClick={() => {
                    setFinding(false);
                    setRecordingId((id) => (id === row.id ? null : row.id));
                  }}
                >
                  {recording ? t('按下快捷键…') : row.chord ? formatChordSerialized(row.chord, navigator.platform) : t('未绑定')}
                </button>
                <button
                  type="button"
                  className="kb-icon-btn"
                  title={t('恢复默认')}
                  disabled={isDefault}
                  onClick={() => runPersist(resetOverride(row.id))}
                >
                  ↺
                </button>
                <button
                  type="button"
                  className="kb-icon-btn"
                  title={t('清除绑定')}
                  disabled={!row.chord}
                  onClick={() => runPersist(setOverride(row.id, null))}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ))}
      </div>
      </div>
    </div>
  );
}
