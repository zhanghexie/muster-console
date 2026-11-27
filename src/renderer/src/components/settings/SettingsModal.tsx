import { showTip } from '../../tips';
import { BrandLoading } from '../BrandLoader';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig, CapabilitiesView } from '../../../../shared/types';
import { THEME_UI_GROUPS } from '../../../../shared/theme';
import { CapabilitiesPane } from './CapabilitiesPane';
import { NotifyPane } from './NotifyPane';
import { RemoteAccessSettings } from './RemoteAccessSettings';
import { ChannelsSettingsPanel } from './ChannelsSettingsPanel';
import { CapabilityManagementPane } from './CapabilityManagementPane';
import { ModelProviderPane } from './ModelProviderPane';
import { ThemePane } from './ThemePane';
import { KeybindingsPane } from './KeybindingsPane';
import { WorkerPane } from './WorkerPane';
import type { WorkerRoutingDraftController } from './WorkerRoutingPane';
import { TextToolsPane } from './TextToolsPane';
import { MemoryPane } from './MemoryPane';
import { AboutPane } from './AboutPane';
import { GeneralPane } from './GeneralPane';
import { LocalStoragePane } from './LocalStoragePane';
import { SettingsContent } from './SettingsContent';
import { SettingsSectionJumpProvider } from './SettingsSectionJump';
import { setLiveThinkingOnly } from '../../thinkingDisplayPreference';
import { setWaitingTipsEnabled } from '../../waitingTips';
import { useKeybindingsOptional, useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { MOTION, usePresence, usePresenceValue, type PresenceStage } from '../motion';
import {
  IconBell,
  IconBolt,
  IconChevronLeft,
  IconInfo,
  IconKeyboard,
  IconLayers,
  IconPalette,
  IconPhone,
  IconPuzzle,
  IconSearch,
  IconSliders,
  IconSparkle,
  IconTerminal,
  IconWrench
} from '../icons';
import {
  SETTINGS_GROUPS,
  SETTINGS_TABS,
  collectSettingsHits,
  normalizeSettingsTab,
  splitHighlight,
  themeGroupsToSettingsItems,
  type SettingsHit,
  type SettingsTabId
} from '../../../../shared/commandPalette';

export type SettingsTab = SettingsTabId;

const TAB_ICONS: Record<SettingsTabId, (p: { size?: number }) => React.JSX.Element> = {
  general: IconSliders,
  appearance: IconPalette,
  agent: IconSparkle,
  worker: IconTerminal,
  capabilities: IconBolt,
  capabilityManagement: IconPuzzle,
  memory: IconLayers,
  textTools: IconWrench,
  notify: IconBell,
  remoteAccess: IconPhone,
  channels: IconPhone,
  keybindings: IconKeyboard,
  localStorage: IconLayers,
  about: IconInfo
};

/**
 * 以下配置键由各自页面即时维护（直接 config.update / 专用 IPC），不随表单草稿回写，
 * 也不参与「未保存」判定。
 */
const INSTANT_KEYS = [
  'shell',
  'claude',
  'cursor',
  'disabledAcpAgents',
  'externalPi',
  'externalHarness',
  'mcp',
  'mcpByWorkspace',
  'modelParameterProfiles',
  'workerRoutingDefault',
  'workerRoutingByWorkspace',
  'workerRoutingWorkspaceRevisions',
  'runtimeOverrides',
  'themeId',
  'themeByWorkspace',
  'workspaceAccentDefault',
  'workspaces',
  'activeWorkspaceId',
  'workspace',
  'keybindings',
  'systemShortcuts',
  'locale',
  'globalPanelGlow',
  'frameEffects',
  'frameBackdrop',
  'frameBackdropByWorkspace',
  'userAvatar'
] as const satisfies readonly (keyof AppConfig)[];
const instantKeys = new Set<string>(INSTANT_KEYS);

/** 表单草稿 vs 基线：逐顶层键比较（排除即时键），返回变化的键数 */
export function countFormChanges(draft: AppConfig, baseline: AppConfig): number {
  const keys = new Set([...Object.keys(draft), ...Object.keys(baseline)]) as Set<keyof AppConfig>;
  let n = 0;
  for (const k of keys) {
    if (instantKeys.has(k)) continue;
    const a = draft[k];
    const b = baseline[k];
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) n++;
  }
  return n;
}

