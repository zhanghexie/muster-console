import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatImageAttachment } from '../../../shared/types';
import { ImageLightbox } from './ImageLightbox';

/**
 * 输入凹槽内的待发图片条：缩略图可点开 ImageLightbox 放大，× 移除。
 * 抽成叶子是为了让灯箱交互可单测，不必挂整棵 AgentComposer。
 */
export function ComposerImageStrip(props: {
  images: readonly ChatImageAttachment[];
  onRemove: (id: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (props.images.length === 0) return null;

  return (
    <>
      <div className="agent-composer-images">
        {props.images.map((img) => {
          if (!img.mimeType.startsWith('image/')) return (
            <div key={img.id} className="composer-file-attachment" title={img.name}>
              <span>{img.name || t('文件')}</span>
              <small>{img.size == null ? '' : `${Math.ceil(img.size / 1024)} KB`}</small>
              <button type="button" aria-label={`${t('移除附件')} ${img.name || ''}`} onClick={() => props.onRemove(img.id)}>×</button>
            </div>
          );
          const src = img.url || `data:${img.mimeType};base64,${img.data}`;
          return (
            <div key={img.id} className="agent-composer-image-thumb">
              <button
                type="button"
                className="agent-composer-image-open"
                title={img.name ? `${img.name} · ${t('点击查看大图')}` : t('点击查看大图')}
                aria-label={t('点击查看大图')}
                onClick={() => setLightboxSrc(src)}
              >
                <img src={src} alt={img.name || t('图片')} draggable={false} />
              </button>
              <button
                type="button"
                className="agent-composer-image-remove"
                aria-label={t('移除图片')}
                onClick={() => props.onRemove(img.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </>
  );
}
