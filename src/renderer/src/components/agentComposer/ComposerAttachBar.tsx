import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePresence, usePresenceValue } from '../motion';
import type { MutableRefObject } from 'react';
import type { ChatImageAttachment } from '../../../../shared/types';
import { ComposerImageStrip } from '../ComposerImageStrip';

interface Props {
  allowImages: boolean;
  images: ChatImageAttachment[];
  onRemoveImage: (id: string) => void;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  onPickFiles: (fileList: FileList) => void;
}

/** 输入凹槽上沿区块（纯展示）：待发图片条、隐藏的图片选择 input。 */
export function ComposerAttachBar({
  allowImages,
  images,
  onRemoveImage,
  fileInputRef,
  onPickFiles
}: Props): React.JSX.Element {
  const { presence, value: visibleImages } = usePresenceValue(images.length ? images : null);
  return (
    <>
      {presence.mounted && visibleImages ? (
        <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`}
          aria-hidden={presence.stage === 'out'} {...(presence.stage === 'out' ? { inert: '' } : {})}>
          <div className="acc-body"><ComposerImageStrip images={visibleImages} onRemove={onRemoveImage} /></div>
        </div>
      ) : null}
      {allowImages && (
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          multiple
          onChange={(e) => {
            if (e.target.files) onPickFiles(e.target.files);
            e.target.value = '';
          }}
        />
      )}
    </>
  );
}

/** 命令状态与回复建议、收起队列共用输入区上沿；退出沿用 acc。 */
export function ComposerCommandChip({ cmdMode, onExitCmdMode }: {
  cmdMode: null | 'quickInput';
  onExitCmdMode: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(!!cmdMode);
  if (!presence.mounted) return null;
  return <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`}
    aria-hidden={presence.stage === 'out'} {...(presence.stage === 'out' ? { inert: '' } : {})}>
    <div className="acc-body"><div className="composer-cmd-chip-wrap"><span className="composer-cmd-chip is-quick">
      <span className="composer-cmd-chip-label">/quickInput</span>
      <button type="button" className="composer-cmd-chip-x" title={t('取消命令')}
        aria-label={t('取消命令')} onClick={onExitCmdMode}>×</button>
    </span></div></div>
  </div>;
}
