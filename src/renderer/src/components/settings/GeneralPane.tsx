import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig } from '../../../../shared/types';
import { getLocaleSetting, type AppLocale } from '../../../../shared/i18n';
import { changeLocale } from '../../i18n';
import {
  setInteractionPreferences,
  useInteractionPreferences,
  type InteractionPreferences,
  type ScrollFeel
} from '../../interactionPreferences';
import { CustomSelect } from '../CustomSelect';
import { DesktopSetupCard } from '../DesktopSetupCard';
import { isWebGateway } from '../../webGatewayEnvironment';
import { FontSettings } from './FontSettings';
import { refreshWaitingTips, useWaitingTips } from '../../waitingTips';
import { SettingsContent } from './SettingsContent';
import { SettingsPathField } from './SettingsPathField';
import { ShellSettings } from './ShellSettings';
import { WaitingTipsDialog } from './WaitingTipsDialog';
import { Segmented, SettingRow, SettingsRows, SettingsSection, Switch } from './shared';

/**
 * 语言、字体、交互偏好即时生效；休眠与自动日志随表单「保存」生效。
 */
export function GeneralPane({
  cfg,
  set
}: {
  cfg: AppConfig;
  set: (patch: Partial<AppConfig>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const waitingTips = useWaitingTips();
  const [tipsOpen, setTipsOpen] = useState(false);
  const [desktopSetupOpen, setDesktopSetupOpen] = useState(false);
  const desktopSetupId = React.useId();
  const tipsTrigger = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const pickerRequest = useRef(0);
  useEffect(() => () => { ++pickerRequest.current; }, []);
  const chooseStorage = async (): Promise<void> => {
    const request = ++pickerRequest.current; setPicking(true); setPickerError('');
    try {
      const result = await window.api.workspaces.pickDir();
      if (request !== pickerRequest.current) return;
      if (result.ok && result.path) set({ worktreeStorageRoot: result.path });
      else if (!result.ok && result.message && result.message !== 'cancelled') setPickerError(result.message);
    } catch (cause) { if (request === pickerRequest.current) setPickerError((cause as Error).message || String(cause)); }
    finally { if (request === pickerRequest.current) setPicking(false); }
  };
  /** 语言设置档位（本地状态驱动下拉显示；changeLocale 内部立即生效并落盘） */
  const [locale, setLocale] = useState<AppLocale>(getLocaleSetting());
  const interaction = useInteractionPreferences();
  const distanceOptions = [...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, interaction.scrollDistance])]
    .sort((a, b) => a - b).map((value) => ({ value: String(value), label: `${value}×` }));

  return (
    <>
    <SettingsContent>
      <SettingsSection title={t('语言与文字')}>
        <SettingsRows>
          <SettingRow item="appearance-language" title={t('界面语言')}>
            <CustomSelect
              className="s-select"
              value={locale}
              ariaLabel={t('界面语言')}
              onChange={(v) => {
                setLocale(v as AppLocale);
                changeLocale(v as AppLocale);
              }}
              options={[
                { value: 'system', label: t('跟随系统') },
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en', label: 'English' }
              ]}
            />
          </SettingRow>
          <FontSettings />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        title={t('滚动与动效')}
        side={
          <button type="button" className="btn tiny" onClick={() => setInteractionPreferences({
            scrollFeel: 'native', scrollDistance: 1, motion: 'system'
          })}>{t('恢复交互默认值')}</button>
        }
      >
        <SettingsRows>
          <SettingRow item="interaction-scroll-feel" title={t('滚动手感')}
            desc={t('原生保留系统滚动；利落与柔和用于鼠标滚轮。')}>
            <Segmented<ScrollFeel> label={t('滚动手感')} value={interaction.scrollFeel}
              onChange={(scrollFeel) => setInteractionPreferences({ scrollFeel })}
              options={[
                { value: 'native', label: t('原生') },
                { value: 'crisp', label: t('利落') },
                { value: 'soft', label: t('柔和') }
              ]} />
          </SettingRow>
          <SettingRow item="interaction-scroll-distance" title={t('每格滚动距离')}
            desc={t('利落与柔和模式下可调整。')}>
            <CustomSelect className="s-select" ariaLabel={t('每格滚动距离')}
              value={String(interaction.scrollDistance)} options={distanceOptions}
              disabled={interaction.scrollFeel === 'native'}
              onChange={(value) => setInteractionPreferences({ scrollDistance: Number(value) })} />
          </SettingRow>
          <SettingRow item="interaction-motion" title={t('界面动效')}
            desc={t('系统减少动态效果的设置始终优先。')}>
            <Segmented<InteractionPreferences['motion']> label={t('界面动效')} value={interaction.motion}
              onChange={(motion) => setInteractionPreferences({ motion })}
              options={[
                { value: 'system', label: t('跟随系统') },
                { value: 'subtle', label: t('轻微') },
                { value: 'reduced', label: t('减少') }
              ]} />
          </SettingRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title={t('会话与记录')}>
        <SettingsRows>
          <SettingRow item="live-thinking-only" title={t('只显示当前思考')}
            desc={t('结束后隐藏思考，不保留展示记录；不影响模型思考。')}>
            <Switch label={t('只显示当前思考')} checked={cfg.liveThinkingOnly !== false}
              onChange={(v) => set({ liveThinkingOnly: v })} />
          </SettingRow>
          <SettingRow item="waiting-tips" title={t('等待时显示功能提示')}
            desc={<>{t('等待回复时轮换显示产品功能提示。')}
              <div className="general-inline-actions"><button type="button" className="btn tiny" ref={tipsTrigger} onClick={() => setTipsOpen(true)}>{t('查看全部提示')}</button></div>
              {waitingTips.error ? <ErrorTip message={t('功能提示读取失败：{{error}}', { error: waitingTips.error })} /> : null}</>}>
            <Switch label={t('等待时显示功能提示')} checked={cfg.showWaitingTips !== false}
              onChange={(v) => set({ showWaitingTips: v })} />
          </SettingRow>
          <SettingRow
            item="worker-journal-exit-summary"
            title={t('会话结束自动写日志')}
            desc={t(
              '关闭聊天会话时，用「文本工具」模型总结日志。至少 4 条消息，会话内容会发送给该模型。'
            )}
          >
            <Switch
              label={t('会话结束自动写日志')}
              checked={cfg.journalExitSummaryEnabled === true}
              onChange={(v) => set({ journalExitSummaryEnabled: v })}
            />
          </SettingRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title={t('任务与工作区')}>
        <SettingsRows>
          <div data-settings-item="worktree-storage">
            <SettingsPathField label={t('worktree 存储目录')} path={cfg.worktreeStorageRoot ?? ''}
              placeholder={t('使用默认目录')}
              tip={t('仅用于新建隔离任务，已有任务不迁移；包含未提交工作，请勿清空。')}
              onChange={value => { setPickerError(''); set({ worktreeStorageRoot: value }); }}
              action={<button type="button" className="btn tiny" disabled={picking} onClick={() => void chooseStorage()}>{t(picking ? '选择中…' : '选择目录…')}</button>}/>
            {pickerError ? <ErrorTip message={pickerError} /> : null}
          </div>

          <SettingRow
            item="worker-keep-awake"
            title={t('任务运行时阻止休眠')}
            desc={t('定时任务执行或即将执行时保持唤醒；关闭后按错过策略处理。')}
          >
            <Switch
              label={t('任务运行时阻止休眠')}
              checked={cfg.tasksKeepAwake !== false}
              onChange={(v) => set({ tasksKeepAwake: v })}
            />
          </SettingRow>

        </SettingsRows>
      </SettingsSection>
      {!isWebGateway() && <SettingsSection title={t('电脑操作')} item="desktop-setup">
        <button
          type="button"
          className="btn"
          aria-expanded={desktopSetupOpen}
          aria-controls={desktopSetupOpen ? desktopSetupId : undefined}
          onClick={() => setDesktopSetupOpen(open => !open)}
        >
          {desktopSetupOpen ? t('收起检查结果') : t('检查电脑操作状态')}
        </button>
        <DesktopSetupCard open={desktopSetupOpen} id={desktopSetupId} />
      </SettingsSection>}
      <ShellSettings />
    </SettingsContent>
    <WaitingTipsDialog open={tipsOpen} trigger={tipsTrigger.current} tips={waitingTips.tips} loaded={waitingTips.loaded} error={waitingTips.error} path={waitingTips.path}
      onClose={() => setTipsOpen(false)} onReload={() => { void refreshWaitingTips(); }}/></>
  );
}
