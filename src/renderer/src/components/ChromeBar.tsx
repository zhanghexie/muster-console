import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../store';
import type { SandboxInfo } from '../../../shared/types';
import { AppConfirmDialog } from './AppConfirmDialog';
import { AppLogo } from './AppLogo';
import { usePresence, MOTION } from './motion';
import { IconBoard, IconChevronLeft, IconPanelToggle, IconSearch, IconSliders, IconLayers } from './icons';
import type { SettingsTab } from './settings/SettingsModal';
import { useChordLabel, useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePanelHistory, useHistoryWsId } from '../panelHistory';
import { ExtensionChromeActions } from './ExtensionChromeActions';
import { FeedbackEntryPoint } from './FeedbackCenter';

type MenuKey = 'sandbox' | null;

interface Props {
  onOpenSettings: (tab?: SettingsTab, focusItem?: string) => void;
  globalBoardOpen: boolean;
  onToggleGlobalBoard: () => void;
  processMonitorOpen?: boolean;
  onToggleProcessMonitor?: () => void;
  /** 窄屏抽屉唤出（按钮仅 html.is-narrow 下显示，见 responsive.css） */
  onToggleLeftDrawer: () => void;
  onToggleRightDrawer: () => void;
  /** 会话栏折叠/展开（左上角 logo 开关）：与专注模式解耦，见 sessions-dock.md */
  sessionsOpen: boolean;
  onToggleSessions: () => void;
  /** 右侧栏（文件/Git/浏览器页）显隐开关（右上角，窗口控制左侧）：开=VS+Git 页驻留 */
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
  /** 面板历史（左栈）：顶栏 ‹ › 按钮（原左栏顶部独立行，2026-10-10 移改顶栏） */
  onBackPanelHistory: () => void;
  onForwardPanelHistory: () => void;
}

