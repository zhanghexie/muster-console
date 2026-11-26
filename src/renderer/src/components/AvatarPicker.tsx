import { ErrorTip } from './ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BUILTIN_AVATARS, isImageAvatarSrc } from '../../../shared/userAvatar';

export { BUILTIN_AVATARS };

export interface AvatarPickerProps {
  /** 当前头像：emoji 或图片 data/http URL */
  value: string;
  /** 点选预设 / 采用自定义 emoji */
  onChange?: (next: string) => void;
  /** 选中本地图片文件（裁剪/读 data URL 由调用方处理） */
  onUpload: (file: File) => void;
  error?: string;
  /**
   * 外观设置：输入框一有内容就 onChange（选中即保存）。
   * 工作区弹窗保持 blur / Enter /「用 emoji」再采用。
   */
  applyCustomOnChange?: boolean;
  /** 嵌在外观设置等较宽容器里：网格按 32px 格自适应列数 */
  embedded?: boolean;
  ariaLabel?: string;
  /** Local symbol palette. Values remain stable IDs chosen by the caller. */
  imagePresets?: ReadonlyArray<{ id: string; src: string; label: string }>;
  selectedImagePreset?: string;
  onPickImagePreset?: (id: string) => void;
  /** 是否展示旧 emoji 控件；工作区和用户头像均关闭。 */
  allowEmoji?: boolean;
}

function isPreset(value: string): boolean {
  return (BUILTIN_AVATARS as readonly string[]).includes(value);
}

/**
 * 工作区 / 外观设置共用的头像选择器：
 * 预览 + 预设 emoji 网格 + 底栏「自定义 emoji / 用 emoji / 上传图片」。
 */
export function AvatarPicker({
  value,
  onChange,
  onUpload,
  error,
  applyCustomOnChange = false,
  embedded = false,
  ariaLabel,
  imagePresets,
  selectedImagePreset,
  onPickImagePreset,
  allowEmoji = true
}: AvatarPickerProps): React.JSX.Element {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const preset = imagePresets?.find(p => p.id === selectedImagePreset);
  const [customEmoji, setCustomEmoji] = useState(() =>
    allowEmoji && value && !preset && !isImageAvatarSrc(value) && !isPreset(value) ? value : ''
  );

  useEffect(() => {
    if (!allowEmoji || preset || isImageAvatarSrc(value) || isPreset(value)) {
      setCustomEmoji('');
      return;
    }
    if (value) setCustomEmoji(value);
  }, [value, preset, allowEmoji]);

  const applyCustom = (raw = customEmoji): void => {
    if (!allowEmoji) return;
    const e = raw.trim();
    if (!e) return;
    onChange?.(e);
  };

  const img = !!preset || isImageAvatarSrc(value);
  const emojiGrid = (
    <div className="create-ws-avatar-grid" role="listbox" aria-label={ariaLabel ?? t('头像')}>
      {BUILTIN_AVATARS.map(e => (
        <button key={e} type="button" role="option" aria-selected={!img && value === e}
          className={`create-ws-avatar-pick${!img && value === e ? ' is-on' : ''}`}
          onClick={() => onChange?.(e)} title={e}>{e}</button>
      ))}
    </div>
  );

  return (
    <div className={`avatar-picker${embedded ? ' is-embedded' : ''}`} data-avatar-picker="">
      <div className="create-ws-avatar-row">
        <div className={`create-ws-avatar-preview${preset ? ' is-symbol' : ''}`} aria-hidden>
          {img ? <img src={preset?.src ?? value} alt="" /> : <span>{value}</span>}
        </div>
        {imagePresets?.length ? <div className="create-ws-avatar-choices">
          <span className="avatar-picker-label">{t('内置符号')}</span>
          <div className="create-ws-avatar-grid" role="listbox" aria-label={t('内置符号')}>
            {imagePresets.map(p => <button key={p.id} type="button" role="option" aria-label={t(p.label)}
              aria-selected={preset?.id === p.id} title={t(p.label)}
              className={`create-ws-avatar-pick is-symbol${preset?.id === p.id ? ' is-on' : ''}`}
              onClick={() => onPickImagePreset?.(p.id)}><img src={p.src} alt="" draggable={false} /></button>)}
          </div>
          {allowEmoji ? <><span className="avatar-picker-label">Emoji</span>{emojiGrid}</> : null}
        </div> : allowEmoji ? emojiGrid : null}
      </div>
      <div className="create-ws-avatar-custom">
        {allowEmoji ? <><input
          value={customEmoji}
          placeholder={t('自定义 emoji')}
          maxLength={8}
          onChange={(e) => {
            const next = e.target.value;
            setCustomEmoji(next);
            if (applyCustomOnChange) applyCustom(next);
          }}
          onBlur={() => applyCustom()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              applyCustom();
            }
          }}
        />
        <button type="button" className="ui-btn tiny" onClick={() => applyCustom()}>
          {t('用 emoji')}
        </button></> : null}
        <button type="button" className="ui-btn tiny" onClick={() => fileRef.current?.click()}>
          {t('上传图片')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            if (file) onUpload(file);
            e.target.value = '';
          }}
        />
        {error ? <ErrorTip message={error} /> : null}
      </div>
    </div>
  );
}
