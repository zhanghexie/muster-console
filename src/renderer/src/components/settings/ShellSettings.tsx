import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BgShellMode, ShellEnvInfo } from '../../../../shared/types';
import { FieldRow, SettingRow, SettingsRows, SettingsSection } from './shared';
import { CustomSelect } from '../CustomSelect';
import { SettingsPathControl } from './SettingsPathField';

/** 设置 → 通用 → 命令行环境。Windows 提供后台选档及 Git Bash 路径覆盖。 */
export function ShellSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const modeHintId = useId();
  const [info, setInfo] = useState<ShellEnvInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<BgShellMode>('auto');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = (): void => {
    setError('');
    void window.api.shell
      .getInfo()
      .then((v) => {
        setInfo(v);
        setDraft(v.manualGitBashPath);
        setMode(v.bgShellMode ?? 'auto');
      })
      .catch((e) => setError((e as Error).message || t('探测失败')));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 整对象写 shell：patch 会整体替换 shell 字段，必须同时带上路径与档位防互踩 */
  const persist = (manualValue: string, modeValue: BgShellMode): void => {
    const trimmed = manualValue.trim();
    setError('');
    setMsg('');
    const shell: { manualGitBashPath?: string; bgShellMode: BgShellMode } = {
      bgShellMode: modeValue
    };
    if (trimmed) shell.manualGitBashPath = trimmed;
    void window.api.config
      .update({ shell })
      .then(() => {
        setMsg(t('已保存'));
        reload();
      })
      .catch((e) => setError((e as Error).message || t('保存失败')));
  };

  const manual = info?.manualGitBashPath ?? '';
  const dirty = draft.trim() !== manual;
  const manualMissing = !!manual && info?.manualGitBashPathExists === false;
  const isWindows = info?.platform === 'win32';
  const profile = info?.bgShellProfile;
  const usesGitBash = isWindows && profile?.id === 'git-bash' && profile.command === info?.gitBashPath;
  const backgroundShellLabel = t('后台命令 Shell');

  return (
    <SettingsSection title={t('命令行环境')} item="general-shell">
      {info ? (
        <SettingsRows>
          {isWindows ? (
            <SettingRow
              title={t('后台命令 Shell 选择')}
              desc={<span id={modeHintId}>{t('仅用于新建的后台任务。')}</span>}
            >
              <CustomSelect
                testId="bg-shell-mode"
                className="s-select"
                ariaLabel={backgroundShellLabel}
                ariaDescribedBy={modeHintId}
                value={mode}
                onChange={(next) => {
                  setMode(next as BgShellMode);
                  persist(draft, next as BgShellMode);
                }}
                options={[
                  { value: 'auto', label: t('自动（Git Bash 优先）') },
                  { value: 'powershell', label: t('强制 PowerShell') }
                ]}
              />
            </SettingRow>
          ) : null}

          <FieldRow item="bg-shell-mode" label={backgroundShellLabel} tip={profile?.label}>
            {profile ? (
              <SettingsPathControl
                label={usesGitBash ? t('Git Bash（当前生效）') : backgroundShellLabel}
                path={profile.command}
              />
            ) : (
              <ErrorTip message={isWindows
                  ? t('未检测到可用的 Shell。请修复 PowerShell 或安装 Git Bash 后重启 Muster。')
                  : t('未检测到可用的 Shell。请安装 bash 或 zsh 并确保它可执行，然后重启 Muster。')} />
            )}
          </FieldRow>

          {isWindows && !usesGitBash ? (
            <FieldRow label="Git Bash">
              {info.gitBashPath ? (
                <SettingsPathControl label={t('Git Bash（当前生效）')} path={info.gitBashPath} />
              ) : (
                <p className="settings-hint">
                  {t('未检测到 Git Bash。需要 Bash 时可安装 ')}
                  <a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">
                    Git for Windows
                  </a>
                  {t(' 后重启 Muster，或在下方填写已有的 bash.exe 路径。')}
                </p>
              )}
            </FieldRow>
          ) : null}

          {isWindows ? (
            <FieldRow
              label={t('手动指定 Git Bash')}
              tip={t('自动探测找不到 bash.exe 时填写完整路径。留空使用自动探测。')}
            >
              <SettingsPathControl
                label={t('手工指定 Git Bash 路径（留空恢复自动探测）')}
                path={draft}
                onChange={setDraft}
                placeholder="D:\Git\bin\bash.exe"
                action={<>
                  <button type="button" className="btn primary" disabled={!dirty} onClick={() => persist(draft, mode)}>
                    {t('保存 Shell 设置')}
                  </button>
                  {manual ? (
                    <button type="button" className="btn" onClick={() => persist('', mode)}>
                      {t('清除手工路径')}
                    </button>
                  ) : null}
                </>}
              />
              {manualMissing ? (
                <ErrorTip message={t('手工路径不存在（已卸载或改名？）：探测已回落自动结果，请更正或清除。')} />
              ) : null}
            </FieldRow>
          ) : null}
          {msg ? <p className="settings-ok" role="status">{msg}</p> : null}
          {error ? <ErrorTip message={error} /> : null}
        </SettingsRows>
      ) : error ? (
        <SettingRow title={t('探测失败')} desc={<span role="alert">{error}</span>}>
          <button type="button" className="btn tiny" onClick={reload}>{t('重试')}</button>
        </SettingRow>
      ) : (
        <p className="settings-hint">{t('正在探测本机 Shell…')}</p>
      )}
    </SettingsSection>
  );
}