function ChromeBarInner({
  onOpenSettings,
  globalBoardOpen,
  onToggleGlobalBoard,
  processMonitorOpen = false,
  onToggleProcessMonitor = () => {},
  onToggleLeftDrawer,
  onToggleRightDrawer,
  sessionsOpen,
  onToggleSessions,
  rightPanelOpen,
  onToggleRightPanel,
  onBackPanelHistory,
  onForwardPanelHistory
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip, openCommandPalette } = useUiStore();
  const [open, setOpen] = useState<MenuKey>(null);
  const [sandboxInfo, setSandboxInfo] = useState<SandboxInfo | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const sandboxRef = useRef<HTMLDivElement>(null);
  const { leftBackDepth, leftForwardDepth } = usePanelHistory();
  const historyWsId = useHistoryWsId();
  const panelBackDepth = leftBackDepth(historyWsId);
  const panelForwardDepth = leftForwardDepth(historyWsId);
  const sandboxMenuPresence = usePresence(open === 'sandbox', MOTION.menuMs);

  useEffect(() => {
    void window.api.sandbox?.getInfo().then((info) => {
      setSandboxInfo(info);
    });
  }, []);

  useEffect(() => {
    if (open !== 'sandbox') return;
    const onDown = (e: PointerEvent): void => {
      if (sandboxRef.current && !sandboxRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useOverlayDismiss(open !== null, () => setOpen(null));

  const settingsChord = useChordLabel('settings.open');
  const panelBackChord = useChordLabel('panel.back');
  const panelForwardChord = useChordLabel('panel.forward');
  const globalBoardChord = useChordLabel('globalBoard.toggle');
  const processMonitorChord = useChordLabel('processMonitor.toggle');
  const searchChord = useChordLabel('palette.goto');

  return (
    <div className="chrome-bar">
      <div className="chrome-menus">
        {/* 左上角品牌 logo 即会话栏开关：静息=品牌图标；悬停=面板+状态箭头
            （展开显 ‹ 折叠、折叠显 › 展开）；点击开合 */}
        <button
          type="button"
          className={`chrome-logo chrome-sessions-toggle${sessionsOpen ? ' is-open' : ''}`}
          aria-pressed={sessionsOpen}
          title={sessionsOpen ? t('折叠会话栏') : t('展开会话栏')}
          onClick={onToggleSessions}
        >
          <span className="chrome-sessions-toggle-rest" aria-hidden>
            <AppLogo size={18} />
          </span>
          <span className="chrome-sessions-toggle-action" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect
                x="1.75"
                y="2.75"
                width="12.5"
                height="10.5"
                rx="2.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <line x1="5.75" y1="3.25" x2="5.75" y2="12.75" stroke="currentColor" strokeWidth="1.2" />
              {sessionsOpen ? (
                <path
                  d="M11.1 6.2 L9.2 8 L11.1 9.8"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M8.9 6.2 L10.8 8 L8.9 9.8"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </span>
        </button>
        {/* 面板历史 ‹ ›：原左栏顶部独立行移改顶栏（2026-10-10），样式对齐右栏 right-icon；
            走左栈（会话/中栏分屏/虚拟屏），与 panel.back/forward 同源 */}
        <div className="chrome-history" role="navigation" aria-label={t('面板历史')}>
          <button
            type="button"
            className="chrome-history-btn"
            title={[
              panelBackDepth > 0
                ? t('返回上一面板（可退 {{n}} 步）', { n: panelBackDepth })
                : t('返回上一面板'), panelBackChord
            ].filter(Boolean).join(' · ')}
            aria-label={t('返回上一面板')}
            disabled={panelBackDepth === 0}
            onClick={onBackPanelHistory}
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            className="chrome-history-btn"
            title={[
              panelForwardDepth > 0
                ? t('前进下一面板（可进 {{n}} 步）', { n: panelForwardDepth })
                : t('前进下一面板'), panelForwardChord
            ].filter(Boolean).join(' · ')}
            aria-label={t('前进下一面板')}
            disabled={panelForwardDepth === 0}
            onClick={onForwardPanelHistory}
          >
            <IconChevronLeft className="chrome-history-forward" />
          </button>
        </div>
        <button
          type="button"
          className="chrome-menu-btn chrome-settings chrome-icon-btn"
          title={settingsChord ? t('设置（{{chord}}）', { chord: settingsChord }) : t('设置')}
          aria-label={t('设置')}
          onClick={() => {
            setOpen(null);
            onOpenSettings();
          }}
        >
          <IconSliders size={15} />
        </button>
        {/* 全局搜索：Ctrl+P 万能搜（全部档）——设置右侧图标钮（2026-10-10） */}
        <FeedbackEntryPoint />
        <button
          type="button"
          className="chrome-menu-btn chrome-icon-btn chrome-search-btn"
          title={searchChord ? t('全局搜索（{{chord}}）', { chord: searchChord }) : t('全局搜索')}
          aria-label={t('全局搜索')}
          onClick={() => {
            setOpen(null);
            openCommandPalette('goto');
          }}
        >
          <IconSearch size={15} />
        </button>
        {/* 全局看板入口：设置旁的图标钮（2026-10-07 报单①a，由工作区胶囊右侧文字钮改来） */}
        <button
          type="button"
          className="chrome-menu-btn chrome-settings chrome-icon-btn chrome-gboard-btn"
          aria-pressed={globalBoardOpen}
          title={
            globalBoardChord
              ? t('全局看板：全部工作区会话一览（{{chord}}，鼠标中键也可开关）', {
                  chord: globalBoardChord
                })
              : t('全局看板：全部工作区会话一览（鼠标中键也可开关）')
          }
          aria-label={t('全局看板')}
          onClick={() => {
            setOpen(null);
            onToggleGlobalBoard();
          }}
        >
          <IconBoard size={15} />
        </button>
        <button
          type="button"
          className={`chrome-menu-btn chrome-settings chrome-icon-btn chrome-process-monitor-btn${processMonitorOpen ? ' is-open' : ''}`}
          aria-pressed={processMonitorOpen}
          title={processMonitorChord ? t('运行监视器（{{chord}}）', { chord: processMonitorChord }) : t('运行监视器')}
          aria-label={t('运行监视器')}
          onClick={() => {
            setOpen(null);
            onToggleProcessMonitor();
          }}
        >
          <IconLayers size={15} />
        </button>
        <button
          type="button"
          className="chrome-menu-btn chrome-drawer-btn"
          title={t('唤出会话栏')}
          onClick={onToggleLeftDrawer}
        >
          {t('会话')}
        </button>
        <button
          type="button"
          className="chrome-menu-btn chrome-drawer-btn"
          title={t('唤出文件与 Git 面板')}
          onClick={onToggleRightDrawer}
        >
          {t('面板')}
        </button>
      </div>

      {/* 沙箱隔离徽章即菜单入口：保存基准 / 重置 / 打开目录（原工作区菜单底部三项，
          2026-10-10 工作区菜单整体撤出顶栏后挪到这里） */}
      {sandboxInfo?.enabled ? (
        <div className="chrome-sandbox" ref={sandboxRef}>
          <button
            type="button"
            className="chrome-sandbox-badge"
            title={`${t('当前处于 Dev 隔离沙箱环境')}\n${t('工作区与配置完全独立于生产环境')}\n${t(
              '沙箱目录: {{rootDir}}',
              { rootDir: sandboxInfo.rootDir ?? '' }
            )}`}
            aria-haspopup="menu"
            aria-expanded={open === 'sandbox'}
            onClick={() => setOpen((v) => (v === 'sandbox' ? null : 'sandbox'))}
          >
            {t('沙箱隔离')}
          </button>
          {sandboxMenuPresence.mounted ? (
            <div
              className="chrome-sandbox-menu ui-menu mp-pop"
              data-mp-stage={sandboxMenuPresence.stage}
              role="menu"
              onKeyDown={(e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const items = Array.from(
                  e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)'
                  )
                );
                if (!items.length) return;
                const idx = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  items[(idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
                next?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="ui-menu-item chrome-sandbox-action"
                onClick={() => {
                  setOpen(null);
                  void window.api.sandbox?.save().then((res) => {
                    if (res?.ok) {
                      flashTip(t('已成功将当前状态保存为沙箱默认基准！'));
                      void window.api.sandbox?.getInfo().then((info) => setSandboxInfo(info));
                    } else {
                      flashTip(res?.message || t('保存快照失败'));
                    }
                  });
                }}
              >
                {t('保存当前状态为默认基准')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="ui-menu-item chrome-sandbox-action"
                onClick={() => {
                  setOpen(null);
                  setShowResetConfirm(true);
                }}
              >
                {t('重置沙箱到基准状态…')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="ui-menu-item chrome-sandbox-action"
                onClick={() => {
                  setOpen(null);
                  void window.api.sandbox?.openDir();
                }}
              >
                {t('打开沙箱目录')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <ExtensionChromeActions />

      <div className="chrome-drag" />

      {/* 右侧栏（文件/Git/浏览器页）开合：窗口控制左侧，分隔线在右的镜像面板图标——
          图标本体与文件/仓库/浏览器列表条开合同源（IconPanelToggle，2026-10-07 报单④） */}
      <button
        type="button"
        className={`chrome-right-toggle${rightPanelOpen ? ' is-open' : ''}`}
        aria-pressed={rightPanelOpen}
        title={rightPanelOpen ? t('折叠右侧栏') : t('展开右侧栏')}
        onClick={onToggleRightPanel}
      >
        <IconPanelToggle size={16} placement="side" open={rightPanelOpen} />
      </button>

      <AppConfirmDialog
        open={showResetConfirm}
        title={t('重置测试仓库')}
        detail={t(
          '将把沙箱中的 3 个测试仓库（demo-playground, demo-frontend, demo-backend）恢复至纯净初始状态。测试过程中的临时改动将被清空。'
        )}
        confirmLabel={t('确认重置')}
        danger
        onConfirm={() => {
          setShowResetConfirm(false);
          void window.api.sandbox?.reset({ cleanWorkspaces: true }).then((res) => {
            if (res.ok) {
              flashTip(t('测试仓库已重置为初始基准状态'));
            } else {
              flashTip(t('重置失败: {{message}}', { message: res.message ?? t('未知错误') }));
            }
          });
        }}
        onCancel={() => setShowResetConfirm(false)}
      />
    </div>
  );
}

export const ChromeBar = React.memo(ChromeBarInner);
