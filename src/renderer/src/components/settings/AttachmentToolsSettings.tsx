import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AttachmentTools } from '../../../../shared/attachmentPolicy';
import { SettingsRows, SettingsSubsection } from './shared';
import { SettingsPathField } from './SettingsPathField';

export function AttachmentToolsSettings({ value = {}, onChange }: {
  value?: AttachmentTools; onChange: (value: AttachmentTools) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <SettingsSubsection item="agent-input-tools" title={t('本机文件转换工具')} desc={t('工作台转换文件时使用；留空从系统 PATH 查找。')}>
    <SettingsRows>
      {([['ffmpegPath', 'FFmpeg 路径', '用于视频抽帧'],
        ['libreOfficePath', 'LibreOffice 路径', '用于 PPT 页面转换']] as const).map(([key, label, tip]) =>
        <SettingsPathField key={key} label={t(label)} tip={t(tip)} path={value[key] || ''}
          placeholder={t('自动查找')} onChange={path => onChange({ ...value, [key]: path })}/>)}
    </SettingsRows>
  </SettingsSubsection>;
}
