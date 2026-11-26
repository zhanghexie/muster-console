import React, { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { userAvatarDisplaySrc, type UserAvatarConfig } from '../../../../shared/userAvatar';
import { cropScaleAvatarFile, MAX_AVATAR_UPLOAD_BYTES } from '../../cropAvatarImage';
import { getUserAvatar, setUserAvatar, subscribeUserAvatar } from '../../userAvatar';
import { AvatarPicker } from '../AvatarPicker';
import { SUBAGENT_CHARACTERS } from '../../../../shared/subagentCharacters';
import { subagentAvatarUrl } from '../../subagentAvatars';

/**
 * 外观页「头像」：内置符号 + 上传；显示名与图案独立。
 * 选中即保存，不随设置表单草稿回写。
 */
export function UserAvatarSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const symbolPresets = SUBAGENT_CHARACTERS.map(c => ({ id: c.id, src: subagentAvatarUrl(c.id),
    label: t('{{name}}（{{role}}）', { name: t(c.name), role: t(c.role) }) }));
  const avatar = useSyncExternalStore(subscribeUserAvatar, getUserAvatar);
  const [error, setError] = useState('');
  // 显示名草稿：击键只写本地态，失焦才 config.update（主进程同步落盘整份 config，别每击键写盘）
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const display = userAvatarDisplaySrc(avatar, avatar.kind === 'builtin' ? subagentAvatarUrl(avatar.value) : undefined);

  const pick = (next: UserAvatarConfig): void => {
    setError('');
    setUserAvatar(next);
  };

  const onFile = (file: File): void => {
    if (!file.type.startsWith('image/')) {
      setError(t('请选择图片文件'));
      return;
    }
    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      setError(t('图片太大，请选择小于 20MB 的图片'));
      return;
    }
    void cropScaleAvatarFile(file)
      .then((dataUrl) => setUserAvatar({ ...avatar, kind: 'image', value: dataUrl }))
      .then((result) => {
        // 落盘失败（如处理后仍超 256KB）：本地已回滚原头像，明确报错而非静默换默认表情
        if (!result.ok) setError(t('头像保存失败：{{msg}}', { msg: result.msg }));
      })
      .catch(() => {
        setError(t('图片处理失败'));
      });
  };

  return (
    <div className="user-avatar-settings" data-settings-item="appearance-message-avatar">
      <AvatarPicker
        value={display}
        imagePresets={symbolPresets}
        selectedImagePreset={avatar.kind === 'builtin' ? avatar.value : undefined}
        onPickImagePreset={id => {
          if (avatar.kind === 'builtin' && avatar.value === id) return;
          pick({ ...avatar, kind: 'builtin', value: id });
        }}
        allowEmoji={false}
        onUpload={onFile}
        error={error}
        embedded
        ariaLabel={t('用户头像')}
      />
      <label className="user-avatar-name-row">
        <span className="theme-meta-label">{t('显示名')}</span>
        <input
          className="user-avatar-name-input"
          value={nameDraft ?? avatar.displayName ?? ''}
          placeholder={t('悬浮头像时显示，缺省为「我」')}
          maxLength={32}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft === null) return;
            const draft = nameDraft;
            setNameDraft(null);
            if (draft !== (avatar.displayName ?? '')) {
              pick({ ...avatar, displayName: draft });
            }
          }}
        />
      </label>
    </div>
  );
}