type PromptState = { draft: string; usingDefault: boolean };

const MAX_HITS = 8;

export function SettingsModal({
  onClose,
  initialTab = 'general',
  focusItem,
  stage = 'in',
  presentation = 'modal',
  active = true,
  searchFocusRequest = 0,
  modalShell,
  onReady,
  onDirtyChange,
  setupGuide
}: {
  onClose: () => void;
  setupGuide?: 'model' | 'theme';
  initialTab?: SettingsTab;
  focusItem?: string;
  /** presence 进出场阶段（App 侧 usePresence 驱动；缺省 in 兼容直接挂载） */
  stage?: PresenceStage;
  /** Embedded mode is prepared for the panel host; keep one instance across presentations. */
  presentation?: 'modal' | 'embedded';
  active?: boolean;
  searchFocusRequest?: number;
  /** Explicit trusted app shell for the retained portal; normal direct mounts infer it. */
  modalShell?: HTMLElement | null;
  onReady?: (ready: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const kb = useKeybindingsOptional();
  const rootRef = useRef<HTMLDivElement>(null);
  const savebarRef = useRef<HTMLDivElement>(null);
  const savebarSizeRef = useRef<{ width: number; height: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastSearchFocusRequest = useRef(0);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  /** 最近一次加载 / 保存成功时的配置，未保存判定与「撤销」的基线 */
  const [baseline, setBaseline] = useState<AppConfig | null>(null);
  const [routingDraft, setRoutingDraft] = useState<WorkerRoutingDraftController | null>(null);
  // 外层 xfade/滚动容器常驻；重页面只在首次访问时挂载，之后保留原实例与页内草稿。
  // active 与 visited 同次更新，导航、搜索与外部 deep link 都不会出现空白中间帧。
  const [{ active: tab, visited }, setTabState] = useState(() => {
    const active = normalizeSettingsTab(initialTab);
    return { active, visited: new Set<SettingsTab>([active]) };
  });
  const setTab = useCallback((active: SettingsTab): void => {
    setTabState(previous => previous.active === active ? previous : {
      active,
      visited: previous.visited.has(active) ? previous.visited : new Set(previous.visited).add(active)
    });
  }, []);
  const [saving, setSaving] = useState(false);
  // Each success owns its feedback deadline, including consecutive saves while visible.
  const [savedFlash, setSavedFlash] = useState<symbol | null>(null);
  /** 离开时仍有未保存更改：未保存条切到「离开前确认」态 */
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [capView, setCapView] = useState<CapabilitiesView | null>(null);
  /** 调度提示词正文编辑稿；空配置时展示 defaultBody，保存时再决定是否写回自定义 */
  const [prompt, setPrompt] = useState<PromptState>({ draft: '', usingDefault: true });
  const [promptBase, setPromptBase] = useState<PromptState>({ draft: '', usingDefault: true });
  /** 撤销时递增：重挂表单页，丢弃页内由 cfg 派生的本地草稿 */
  const [formEpoch, setFormEpoch] = useState(0);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(
    focusItem ? { id: focusItem, n: 0 } : null
  );
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  useLayoutEffect(() => { onReady?.(true); return () => onReady?.(false); }, [onReady]);

  // Own the native-material underlay marker for the actual DOM lifetime, including presence exit.
  // A parent open flag would hide the workbench before a lazy settings chunk has committed.
  // Avoid :has(.settings-page): edits inside settings otherwise invalidate the entire workbench.
  useLayoutEffect(() => {
    if (presentation !== 'modal' || !active) return;
    const shell = modalShell ?? rootRef.current?.parentElement;
    if (!shell?.classList.contains('app-shell')) return;
    shell.classList.add('has-settings-page');
    const materialRoot = shell.ownerDocument.documentElement;
    const previousInert = new Map<HTMLElement, string | null>();
    const restoreUnderlay = (): void => {
      for (const [node, value] of previousInert) {
        if (value == null) node.removeAttribute('inert');
        else node.setAttribute('inert', value);
      }
      previousInert.clear();
    };
    const syncUnderlay = (): void => {
      const material = materialRoot.dataset.nativeMaterial;
      if (material !== 'mica' && material !== 'vibrancy') { restoreUnderlay(); return; }
      for (const child of shell.children) {
        if (!(child instanceof HTMLElement) || !child.matches('.chrome-bar, .main-view') || previousInert.has(child)) continue;
        previousInert.set(child, child.getAttribute('inert'));
        child.setAttribute('inert', '');
      }
    };
    // Host confirmation can arrive after settings commits, or fall back to solid.
    // Observe only that root attribute, never mutations inside the retained chat tree.
    const materialObserver = new MutationObserver(syncUnderlay);
    materialObserver.observe(materialRoot, { attributes: true, attributeFilter: ['data-native-material'] });
    syncUnderlay();
    return () => {
      materialObserver.disconnect();
      restoreUnderlay();
      shell.classList.remove('has-settings-page');
    };
  }, [presentation, active, modalShell]);

  /** 初始加载失败信息（F-01）：config.get 拒绝时不再永远停在「加载配置…」 */
  const [loadError, setLoadError] = useState('');
  /** 重试计数：递增即重发 config.get/capabilities.get */
  const [loadEpoch, setLoadEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    void window.api.config.get().then((c) => {
      if (cancelled) return;
      setCfg(c);
      setBaseline(c);
    }).catch((e: unknown) => {
      if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
    });
    void window.api.capabilities.get().then((v) => {
      if (cancelled) return;
      setCapView(v);
      const custom = v.dispatcher.customBody.trim();
      const next = custom
        ? { draft: custom, usingDefault: false }
        : { draft: v.dispatcher.defaultBody, usingDefault: true };
      setPrompt(next);
      setPromptBase(next);
    }).catch(() => undefined);
    // capabilities 失败不卡整页：capView 保持 null，能力页沿用「加载能力信息…」占位。
    return () => {
      cancelled = true;
    };
  }, [loadEpoch]);

  useEffect(() => {
    setTab(normalizeSettingsTab(initialTab));
  }, [initialTab, setTab]);

  useEffect(() => {
    if (focusItem) setFocus((f) => ({ id: focusItem, n: (f?.n ?? 0) + 1 }));
  }, [focusItem]);

  const draftReady = cfg !== null;
  // 等到目标挂载后定位一次，草稿编辑不重启定位标记。
  useEffect(() => {
    if (!focus) return;
    let cancelled = false;
    let timer = 0;
    let highlighted: HTMLElement | undefined;
    const deadline = Date.now() + 3000;
    const tick = (): void => {
      if (cancelled) return;
      const root = rootRef.current;
      const el = root?.querySelector(`[data-settings-item="${CSS.escape(focus.id)}"]`);
      if (el instanceof HTMLElement) {
        const details = el.closest('details');
        if (details) details.open = true;
        if (el instanceof HTMLDetailsElement) el.open = true;
        const heading = el.querySelector(':scope > :is(.s-sec-h, .settings-subgroup-heading)');
        (heading ?? el).scrollIntoView({ block: 'center', behavior: 'instant' });
        if (setupGuide === 'model' && focus.id === 'agent-provider-enabled') {
          el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus({ preventScroll: true });
        }
        highlighted = el;
        el.classList.add('is-settings-flash');
        timer = window.setTimeout(() => {
          if (!cancelled) el.classList.remove('is-settings-flash');
        }, 1600);
        return;
      }
      if (Date.now() < deadline) timer = window.setTimeout(tick, 50);
    };
    timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      highlighted?.classList.remove('is-settings-flash');
    };
  }, [focus, tab, draftReady, setupGuide]);

  const configChangeCount = useMemo(() => {
    if (!cfg || !baseline) return 0;
    const promptChanged =
      prompt.draft !== promptBase.draft || prompt.usingDefault !== promptBase.usingDefault;
    return countFormChanges(cfg, baseline) + (promptChanged ? 1 : 0);
  }, [cfg, baseline, prompt, promptBase]);
  const changeCount = configChangeCount + (routingDraft?.count ?? 0);
  const dirty = changeCount > 0;
  // Publish the committed draft state before paint so an immediately following
  // host command cannot observe the prior clean state.
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [onDirtyChange, dirty]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!cfg) return false;
    // Retain this operation's real action-row geometry after its buttons leave.
    // Layout dimensions avoid the setting sheet's entrance transform/scale.
    const bar = savebarRef.current;
    const width = bar?.offsetWidth ?? 0, height = bar?.offsetHeight ?? 0;
    if (width > 0 && height > 0) {
      savebarSizeRef.current = { width, height };
    }
    try {
      setSaving(true);
      if (configChangeCount) {
        const defaultBody = capView?.dispatcher.defaultBody ?? '';
        const trimmedDraft = prompt.draft.trim();
        const dispatcherAppendPrompt =
          prompt.usingDefault || !trimmedDraft || trimmedDraft === defaultBody.trim()
            ? ''
            : prompt.draft;
        const cfgRest: Partial<AppConfig> = { ...cfg };
        for (const k of INSTANT_KEYS) delete cfgRest[k];
        await window.api.config.update({
          ...cfgRest,
          dispatcherAppendPrompt
        });
        setLiveThinkingOnly(cfg.liveThinkingOnly !== false);
        setWaitingTipsEnabled(cfg.showWaitingTips !== false);
        setBaseline(cfg);
        setPromptBase(prompt);
      }
      if (routingDraft && !await routingDraft.save()) {
        setTab('worker');
        setFocus(f => ({ id: 'worker-routing', n: (f?.n ?? 0) + 1 }));
        return false;
      }
      setSavedFlash(Symbol('saved-feedback'));
      return true;
    } catch (e) {
      showTip(t('保存失败：{{msg}}', { msg: (e as Error).message }), { tone: 'error' });
      return false;
    } finally {
      setSaving(false);
    }
  }, [cfg, capView, prompt, configChangeCount, routingDraft, setTab]);

  const discard = useCallback((): void => {
    if (baseline) setCfg(baseline);
    setPrompt(promptBase);
    setLeaveAsk(false);
    setFormEpoch((n) => n + 1);
  }, [baseline, promptBase]);

  /** 返回工作台：有未保存更改时先问一次；已在问的状态下再按 Esc = 放弃并离开 */
  const requestClose = useCallback((): void => {
    // overlay 栈在捕获阶段先于输入框收到 Esc：搜索框有词时 Esc 只清空搜索
    const search = searchRef.current;
    if (search && document.activeElement === search && search.value) {
      setQuery('');
      return;
    }
    if (dirty && !leaveAsk) {
      setLeaveAsk(true);
      return;
    }
    // The embedded surface can remain mounted after close, so abandoning must
    // reset its draft explicitly instead of relying on an unmount to do it.
    if (dirty) discard();
    onClose();
  }, [dirty, leaveAsk, discard, onClose]);

  // 首次 Esc 确认离开后又产生新编辑（未保存计数变化）：复位确认态，再次 Esc 仍先确认；
  // dirty 归零（保存/撤销）同样落在这里把 leaveAsk 收掉（F-02：确认后累积的编辑不能无提示丢）。
  useEffect(() => {
    setLeaveAsk(false);
  }, [changeCount]);

  useEffect(() => {
    if (!savedFlash) return;
    const id = window.setTimeout(() => {
      // A previous deadline must not revoke a more recent success, even if its
      // callback was already queued before the old effect was cleaned up.
      setSavedFlash(current => current === savedFlash ? null : current);
    }, 1600);
    return () => window.clearTimeout(id);
  }, [savedFlash]);

  // 打开即抢焦点（否则焦点留在终端，打字直接进 xterm）；Esc 走 overlay 栈
  useOverlayDismiss(presentation === 'modal' && active, requestClose);
  useEffect(() => {
    if (presentation === 'modal' && active) rootRef.current?.focus();
  }, [presentation, active]);
  useEffect(() => {
    if (active && searchFocusRequest > 0 && searchFocusRequest !== lastSearchFocusRequest.current) {
      lastSearchFocusRequest.current = searchFocusRequest;
      searchRef.current?.focus();
    }
  }, [presentation, active, searchFocusRequest]);

  // Ctrl+K 聚焦搜索、Ctrl+S 保存（快捷键页录制新组合键时让路）
  const recording = !!kb?.recording;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!active || (presentation === 'embedded' && !rootRef.current?.contains(document.activeElement)) || e.defaultPrevented || recording) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (k === 's') {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, presentation, recording, dirty, saving, save]);

  const themeItems = useMemo(() => themeGroupsToSettingsItems(THEME_UI_GROUPS), []);
  const hits = useMemo<SettingsHit[]>(
    () => (query.trim() ? collectSettingsHits(query, themeItems).slice(0, MAX_HITS) : []),
    [query, themeItems]
  );
  const searchPresence = usePresence(searchOpen && !!query.trim());

  const jumpTo = (hit: SettingsHit): void => {
    setTab(hit.tab);
    setFocus((f) => ({ id: hit.id, n: (f?.n ?? 0) + 1 }));
    setQuery('');
    setSearchOpen(false);
    searchRef.current?.blur();
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setHitIndex((i) => (i + d + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[hitIndex];
      if (hit) jumpTo(hit);
    }
  };

  const set = (patch: Partial<AppConfig>): void => {
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const onPromptChange = (v: string): void => {
    setPrompt({ draft: v, usingDefault: false });
  };

  const onPromptReset = (): void => {
    setPrompt({ draft: capView?.dispatcher.defaultBody ?? '', usingDefault: true });
  };

  const renderPane = (id: SettingsTabId): React.ReactNode => {
    if (!cfg) return null;
    switch (id) {
      case 'general':
        return <GeneralPane key={formEpoch} cfg={cfg} set={set} />;
      case 'appearance':
        return <ThemePane setupGuide={setupGuide === 'theme' && active && stage !== 'out' && tab === 'appearance'} />;
      case 'agent':
        return <ModelProviderPane key={formEpoch} cfg={cfg} set={set} setupGuide={setupGuide === 'model' && active && stage !== 'out' && tab === 'agent'}
          guideFocus={setupGuide === 'model' ? focusItem : undefined}
          active={active && stage !== 'out' && tab === 'agent'} />;
      case 'worker':
        return <WorkerPane key={formEpoch} cfg={cfg} set={set} focusItem={focus?.id} active={active && stage !== 'out' && tab === 'worker'}
          onRoutingDraftChange={setRoutingDraft} onNavigate={next => { setFocus(null); setTab(next); }} />;
      case 'capabilityManagement':
        return <CapabilityManagementPane cfg={cfg} focusItem={focus?.id} active={tab === 'capabilityManagement'} />;
      case 'capabilities':
        return (
          <CapabilitiesPane
            key={formEpoch}
            capView={capView}
            focusItem={focus?.id}
            focusRequest={focus?.n}
            promptDraft={prompt.draft}
            promptUsingDefault={prompt.usingDefault}
            onPromptChange={onPromptChange}
            onPromptReset={onPromptReset}
            rules={cfg.agentRules ?? []}
            onRulesChange={(agentRules) => set({ agentRules })}
          />
        );
      case 'memory':
        return <MemoryPane />;
      case 'textTools':
        return <TextToolsPane key={formEpoch} cfg={cfg} set={set} />;
      case 'notify':
        return <NotifyPane key={formEpoch} cfg={cfg} set={set} />;
      case 'remoteAccess':
        return <RemoteAccessSettings active={active && stage !== 'out' && tab === 'remoteAccess'} onOpenChannels={() => setTab('channels')} />;
      case 'channels':
        return <ChannelsSettingsPanel workspaceId={cfg.activeWorkspaceId} workspaces={cfg.workspaces} active={active && stage !== 'out' && tab === 'channels'} onOpenRemote={() => setTab('remoteAccess')} />;
      case 'keybindings':
        return <KeybindingsPane active={tab === 'keybindings'} />;
      case 'localStorage':
        return <LocalStoragePane />;
      case 'about':
        return <AboutPane />;
    }
  };

  const barPresence = usePresence(dirty || !!savedFlash);
  const notice = usePresenceValue(
    dirty ? {
      text: leaveAsk
        ? t('还有 {{n}} 项更改没保存，离开前要保存吗？', { n: changeCount })
        : t('有 {{n}} 项更改未保存', { n: changeCount }),
      dirty: true
    } : null,
    MOTION.microMs
  );
  const saved = !dirty && !!savedFlash;
  const savedPresence = usePresence(saved, MOTION.microMs);
  const savebarStyle = !dirty && savebarSizeRef.current ? {
    '--savebar-retained-width': `${savebarSizeRef.current.width}px`,
    '--savebar-retained-height': `${savebarSizeRef.current.height}px`
  } as React.CSSProperties : undefined;

  return (
    <div
      className={`settings-page mp-scrim${presentation === 'embedded' ? ' settings-page--embedded' : ''}${!active ? ' settings-page--inactive' : ''}`}
      data-mp-stage={stage}
      role={presentation === 'modal' ? 'dialog' : 'region'}
      aria-modal={presentation === 'modal' ? 'true' : undefined}
      aria-label={t('设置')}
      aria-hidden={!active || undefined}
      ref={rootRef}
      tabIndex={-1}
    >
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={requestClose}>
          <IconChevronLeft size={14} />
          <span>{setupGuide ? t('返回引导') : t('返回工作台')}</span>
          <kbd className="settings-kbd">Esc</kbd>
        </button>

        <div className="settings-search">
          <IconSearch size={13} />
          <input
            ref={searchRef}
            type="search"
            role="combobox"
            aria-label={t('搜索设置')}
            aria-expanded={searchPresence.mounted}
            aria-controls="settings-search-hits"
            aria-activedescendant={hits[hitIndex] ? `settings-hit-${hitIndex}` : undefined}
            placeholder={t('搜索设置')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHitIndex(0);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={onSearchKey}
          />
          {!query ? <kbd className="settings-kbd">Ctrl K</kbd> : null}
          {searchPresence.mounted ? (
            <div
              id="settings-search-hits"
              role="listbox"
              aria-label={t('搜索结果')}
              className="settings-search-hits mp-pop"
              data-mp-stage={searchPresence.stage}
            >
              {hits.length ? (
                hits.map((h, i) => (
                  <div
                    key={`${h.tab}:${h.id}`}
                    id={`settings-hit-${i}`}
                    role="option"
                    aria-selected={i === hitIndex}
                    className={`settings-search-hit${i === hitIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setHitIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      jumpTo(h);
                    }}
                  >
                    <span className="settings-search-hit-t">
                      {splitHighlight(h.title, query).map((p, j) =>
                        p.mark ? <mark key={j}>{p.text}</mark> : <React.Fragment key={j}>{p.text}</React.Fragment>
                      )}
                    </span>
                    <span className="settings-search-hit-d">{h.detail}</span>
                  </div>
                ))
              ) : (
                <div className="settings-search-empty">{t('没有匹配的设置')}</div>
              )}
            </div>
          ) : null}
        </div>

        <nav className="settings-nav-groups" aria-label={t('设置分组')}>
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.id} className="settings-nav-group">
              <div className="settings-nav-group-title">{t(g.label)}</div>
              {SETTINGS_TABS.filter((tb) => tb.group === g.id).map((tb) => {
                const Icon = TAB_ICONS[tb.id];
                return (
                  <button
                    key={tb.id}
                    type="button"
                    className={`settings-nav-item${tab === tb.id ? ' active' : ''}`}
                    aria-current={tab === tb.id ? 'page' : undefined}
                    title={t(tb.desc)}
                    onClick={() => setTab(tb.id)}
                  >
                    <Icon size={14} />
                    <span className="settings-nav-label">{t(tb.label)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <main className="settings-sheet mp-panel" data-mp-stage={stage}>
        {!cfg ? (
          loadError ? (
            <div className="settings-load-error" role="alert">
              <p className="empty-hint">{t('加载配置失败：{{msg}}', { msg: loadError })}</p>
              <button
                type="button"
                className="btn"
                onClick={() => setLoadEpoch((n) => n + 1)}
              >
                {t('重试')}
              </button>
            </div>
          ) : (
            <p className="empty-hint">{t('加载配置…')}</p>
          )
        ) : (
          /* 轻量页壳常驻以保留首访 xfade；内容首次访问才挂载，之后跨页不卸载。
             每页独立滚动，切页保留 DOM、未保存草稿与滚动位置。 */
          <SettingsSectionJumpProvider activeTab={tab}><div className="settings-tabpanes xfade-stack">
            {SETTINGS_TABS.map((tb) => (
              <div
                key={tb.id}
                className={`settings-tabpane xfade${tab === tb.id ? ' is-shown' : ''}`}
                data-settings-item={tb.id}
                aria-hidden={tab === tb.id ? undefined : true}
              >
                <div className="settings-col">
                  <header className="settings-pane-title">
                    <h1>{t(tb.label)}</h1>
                    {'lead' in tb ? <p>{t(tb.lead)}</p> : null}
                  </header>
                  {visited.has(tb.id) ? ['general', 'agent', 'worker', 'capabilityManagement'].includes(tb.id) ? renderPane(tb.id) : <SettingsContent>{renderPane(tb.id)}</SettingsContent> : null}
                </div>
              </div>
            ))}
          </div></SettingsSectionJumpProvider>
        )}

        {barPresence.mounted ? (
          <div
            ref={savebarRef}
            className={`settings-savebar mp-pop mp-pop-up${leaveAsk ? ' is-ask' : ''}${!dirty ? ' is-saved' : ''}`}
            data-mp-stage={barPresence.stage}
            style={savebarStyle}
            role="status"
          >
            <span className="settings-savebar-message-slot">
              {notice.value ? <span className="settings-savebar-notice settings-savebar-copy-layer"
                {...notice.presence.spread} aria-hidden={!dirty ? true : undefined}>
                {notice.value.dirty ? <span className="settings-savebar-dot" aria-hidden="true" /> : null}
                <span className="settings-savebar-msg">{notice.value.text}</span>
              </span> : null}
              {savedPresence.mounted ? <span className="settings-savebar-success settings-savebar-copy-layer"
                {...savedPresence.spread} aria-hidden={!saved ? true : undefined}>
                <span className="settings-savebar-success-spacer" aria-hidden="true" />
                <span className="settings-savebar-msg is-ok">{t('已保存 ✓')}</span>
              </span> : null}
            </span>
            {dirty ? (
              <>
                {leaveAsk ? (
                  <>
                    <button type="button" className="btn ghost" onClick={() => { discard(); onClose(); }}>
                      {t('放弃并离开')}
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={saving}
                      onClick={() => void save().then((ok) => ok && onClose())}
                    >
                      {saving ? <BrandLoading>{t('保存并离开')}</BrandLoading> : t('保存并离开')}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn ghost" onClick={discard}>
                      {t('撤销')}
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={saving}
                      onClick={() => void save()}
                    >
                      {saving ? <BrandLoading>{t('保存')}</BrandLoading> : t('保存')}
                      <kbd className="settings-kbd">Ctrl S</kbd>
                    </button>
                  </>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}
