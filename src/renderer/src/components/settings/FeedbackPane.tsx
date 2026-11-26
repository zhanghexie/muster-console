import { ErrorTip } from '../ErrorTip';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_FEEDBACK_TARGET } from '../../../../shared/feedback';
import { isWebGateway } from '../../webGatewayEnvironment';
import { FeedbackEntryPoint } from '../FeedbackCenter';
import { SettingsSection } from './shared';

export function FeedbackPane(): React.JSX.Element {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const web = isWebGateway();
  const openProject = async (): Promise<void> => {
    setError('');
    try {
      const result = await window.api.shell.openExternal(`${DEFAULT_FEEDBACK_TARGET.repository}/issues`);
      if (!result.ok) setError(result.error || t('无法打开反馈项目，请检查浏览器设置。'));
    } catch { setError(t('无法打开反馈项目，请检查浏览器设置。')); }
  };
  return <SettingsSection title={t('反馈')} item="feedback" side={!web && <span className="feedback-settings-actions">
    <FeedbackEntryPoint variant="settings"/>
    <button type="button" className="btn tiny" onClick={() => void openProject()}>{t('打开反馈项目')}</button>
  </span>}>
    {web ? <p role="alert">{t('反馈设置只支持本机工作台窗口。')}</p> : <>
      <p className="settings-hint">{t('审核后可在公开的 GitHub 仓库提交反馈。')}</p>
      {error && <ErrorTip message={error} />}
    </>}
  </SettingsSection>;
}
