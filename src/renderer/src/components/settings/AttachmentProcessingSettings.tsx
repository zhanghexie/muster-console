import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ATTACHMENT_PROCESSING_FIELDS, type AttachmentProcessing } from '../../../../shared/attachmentPolicy';
import { SettingsRows, SettingsSubsection, SettingRow } from './shared';

function BudgetInput({ label, value, fallback, min, max, onChange }: {
  label: string; value?: number; fallback: number; min: number; max: number; onChange: (value?: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value ?? fallback));
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) setDraft(String(value ?? fallback));
    emitted.current = value;
  }, [value, fallback]);
  return <input className="s-input is-num" aria-label={label} type="number" min={min} max={max} value={draft}
    onChange={event => {
      const next = event.target.value;
      setDraft(next); emitted.current = next === '' ? undefined : Number(next); onChange(emitted.current);
    }} onBlur={() => { if (draft === '') setDraft(String(value ?? fallback)); }}/>;
}

export function AttachmentProcessingSettings({ value = {}, onChange }: {
  value?: AttachmentProcessing; onChange: (value: AttachmentProcessing) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const fields = (keys: string[]): React.JSX.Element => <SettingsRows>{ATTACHMENT_PROCESSING_FIELDS.filter(([key]) => keys.includes(key)).map(([key, label, fallback, min, max]) =>
      <SettingRow key={key} title={t(label)}>
        <BudgetInput label={t(label)} min={min} max={max} value={value[key]} fallback={fallback}
          onChange={next => onChange({ ...value, [key]: next })}/>
      </SettingRow>)}
    </SettingsRows>;
  return <div className="attachment-input-groups" data-settings-item="agent-input-processing">
    <SettingsSubsection title={t('文件限制')} desc={t('工作台文件处理共用此配置；模型的原生输入能力在各模型中设置。')}>
      {fields(['maxFileMB', 'maxTextChars'])}
    </SettingsSubsection>
    <SettingsSubsection title={t('文档预览')} desc={t('超过自动预览阈值时仅预览一页或 2000 字符，源文件保留。单文件上限仍为硬限制。')}>
      {fields(['autoConvertMB', 'autoPages', 'autoImageMB'])}
    </SettingsSubsection>
    <SettingsSubsection title={t('视频画面')} desc={t('视频抽帧只发送采样画面，不含声音。转换失败会附失败原因并发送源路径；源文件保存在会话目录。')}>
      {fields(['videoFrames', 'videoIntervalSeconds'])}
    </SettingsSubsection>
  </div>;
}
