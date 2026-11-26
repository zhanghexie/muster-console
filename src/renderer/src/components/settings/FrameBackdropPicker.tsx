import { ErrorTip } from '../ErrorTip';
/**
 * 设置「外观 → 效果 → 窗口背景」：模板缩略图点选 + 纯色浓度 + 壁纸模糊/暗化 + 作用域（全局 / 仅当前工作区）。
 * 缩略图直接复用 FrameBackdrop 本体渲染（与窗口同源，不另画）；「渐变与毛玻璃」关闭时整组禁用。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FRAME_BACKDROPS,
  SOLID_LEVELS,
  WALLPAPER_BLUR_MAX,
  WALLPAPER_DIM_MAX,
  DEFAULT_WALLPAPER_BLUR,
  DEFAULT_WALLPAPER_DIM,
  resolveFrameBackdrop,
  type FrameBackdropChoice,
  type FrameBackdropId,
  type SolidLevel
} from '../../../../shared/frameBackdrop';
import { FrameBackdrop } from '../FrameBackdrop';
import {
  clearWorkspaceFrameBackdrop,
  flushFrameBackdropPersist,
  setFrameBackdrop,
  useFrameBackdropState
} from '../../frameBackdrop';
import { Segmented } from './shared';

type Scope = 'global' | 'workspace';

/** 缩略图壁纸模糊按缩略图/窗口宽度比缩放，观感与大窗口一致 */
const THUMB_SCALE = 0.18;

export function FrameBackdropPicker({ disabled }: { disabled?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const state = useFrameBackdropState();
  const [wsId, setWsId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.api.config
      .get()
      .then((cfg) => {
        if (alive) setWsId(cfg.activeWorkspaceId || null);
      })
      .catch(() => {
        /* 无工作区：只能改全局 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const scope: Scope = wsId && state.byWorkspace[wsId] ? 'workspace' : 'global';
  const current = resolveFrameBackdrop(state.global, state.byWorkspace, wsId);
  const target = scope === 'workspace' ? wsId : null;
  const commit = (choice: FrameBackdropChoice) => setFrameBackdrop(choice, target);

  const onScope = (next: Scope) => {
    if (!wsId || next === scope) return;
    if (next === 'workspace') setFrameBackdrop(current, wsId);
    else clearWorkspaceFrameBackdrop(wsId);
  };

  const pickWallpaper = async () => {
    setError('');
    setPicking(true);
    flushFrameBackdropPersist();
    try {
      const r = await window.api.app.pickWallpaper();
      if (r.ok) {
        commit({
          id: 'custom',
          image: r.path,
          blur: current.id === 'custom' ? current.blur : DEFAULT_WALLPAPER_BLUR,
          dim: current.id === 'custom' ? current.dim : DEFAULT_WALLPAPER_DIM
        });
      } else if (!r.canceled) {
        setError(r.error || t('选择壁纸失败'));
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setPicking(false);
    }
  };

  const onTile = (id: FrameBackdropId) => {
    if (id === 'custom') {
      if (current.id !== 'custom') void pickWallpaper();
      return;
    }
    if (id === current.id) return;
    commit(id === 'solid' ? { id, solidLevel: 'deep' } : { id });
  };

  const previewOf = (id: FrameBackdropId): FrameBackdropChoice => {
    if (id === current.id) {
      return current.id === 'custom' ? { ...current, blur: Math.round((current.blur ?? 0) * THUMB_SCALE) } : current;
    }
    return id === 'solid' ? { id, solidLevel: 'deep' } : { id };
  };

  return (
    <div className={`fb-picker${disabled ? ' is-disabled' : ''}`}>
      {wsId ? (
        <div className="fb-picker-bar">
          <Segmented<Scope>
            label={t('窗口背景作用域')}
            value={scope}
            disabled={disabled}
            onChange={onScope}
            options={[
              { value: 'global', label: t('全局默认') },
              { value: 'workspace', label: t('仅当前工作区') }
            ]}
          />
        </div>
      ) : null}
      <div className="fb-thumbs" role="radiogroup" aria-label={t('窗口背景')}>
        {FRAME_BACKDROPS.map((b) => {
          const on = b.id === current.id;
          const emptyCustom = b.id === 'custom' && current.id !== 'custom';
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`fb-thumb${on ? ' is-selected' : ''}`}
              data-backdrop-tile={b.id}
              disabled={disabled || (b.id === 'custom' && picking)}
              onClick={() => onTile(b.id)}
            >
              <span className="fb-thumb-pv">
                {emptyCustom ? (
                  <span className="fb-thumb-add" aria-hidden="true">
                    +
                  </span>
                ) : (
                  <FrameBackdrop choice={previewOf(b.id)} topInset={7} />
                )}
                <span className="fb-thumb-pane" aria-hidden="true" />
              </span>
              <span className="fb-thumb-name">{t(b.name)}</span>
            </button>
          );
        })}
      </div>

      {current.id === 'solid' ? (
        <div className="fb-picker-opt">
          <span className="fb-picker-label">{t('浓度')}</span>
          <Segmented<SolidLevel>
            label={t('纯色浓度')}
            value={current.solidLevel ?? 'deep'}
            disabled={disabled}
            onChange={(solidLevel) => commit({ id: 'solid', solidLevel })}
            options={[
              { value: 'deep', label: `${t('深')} ${SOLID_LEVELS.deep}%` },
              { value: 'mid', label: `${t('中')} ${SOLID_LEVELS.mid}%` },
              { value: 'full', label: `${t('原色')} ${SOLID_LEVELS.full}%` }
            ]}
          />
        </div>
      ) : null}

      {current.id === 'custom' ? (
        <div className="fb-picker-opt is-wallpaper">
          <label className="fb-slider">
            <span className="fb-picker-label">{t('模糊')}</span>
            <input
              type="range"
              min={0}
              max={WALLPAPER_BLUR_MAX}
              step={1}
              disabled={disabled}
              value={current.blur ?? DEFAULT_WALLPAPER_BLUR}
              aria-label={t('壁纸模糊')}
              onChange={(e) => commit({ ...current, blur: Number(e.target.value) })}
            />
            <span className="fb-slider-v">{current.blur ?? DEFAULT_WALLPAPER_BLUR}px</span>
          </label>
          <label className="fb-slider">
            <span className="fb-picker-label">{t('暗化')}</span>
            <input
              type="range"
              min={0}
              max={WALLPAPER_DIM_MAX}
              step={1}
              disabled={disabled}
              value={current.dim ?? DEFAULT_WALLPAPER_DIM}
              aria-label={t('壁纸暗化')}
              onChange={(e) => commit({ ...current, dim: Number(e.target.value) })}
            />
            <span className="fb-slider-v">{current.dim ?? DEFAULT_WALLPAPER_DIM}%</span>
          </label>
          <button type="button" className="ui-btn" disabled={disabled || picking} onClick={() => void pickWallpaper()}>
            {t('换一张')}
          </button>
        </div>
      ) : null}

      {error ? <ErrorTip message={error} /> : null}
    </div>
  );
}
