import React from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorTip } from './ErrorTip';

/**
 * 启动链失败页：此时主进程绝大部分 ipcMain.handle 都没注册，
 * 挂主界面只会得到满屏「No handler registered」，不如把真实原因摆出来。
 */
export function BootFailure({ error }: { error: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [logDir, setLogDir] = React.useState('');

  React.useEffect(() => {
    void window.api.app
      .logDir()
      .then(setLogDir)
      .catch(() => setLogDir(''));
  }, []);

  return (
    <div className="boot-failure">
      <div className="boot-failure-card">
        <div className="boot-failure-title">{t('工作台启动失败')}</div>
        <div className="boot-failure-desc">
          {t('后台初始化链中断，界面功能不可用。重启通常可以恢复；若反复失败，请把下面的错误信息连同日志一起反馈。')}
        </div>
        <ErrorTip message={error} />
        {logDir ? <div className="boot-failure-path">{t('日志目录：{{dir}}', { dir: logDir })}</div> : null}
        <div className="boot-failure-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void window.api.app.relaunch()}
          >
            {t('重启应用')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void navigator.clipboard.writeText(error)}
          >
            {t('复制错误信息')}
          </button>
        </div>
      </div>
    </div>
  );
}
