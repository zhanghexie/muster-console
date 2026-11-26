import {CustomSelect} from '../CustomSelect';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AttachmentPolicy } from '../../../../shared/attachmentPolicy';

export function AttachmentPolicyFields({ value = {}, onChange }: {
  value?: AttachmentPolicy; onChange: (value: AttachmentPolicy) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <fieldset className="attachment-policy-fields">
    <legend>{t('模型原生输入能力')}</legend>
    <p className="settings-hint">{t('仅声明模型接口支持的输入类型；本地转换与预览预算在模型与输入设置中配置。')}</p>
    {([['nativeAudio', '原生音频输入'], ['nativeVideo', '原生视频输入'], ['nativeFiles', '原生文档输入']] as const).map(([key, label]) =>
      <label key={key} className="settings-check"><input type="checkbox" checked={!!value[key]}
        onChange={e => onChange({ ...value, [key]: e.target.checked })} />{t(label)}</label>)}
    <label className="settings-check"><input type="checkbox" checked={value.allowMixedMedia !== false}
      onChange={e => onChange({ ...value, allowMixedMedia: e.target.checked })} />{t('允许混合媒体类型')}</label>
    <label>{t('Completions 视频传输')}<CustomSelect ariaLabel={t('Completions 视频传输')} className="llm-field-input" value={value.videoTransport || 'url-only'}
      onChange={selected => onChange({ ...value, videoTransport: selected as AttachmentPolicy['videoTransport'] })}
      options={[{value:'url-only',label:t('仅公网 URL（本地文件回落抽帧）')},{value:'data-url',label:t('支持内联 Data URL')}]}/></label>
    <label>{t('原生 MIME 类型（逗号分隔，留空按协议默认）')}<input className="llm-field-input" value={value.mimeTypes?.join(', ') || ''}
      placeholder="application/pdf, audio/*, video/mp4" onChange={e => onChange({ ...value, mimeTypes: e.target.value.split(',').map(x => x.trim()) })} /></label>
  </fieldset>;
}
