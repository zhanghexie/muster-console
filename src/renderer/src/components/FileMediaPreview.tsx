import { BrandLoading } from './BrandLoader';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildWorkspaceMediaUrl,
  type MediaKind
} from '../../../shared/mediaKinds';
import { buildExternalFileUrl } from '../../../shared/filePreview';
import { filePreviewUrl } from '../filePreviewUrl';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function FileMediaPreview({
  workspaceId,
  rootId,
  path,
  kind,
  external
}: {
  workspaceId: string;
  rootId?: string;
  path: string;
  kind: MediaKind;
  /** 工作区外绝对路径：src 走 muster-ext:// 只读通道 */
  external?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const src = filePreviewUrl(external ? buildExternalFileUrl(path) : buildWorkspaceMediaUrl(workspaceId, path, rootId));
  const fileName = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizeLabel, setSizeLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSizeLabel(null);
    void (async () => {
      const st = external
        ? await (async () => {
            const r = await window.api.shell.statPaths([path]);
            const s = r[path];
            if (!s?.exists || !s.isFile) return { ok: false as const, error: t('文件不存在') };
            // statPaths 无大小信息：size=null 表示未知，跳过 0 字节检查
            return { ok: true as const, size: null as number | null, isFile: true };
          })()
        : rootId !== undefined ? await window.api.fs.statRef({ workspaceId, rootId, relativePath: path }) : await window.api.fs.stat(workspaceId, path);
      if (cancelled) return;
      if (!st.ok) {
        setError(st.error || t('无法读取文件'));
        return;
      }
      if (!st.isFile) {
        setError(t('不是文件'));
        return;
      }
      setSizeLabel(st.size ? formatBytes(st.size) : null);
      if (st.size === 0) {
        setError(t('文件为空（0 字节），无法播放或预览'));
      }
    })().catch((error) => { if (!cancelled) setError(String(error)); });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, rootId, path, external, t]);

  if (error) {
    return (
      <div className="file-media file-media-error">
        <p className="file-media-error-title">{t('无法预览')}</p>
        <p className="file-media-error-desc">{error}</p>
        {sizeLabel ? <p className="file-media-error-meta">{t('大小：{{size}}', { size: sizeLabel })}</p> : null}
      </div>
    );
  }

  return (
    <div className={`file-media file-media-${kind}`}>
      {loadedSrc !== src ? <BrandLoading>{t('加载中…')}</BrandLoading> : null}
      {kind === 'image' ? (
        <div className="file-media-stage">
          <img
            className="file-media-img"
            key={src}
            src={src}
            onLoad={() => setLoadedSrc(src)}
            alt={fileName}
            onError={() => setError(t('图片加载失败'))}
          />
        </div>
      ) : null}
      {kind === 'audio' ? (
        <div className="file-media-stage file-media-stage-audio">
          <p className="file-media-title">{fileName}</p>
          {sizeLabel ? <p className="file-media-meta">{sizeLabel}</p> : null}
          <audio
            className="file-media-audio"
            key={src}
            src={src}
            controls
            preload="metadata"
            onLoadedMetadata={() => setLoadedSrc(src)}
            onError={() => setError(t('音频加载失败（编码可能不受支持）'))}
          />
        </div>
      ) : null}
      {kind === 'video' ? (
        <div className="file-media-stage">
          <video
            className="file-media-video"
            key={src}
            src={src}
            controls
            preload="metadata"
            onLoadedMetadata={() => setLoadedSrc(src)}
            onError={() => setError(t('视频加载失败（编码可能不受支持，或文件损坏）'))}
          />
        </div>
      ) : null}
      {kind === 'pdf' ? (
        <iframe
          className="file-media-pdf"
          key={src}
          onLoad={() => setLoadedSrc(src)}
          aria-label={fileName}
          src={src}
          onError={() => setError(t('PDF 加载失败'))}
        />
      ) : null}
    </div>
  );
}
