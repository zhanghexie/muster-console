import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayAttachment } from '../../../shared/attachmentDisplay';
import { buildExternalFileUrl } from '../../../shared/filePreview';
import { buildWorkspaceFileHref } from '../../../shared/linkifyWorkspacePaths';
import { filePreviewUrl } from '../filePreviewUrl';
import { mediaKindForPath } from '../../../shared/mediaKinds';

export function ChatAttachmentCard({ attachment, onFileLink }: {
  attachment: DisplayAttachment; onFileLink?: (href: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [failed, setFailed] = React.useState(false);
  const video = mediaKindForPath(attachment.name) === 'video';
  const src = filePreviewUrl(buildExternalFileUrl(attachment.sourcePath));
  React.useEffect(() => setFailed(false), [src]);
  const label = onFileLink ? <button type="button" className="chat-attachment-open" title={attachment.name} data-chat-link-target={buildWorkspaceFileHref(attachment.sourcePath)}
    onClick={event => { event.stopPropagation(); onFileLink(buildWorkspaceFileHref(attachment.sourcePath)); }}>
    {attachment.name}
  </button> : <span>{attachment.name}</span>;
  return <div className={video ? 'chat-attachment-video' : 'composer-file-attachment'}>
    {video && !failed ? <video key={src} src={src} controls playsInline preload="metadata"
      aria-label={attachment.name} onClick={event => event.stopPropagation()} onError={() => setFailed(true)} /> : null}
    {video && failed ? <span className="settings-hint" role="status">{t('视频无法播放，可点击文件名打开查看')}</span> : null}
    {label}
  </div>;
}
