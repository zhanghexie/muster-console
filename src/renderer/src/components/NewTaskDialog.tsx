import { ErrorTip } from './ErrorTip';
import { AgentComposer } from './AgentComposer';
import { isWebGateway } from '../webGatewayEnvironment';
import { randomUuid } from '../../../shared/randomUuid';
import { BrandLoading } from './BrandLoader';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { parseModelKey } from '../modelKey';
import type {
  AgentRuntimeEntry, ChatImageAttachment,
  GuiWorkerMode,
  LlmProviderConfig,
  WorkspaceInfo,
  TaskDelegateResult
} from '../../../shared/types';
import { runtimeSurface } from '../../../shared/types';
import { canvasHandoverTask } from '../../../shared/canvasHandover';
import { getChatCapabilities } from '../../../shared/agentRuntimeCapabilities';
import { HARNESS_CATALOG } from '../../../shared/harnessCatalog';
import { parseExternalPiModelKey } from '../../../shared/externalPiModel';
import { claudeModelReasoningLevels, cliCapabilities, normalizeCliLaunchOptions, supportsAutomaticCliPermissions, type CliLaunchOptions } from '../../../shared/cliLaunchOptions';
import { codexModelReasoningLevels, type CodexModelListItem } from '../../../shared/codexModels';
import { localizeCliLaunchError } from '../../../shared/cliLaunchError';
import { localizeGuiHostError } from '../../../shared/guiHostError';
import { guiPermissionOptions, supportsGuiPermissionMode } from '../../../shared/guiPermissionOptions';
import { NativeConfigLaunchFields } from './NativeSessionConfig';
import type { NativeConfigIntent } from '../../../shared/nativeSessionConfig';
import { useTaskModelParameterState } from './TaskSessionFields';
import { CustomSelect } from './CustomSelect';
import { HarnessModelPicker, type PickerSelection } from './HarnessModelPicker';
import { HarnessIcon } from './HarnessIcon';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresence, MOTION } from './motion';
import { ComposerFlyout } from './agentComposer/ComposerFlyout';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { TaskSourceField, useTaskSource, type TaskSourceTarget } from './TaskSourceField';
import { useWorktreeSelection } from './useWorktreeSelection';
import { NewTaskIsolationPicker } from './NewTaskIsolationPicker';
import { availableRuntimeEntries, runtimeSelectionAvailable, useRuntimeAvailability } from '../hooks/useRuntimeAvailability';
import { notifyComposerError } from './agentComposer/composerNotice';
import { useHarnessModelSelections } from '../hooks/useHarnessModelSelections';
import { harnessModelId, harnessModelSelectionKey, isHarnessModelSelected } from '../../../shared/harnessModelSelection';
import type { BoardTodo, TaskDraftAdvanced } from '../../../shared/boardTodo';

const LAST_RUNTIME_KEY = 'muster:lastTaskRuntime';
const LAST_ACP_AGENT_KEY = 'muster:lastTaskAcpAgent';



/** 会话态字段收集：delegate/create 透传，主进程组装进 inheritMeta */
export type NewTaskAdvanced = TaskDraftAdvanced;
export interface NewTaskIsolation {
  isolate: boolean;
  isolationGroups?: import('../../../shared/types').WorkspaceWorktreeGroupSelection[];
}

export function readLastTaskRuntime(): string | null {
  try {
    return window.localStorage.getItem(LAST_RUNTIME_KEY);
  } catch {
    return null;
  }
}

function readLastAcpAgent(): string | null {
  try { return window.localStorage.getItem(LAST_ACP_AGENT_KEY); } catch { return null; }
}

export function writeLastTaskRuntime(id: string, acpAgent?: string): void {
  try {
    window.localStorage.setItem(LAST_RUNTIME_KEY, id);
    if (id === 'acp' && acpAgent) window.localStorage.setItem(LAST_ACP_AGENT_KEY, acpAgent);
  } catch {
    /* localStorage 不可用时静默 */
  }
}

/**
 * 共用聊天编辑器。对话框持有本次启动的环境、Harness 及创建前才能设置的选项。
 */
export function NewTaskDialog({
  open,
  runtimes,
  onClose,
  onDelegate,
  onBlankSession,
  onOpenWorkerSettings,
  onSessionCreated,
  initialTask,
  extensionSkillNames,
  initialName,
  extensionSource: initialExtensionSource,
  initialSource,
  lockedTask,
  workspace,
  todo,
  onTodoSaved,
  scheduledEdit
}: {
  open: boolean;
  runtimes: AgentRuntimeEntry[];
  workspace?: WorkspaceInfo;
  todo?: BoardTodo;
  onTodoSaved?: (todo: BoardTodo) => void;
  onClose: () => void;
  /** Optional navigation is supplied by the owning surface. */
  onOpenWorkerSettings?: () => void;
  /** A session is ready to show. Queued tasks and failed launches stay in the form. */
  onSessionCreated?: () => void;
  /** 打开时预填任务框（便签「发起任务」）；缺省空 */
  initialTask?: string;
  extensionSkillNames?: readonly string[];
  /** 交接任务：背景不在界面显示，提交时由宿主保管并自动补充。 */
  initialName?: string;
  extensionSource?: import('../../../shared/boardTodo').ExtensionTaskSource;
  initialSource?: { rootId: string; path: string };
  lockedTask?: string;
  /** Edit a scheduled task without creating a session. */
  scheduledEdit?: {
    runtime: string;
    advanced: NewTaskAdvanced;
    onSave: (input: { task: string; name: string; runtime: string; advanced: NewTaskAdvanced; source: TaskSourceTarget }) => void;
  };
  /** 提交任务：主进程 delegateTask 统一管线 */
  onDelegate: (input: {
    task: string;
    attachments?: ChatImageAttachment[];
    submissionId: string;
    supplement?: string;
    runtime: string;
    isolate: boolean;
    name: string;
    advanced: NewTaskAdvanced;
    source: TaskSourceTarget;
    isolationGroups?: NewTaskIsolation['isolationGroups'];
  }) => Promise<TaskDelegateResult>;
  /** 「先开空会话（稍后派活）」 */
  onBlankSession: (runtime: string, name: string, advanced: NewTaskAdvanced, source: TaskSourceTarget, isolation?: NewTaskIsolation) => Promise<void>;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const extensionSource = initialExtensionSource ?? todo?.advanced.extensionSource;
  const [task, setTask] = useState('');
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [readingAttachments, setReadingAttachments] = useState(false);
  const attachmentsChanged = useCallback((items: ChatImageAttachment[], loading: boolean) => {
    setAttachments(items); setReadingAttachments(loading);
  }, []);
  const openingId = useRef('');
  const lastSubmission = useRef<{ fingerprint: string; id: string }>();
  const [savedFiles, setSavedFiles] = useState<{ key: string; items: ChatImageAttachment[] }>();
  const [fileRetry, setFileRetry] = useState(0);
  const waitingForFiles = !!todo?.attachmentKey && savedFiles?.key !== todo.attachmentKey;
  useEffect(() => {
    if (!open || !todo?.attachmentKey) return;
    let active = true;
    const key = todo.attachmentKey;
    void window.api.boardTodos.loadAttachments(todo.id, key).then(items => {
      if (active) setSavedFiles({ key, items });
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [open, todo?.id, todo?.attachmentKey, fileRetry]);
  const [name, setName] = useState('');
  const [isolate, setIsolate] = useState(false);
  /** 用户手动改过隔离时，异步推荐不再覆盖。 */
  /** 主仓 dirty（预检；null=git 不可用未知）——会话起点快照提示 */
  const [repoDirty, setRepoDirty] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<TaskDelegateResult | null>(null);
  const [precheck, setPrecheck] = useState<{ key: string; error?: string; }>();
  const [retry, setRetry] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const pickerPresence = usePresence(open && showPicker, MOTION.menuMs);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const pickerPopup = useRef<HTMLDivElement>(null);
  const pickerId = React.useId();
  const pickerAnchor = '--task-harness-' + pickerId.replace(/[^a-zA-Z0-9_-]/g, '');
  const closePicker = (): void => {
    setShowPicker(false);
    pickerTrigger.current?.focus({ preventScroll: true });
  };
  useDismissOnOutsideClick(open && showPicker, [pickerTrigger, pickerPopup], () => setShowPicker(false));
  React.useLayoutEffect(() => {
    const panel = pickerPopup.current;
    if (open && showPicker && panel && !panel.contains(document.activeElement)) {
      panel.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    }
  }, [open, showPicker, pickerPresence.mounted]);
  const source = useTaskSource(open, workspace, todo?.source ?? initialSource);
  const repositories = useWorktreeSelection(open, isolate && !!source.target, workspace, source.target?.rootId, false, true, todo?.isolationGroups);
  const disabled = busy || !!queued;
  const operation = useRef(0);
  const mounted = useRef(true);
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; }; }, []);
  useEffect(() => {
    if ((error || source.error || precheck?.error || repositories.error) && feedbackRef.current) feedbackRef.current.scrollTop = 0;
  }, [error, source.error, precheck?.error, repositories.error]);
  const taskRef = useRef<HTMLDivElement | null>(null);

  // ── 会话态字段（GUI chat runtime）──
  const [guiMode, setGuiMode] = useState('');
  const [configurePermissions, setConfigurePermissions] = useState(false);
  const [nativeConfig, setNativeConfig] = useState<NativeConfigIntent>();
  const [piMode, setPiMode] = useState('');
  /** `${providerId}|${modelId}`；空串=跟随默认 */
  const [modelKey, setModelKey] = useState('');
  const [cliOptions, setCliOptions] = useState<CliLaunchOptions>({});
  const [modelParameters, setModelParameters] = useState<import('../../../shared/modelParameters').ModelParameterValues | undefined>();
  const [piModes, setPiModes] = useState<Array<{ id: string; name: string; }> | null>(null);
  const [providers, setProviders] = useState<LlmProviderConfig[]>([]);
  const [codexModels, setCodexModels] = useState<CodexModelListItem[]>([]);
  const [codexCatalogKey, setCodexCatalogKey] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogUpdateRevision, setCatalogUpdateRevision] = useState(0);
  const modelCatalogRequest = useRef(0);
  const manualCatalogRequests = useRef(new Set<string>());
  const [acpModels, setAcpModels] = useState<Array<{ id: string; name: string; resolvedModel?: string; effortLevels?: string[] }>>([]);
  const [acpCatalogKey, setAcpCatalogKey] = useState('');
  const [acpModelsLoading, setAcpModelsLoading] = useState(false);
  const [acpCatalogNotice, setAcpCatalogNotice] = useState('');
  const acpRequest = useRef<string | null>(null);
  const acpRequestSeq = useRef(0);
  const [catalogNotice, setCatalogNotice] = useState('');
  const [configuredDefault, setConfiguredDefault] = useState('');
  const [runtimeConfigNotice, setRuntimeConfigNotice] = useState('');
  const [surface, setSurface] = useState<'chat' | 'pty'>('chat');
  const modelSelections = useHarnessModelSelections(open);
  const allowModel = useCallback((harness: string, value: string): boolean => {
    if (!value) return true;
    if (!modelSelections.ready) return false;
    const runtimeId = harness.startsWith('acp:') ? 'acp' : harness;
    const agentId = harness.startsWith('acp:') ? harness.slice(4) : undefined;
    const model = parseModelKey(value);
    if (!model || !model.modelId || (runtimeId !== 'pi' && model.providerId !== runtimeId)) return false;
    return isHarnessModelSelected(modelSelections.selections, harnessModelSelectionKey(runtimeId, agentId), harnessModelId(runtimeId, model.providerId, model.modelId));
  }, [modelSelections.ready, modelSelections.selections]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRuntimeConfigNotice('');
    void window.api.config.get().then(config => { if (!cancelled) setConfiguredDefault(config.defaultRuntime); })
      .catch(error => { if (!cancelled) setRuntimeConfigNotice((error as Error).message || String(error)); });
    return () => { cancelled = true; };
  }, [open]);

  const availability = useRuntimeAvailability(open);
  useEffect(() => {
    if (availability.error && feedbackRef.current) feedbackRef.current.scrollTop = 0;
  }, [availability.error]);
  const registeredRef = useRef(runtimes);
  registeredRef.current = runtimes;
  const enabled = useMemo(() => availableRuntimeEntries(availability.snapshot, runtimes), [availability.snapshot, runtimes]);
  const enabledForSurface = useMemo(() => enabled.filter(entry => runtimeSurface(entry) === surface), [enabled, surface]);
  const [runtime, setRuntime] = useState('');
  const rememberedRuntime = readLastTaskRuntime();
  const effectiveRuntime = runtime
    ? runtime
    : enabledForSurface.some((r) => r.id === rememberedRuntime)
      ? (rememberedRuntime as string)
      : (enabledForSurface.find((r) => r.id === configuredDefault)?.id ?? enabledForSurface.find((r) => r.id === 'pi')?.id ?? enabledForSurface[0]?.id ?? '');
  const effEntry = enabled.find((r) => r.id === effectiveRuntime) ?? runtimes.find((r) => r.id === effectiveRuntime);
  const isChat = surface === 'chat';
  const acpAgents = availability.snapshot?.acpAgents ?? [];
  const rememberedAcpAgent = rememberedRuntime === 'acp' ? readLastAcpAgent() : null;
  const effectivePiMode = effectiveRuntime === 'acp'
    ? (runtime === 'acp' && piMode ? piMode : acpAgents.find(agent => agent.id === piMode)?.id
      ?? acpAgents.find(agent => agent.id === rememberedAcpAgent)?.id ?? acpAgents[0]?.id ?? '') : piMode;
  const handoverNeedsSandboxNotice = !isChat || (getChatCapabilities(effectiveRuntime).directories.registration === 'cwd-only' &&
    !(effectiveRuntime === 'acp' && effectivePiMode === 'cursor'));
  const runtimeReady = availability.ready && runtimeSelectionAvailable(availability.snapshot, runtimes, effectiveRuntime, effectivePiMode);
  const preservedScheduledSelection = !!scheduledEdit && availability.ready && effectiveRuntime === scheduledEdit.runtime &&
    effectivePiMode === (scheduledEdit.advanced.piModeId ?? '');
  // The terminal and chat surfaces use the same cached catalogue for the same
  // product. Keep the native CLI id separate from the GUI's opaque identity.
  const cliHarness = !isChat ? HARNESS_CATALOG.find(entry => entry.cliRuntimeId === effectiveRuntime) : undefined;
  const catalogRuntime = isChat ? effectiveRuntime : effEntry?.manifest?.chat ? 'acp' : cliCapabilities(effectiveRuntime, effEntry?.manifest).model ? cliHarness?.runtimeId ?? '' : '';
  const nativeSkillTarget = effEntry?.integrations?.skillTargets?.find(item => item.kind === (isChat ? 'gui' : 'cli'));
  // ACP presets share the named CLI's native skill directory. Other harnesses
  // can follow an explicit file reference from the workbench's Core catalog.
  const acpSkillTarget = isChat && effectiveRuntime === 'acp'
    ? runtimes.find(entry => entry.enabled && entry.id === HARNESS_CATALOG.find(harness => harness.acpPresetId === effectivePiMode)?.cliRuntimeId)
      ?.integrations?.skillTargets?.find(item => item.kind === 'cli') : undefined;
  const skillTarget = nativeSkillTarget ?? acpSkillTarget ?? runtimes.find(entry => entry.id === 'pi' && entry.enabled)?.integrations?.skillTargets?.find(item => item.id === 'pi-gui');
  const catalogAgent = isChat ? effectivePiMode : effEntry?.manifest?.chat ? effectiveRuntime : cliHarness?.acpPresetId ?? '';
  const catalogModelKey = isChat ? modelKey : cliOptions.model && catalogRuntime ? `${catalogRuntime}|${cliOptions.model}` : '';
  const usesKimiParameters = !scheduledEdit && !isChat && effectiveRuntime === 'kimi-cli';
  // Once the initial choice is shown, keep its identity if a later probe changes.
  // The user must explicitly choose another harness rather than send a draft to it by accident.
  useEffect(() => {
    if (!open || !availability.ready || runtime || !runtimeReady) return;
    setRuntime(effectiveRuntime);
    if (effectiveRuntime === 'acp') setPiMode(effectivePiMode);
  }, [open, availability.ready, runtime, runtimeReady, effectiveRuntime, effectivePiMode]);
  const core = isChat && effectiveRuntime === 'pi';
  const permissionOptions = guiPermissionOptions(effectiveRuntime, guiMode ? guiMode as GuiWorkerMode : undefined);
  const permissionReady = !configurePermissions || !core || !guiMode || supportsGuiPermissionMode(effectiveRuntime, guiMode as GuiWorkerMode);
  const matchingNativeConfig = nativeConfig?.identity.runtimeId === effectiveRuntime &&
    nativeConfig.identity.presetId === (effectiveRuntime === 'acp' ? effectivePiMode : undefined) ? nativeConfig : undefined;
  // ACP exposes model-specific reasoning in a session. Finish its model-list
  // discovery first so opening the picker does not start two ACP sessions at once.
  const acpParameterDiscoveryReady = catalogRuntime !== 'acp' ||
    (acpCatalogKey === `acp\0${catalogAgent}\0${source.requestKey}` && !acpModelsLoading);
  const parameterState = useTaskModelParameterState({ runtime: catalogRuntime, modelKey: catalogModelKey, piMode: catalogAgent,
    cwd: source.root?.path, source: source.target, values: modelParameters, onChange: setModelParameters, catalogRevision,
    enabled: open && (isChat || usesKimiParameters) && !!source.target && !!catalogRuntime && acpParameterDiscoveryReady && runtimeReady });

  // 打开瞬间清掉上一次的表单残留：在 render 阶段重置（先于首帧绘制）——
  // 挪到 effect 里会晚一拍，入场动画期间闪现上次留下的勾选，看起来像「默认勾着却没标注」。
  // 退场不清场，保持内容连续（presence 退场动画仍在显示旧内容）。
  const prevOpenRef = useRef(false);
  if (open !== prevOpenRef.current) {
    prevOpenRef.current = open;
    operation.current++;
    if (open) {
      openingId.current = randomUuid();
      lastSubmission.current = undefined;
      setSavedFiles(undefined); setAttachments([]); setReadingAttachments(false);
      setTask(todo?.task ?? (lockedTask ? '' : initialTask?.trim() ? initialTask : ''));
      setName(todo?.name ?? initialName ?? '');
      setIsolate(todo?.isolate ?? false);
      setError('');
      setBusy(false);
      setQueued(null);
      setPrecheck(undefined);
      setShowPicker(false);
      const saved = todo ?? scheduledEdit;
      setSurface(todo?.surface ?? (scheduledEdit ? runtimeSurface(runtimes.find(entry => entry.id === scheduledEdit.runtime)) : 'chat'));
      setRuntime(saved?.runtime ?? '');
      setGuiMode(saved?.advanced.guiMode ?? '');
      setConfigurePermissions(saved?.advanced.configurePermissions === true);
      setNativeConfig(saved?.advanced.nativeConfig);
      setPiMode(saved?.advanced.piModeId ?? '');
      setModelKey(saved?.advanced.model ? `${saved.advanced.model.providerId}|${saved.advanced.model.modelId}` : '');
      setCliOptions(saved?.advanced.cliLaunchOptions ?? {});
      setModelParameters(saved?.advanced.modelParameters);
      setRepoDirty(null);
      setPiModes(null);
      setProviders([]);
      setCodexModels([]);
      setCodexCatalogKey('');
      setCatalogNotice('');
    }
  }

  const previousSource = useRef(source.identity);
  if (previousSource.current !== source.identity) {
    previousSource.current = source.identity;
    if (showPicker) setShowPicker(false);
    const restoringTodo = !!todo && source.root?.id === todo.source?.rootId && source.root?.path === todo.source?.path;
    if (!restoringTodo) setIsolate(false);
    setRepoDirty(null);
    if (!restoringTodo && (!scheduledEdit || (source.target && source.target.rootId !== initialSource?.rootId))) {
      setModelKey('');
      setModelParameters(undefined);
      setCliOptions(previous => ({ ...previous, model: undefined, reasoning: undefined }));
    }
  }
  const currentWorkspace = useRef(workspace?.id);
  if (currentWorkspace.current !== workspace?.id) {
    currentWorkspace.current = workspace?.id;
    operation.current++;
    setBusy(false);
  }

  useEffect(() => {
    if (!open || waitingForFiles) return;
    const timer = window.setTimeout(() => {
      if (pickerPopup.current || taskRef.current?.closest('[role="dialog"]')?.contains(document.activeElement)) return;
      taskRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open, waitingForFiles]);

  useEffect(() => {
    if (!open || !source.target || !catalogRuntime) return;
    return window.api.on('agentSession:modelCatalogUpdated', event => {
      if (manualCatalogRequests.current.size || event.runtimeId !== catalogRuntime ||
          (event.runtimeId === 'acp' && event.agentId !== catalogAgent) ||
          (event.workspaceId !== source.target?.workspaceId || event.rootId !== source.target?.rootId)) return;
      if (event.error) {
        if (catalogRuntime === 'codex-gui') setCatalogNotice(event.error);
        else setAcpCatalogNotice(event.error);
      } else setCatalogUpdateRevision(value => value + 1);
    });
  }, [open, catalogRuntime, catalogAgent, source.requestKey, !!source.target]);

  useEffect(() => {
    if (!open || !isChat || !effectiveRuntime) return;
    // Pi modes and configured providers are local configuration, not model discovery.
    let cancelled = false;
    if (effectiveRuntime === 'pi') {
      setPiModes(null);
      void window.api.agentSession
        .listPiModes()
        .then((r) => {
          if (!cancelled) setPiModes((r ?? []).filter((p) => !p.broken));
        })
        .catch(() => {});
      void window.api.config
        .get()
        .then((cfg) => {
          if (cancelled) return;
          const configured = (cfg.llm?.providers ?? []).filter((p) => p.enabled !== false && p.models?.length);
          setProviders(configured);
          if (!configured.length) setCatalogNotice(t('没有已配置的模型，可使用默认模型'));
        })
        .catch(error => { if (!cancelled) setCatalogNotice((error as Error).message || String(error)); });
    }
    return () => {
      cancelled = true;
    };
  }, [open, isChat, effectiveRuntime]);

  const loadSimpleCatalog = async (refresh = false): Promise<void> => {
    if (!source.target || catalogRuntime !== 'codex-gui') return;
    const request = ++modelCatalogRequest.current;
    const manualKey = `simple:${request}`;
    if (refresh) manualCatalogRequests.current.add(manualKey);
    const catalogSource = source.requestKey;
    setCatalogNotice('');
    try {
      const result = await window.api.agentSession.listCodexModels(source.target, refresh);
      if (request !== modelCatalogRequest.current || !mounted.current) return;
      if (!result.ok) setCatalogNotice(result.error);
      else { setCodexModels(result.items); setCodexCatalogKey(catalogSource);
        setCatalogNotice(result.warning ?? (result.items.length ? '' : t('引擎未提供模型目录，可使用默认模型'))); }
      setCatalogRevision(value => value + 1);
    } catch (error) {
      if (request === modelCatalogRequest.current && mounted.current) setCatalogNotice((error as Error).message || String(error));
    } finally {
      manualCatalogRequests.current.delete(manualKey);
    }
  };
  useEffect(() => {
    setCodexModels([]); setCodexCatalogKey(''); setCatalogNotice('');
    if (open && source.target && (catalogRuntime === 'codex-gui')) void loadSimpleCatalog();
    return () => { modelCatalogRequest.current++; };
  }, [open, catalogRuntime, effectiveRuntime, source.requestKey, !!source.target, catalogUpdateRevision]);

  useEffect(() => {
    setAcpModels([]); setAcpCatalogKey(''); setAcpCatalogNotice(''); setAcpModelsLoading(false);
    return () => {
      const requestId = acpRequest.current;
      acpRequest.current = null;
      if (requestId) void window.api.agentSession.cancelHarnessModels(requestId).catch(error => console.warn('模型目录取消失败', error));
    };
  }, [open, effectiveRuntime, catalogRuntime, catalogAgent, source.requestKey]);

  const loadAcpModels = async (refresh = false): Promise<void> => {
    if (!source.target || acpModelsLoading || !['acp', 'claude', 'pi-external', 'omp', 'zcode-gui', 'muse-gui'].includes(catalogRuntime) || (catalogRuntime === 'acp' && !catalogAgent)) return;
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++acpRequestSeq.current).toString(36)}`;
    if (refresh) manualCatalogRequests.current.add(requestId);
    acpRequest.current = requestId;
    setAcpModelsLoading(true); setAcpCatalogNotice('');
    try {
      const result = catalogRuntime === 'acp'
        ? await window.api.agentSession.listAcpModels({ source: source.target, agentId: catalogAgent, requestId, modelId: parseModelKey(catalogModelKey)?.modelId, refresh, ...(!isChat ? { cliRuntimeId: effectiveRuntime } : {}) })
        : await window.api.agentSession.listLocalHarnessModels({ source: source.target, runtimeId: catalogRuntime as 'claude' | 'pi-external' | 'omp' | 'zcode-gui' | 'muse-gui', requestId, refresh, ...(!isChat ? { cliRuntimeId: effectiveRuntime } : {}) });
      if (acpRequest.current !== requestId || !mounted.current) {
        if (!result.ok && result.cleanupFailed) notifyComposerError(t('模型探测进程回收失败：{{message}}', { message: localizeGuiHostError(result.error) }));
        return;
      }
      if (result.ok) {
        setAcpModels(result.items);
        setAcpCatalogKey(`${catalogRuntime}\0${catalogRuntime === 'acp' ? catalogAgent : ''}\0${source.requestKey}`);
        setCatalogRevision(value => value + 1);
        if (!result.items.length) setAcpCatalogNotice(t('引擎未提供模型目录，可使用默认模型'));
      } else setAcpCatalogNotice(result.error);
    } catch (error) {
      if (acpRequest.current === requestId) setAcpCatalogNotice((error as Error).message || String(error));
    } finally {
      manualCatalogRequests.current.delete(requestId);
      if (acpRequest.current === requestId) { acpRequest.current = null; setAcpModelsLoading(false); }
    }
  };

  // Restore only a previous snapshot; selecting a harness never launches discovery.
  const autoCatalogKey = useRef('');
  useEffect(() => {
    const hasCatalog = ['acp', 'claude', 'pi-external', 'omp', 'zcode-gui', 'muse-gui'].includes(catalogRuntime);
    if (!open || !hasCatalog) { autoCatalogKey.current = ''; return; }
    if (!source.target || !runtimeReady || acpModelsLoading) return;
    // GUI and CLI can map to the same catalog identity but switching surfaces
    // clears this component's local snapshot, so each surface must reload it.
    const key = `${surface}\0${effectiveRuntime}\0${catalogRuntime}\0${catalogRuntime === 'acp' ? catalogAgent : ''}\0${source.requestKey}\0${catalogUpdateRevision}`;
    if (autoCatalogKey.current === key) return;
    autoCatalogKey.current = key;
    void loadAcpModels();
  }, [open, catalogRuntime, catalogAgent, effectiveRuntime, source.requestKey, !!source.target, runtimeReady, acpModelsLoading, catalogUpdateRevision]);

  useEffect(() => {
    if (!open || !source.target || queued) return;
    let cancelled = false;
    const key = source.requestKey;
    void window.api.sessions.precheck(source.target.workspaceId, source.target.rootId, source.target.rootsRevision)
      .then(r => {
        if (cancelled) return;
        setPrecheck({ key });
        setRepoDirty(r.dirty);
      }).catch(e => {
        if (!cancelled) setPrecheck({ key, error: (e as Error).message || String(e) });
      });
    return () => { cancelled = true; };
  }, [open, source.requestKey, !!source.target, retry, !!queued]);
  const precheckReady = precheck?.key === source.requestKey && !precheck.error;

  // presence 进出场（mp-panel/mp-scrim 可打断）；退场期间表单内容保留
  const presence = usePresence(open);
  useOverlayDismiss(open && presence.stage !== 'out', () => { if (!busy) onClose(); });
  useOverlayDismiss(open && showPicker, closePicker);

  if (!presence.mounted) return null;

  const cliCapability = cliCapabilities(effectiveRuntime, effEntry?.manifest);
  const cliModelLevels = (modelId: string): readonly string[] | undefined => {
    if (!modelId) return undefined;
    if (effectiveRuntime === 'codex' && codexCatalogKey === source.requestKey) return codexModelReasoningLevels(codexModels, modelId);
    if (effectiveRuntime === 'claude-code' && acpCatalogKey === `claude\0\0${source.requestKey}`) {
      return claudeModelReasoningLevels(acpModels, modelId);
    }
    return undefined;
  };
  const selectedCliModelLevels = cliModelLevels(cliOptions.model ?? '');
  const cliPermissionMode = effectiveRuntime === 'codex' || effectiveRuntime === 'muse-cli';
  const cliModeLabel = t(cliCapability.modeLabel === 'Sandbox' ? '沙箱'
    : cliCapability.modeLabel === 'Approval Judge' ? '审批审核' : cliCapability.modeLabel ?? '引擎模式');
  const activeCliOptions = configurePermissions ? cliOptions : {
    ...cliOptions, permission: undefined, ...(cliPermissionMode ? { mode: undefined } : {})
  };

  const collectAdvanced = (): NewTaskAdvanced => {
    if (!isChat) {
      const kimiReasoning = usesKimiParameters ? parameterState.snapshot?.values.reasoning : undefined;
      const normalized = normalizeCliLaunchOptions(effectiveRuntime, { ...activeCliOptions, ...(kimiReasoning ? { reasoning: kimiReasoning } : {}) }, effEntry?.manifest, selectedCliModelLevels);
      return { configurePermissions, ...(normalized ? { cliLaunchOptions: normalized } : {}) };
    }
    const advanced: NewTaskAdvanced = { configurePermissions, ...(extensionSource ? { extensionSource } : {}) };
    if (configurePermissions && core && guiMode) advanced.guiMode = guiMode as GuiWorkerMode;
    if (configurePermissions && matchingNativeConfig) advanced.nativeConfig = matchingNativeConfig;
    if (effectiveRuntime === 'pi' && piMode) advanced.piModeId = piMode;
    if (effectiveRuntime === 'acp' && effectivePiMode) advanced.piModeId = effectivePiMode;
    if (modelKey) {
      const model = parseModelKey(modelKey);
      if (model) advanced.model = model;
    }
    if (modelParameters) advanced.modelParameters = modelParameters;
    return advanced;
  };

  const submit = async (text: string, files?: ChatImageAttachment[]): Promise<boolean> => {
    const supplement = text.trim();
    const taskText = lockedTask ? canvasHandoverTask(lockedTask, supplement) : supplement;
    if ((!taskText && !files?.length) || (scheduledEdit && !name.trim()) || disabled || cliOptionError || cliParameterPending || (!runtimeReady && !preservedScheduledSelection) || !permissionReady || !selectedModelAllowed || !source.target || !precheckReady || !repositories.ready) return false;
    if (scheduledEdit) {
      scheduledEdit.onSave({ task: taskText, name: name.trim(), runtime: effectiveRuntime, advanced: collectAdvanced(), source: source.target });
      onClose();
      return true;
    }
    const generation = ++operation.current;
    setBusy(true);
    setError('');
    try {
      const checked = availability.snapshot;
      if (!mounted.current || operation.current !== generation) return false;
      if (!runtimeSelectionAvailable(checked, registeredRef.current, effectiveRuntime, effectivePiMode)) throw new Error(t('所选 Worker 已不可用，请重新选择'));
      writeLastTaskRuntime(effectiveRuntime, effectivePiMode);
      const launch = {
        task: taskText,
        ...(lockedTask ? { supplement } : {}),
        runtime: effectiveRuntime,
        isolate,
        name: name.trim(),
        advanced: collectAdvanced(),
        source: isolate ? { ...source.target, cwd: source.root?.path } : source.target,
        ...(repositories.request ? { isolationGroups: repositories.request.isolationGroups } : {})
      };
      const fingerprint = JSON.stringify([launch, files?.map(file => file.id)]);
      if (lastSubmission.current?.fingerprint !== fingerprint) {
        lastSubmission.current = { fingerprint, id: randomUuid() };
      }
      const result = await onDelegate({ ...launch, submissionId: lastSubmission.current.id,
        ...(files?.length ? { attachments: files } : {}) });
      if (!mounted.current || operation.current !== generation) return false;
      if (todo && (result.queued || result.session)) {
        // The runtime has accepted this TODO. Disable repeat launches even if cleanup fails.
        setQueued(result);
        await window.api.boardTodos.delete(todo.id);
      }
      if (result.queued) { setQueued(result); setBusy(false); return true; }
      if (!result.session) throw new Error(t('任务未创建，请重试'));
      onClose();
      onSessionCreated?.();
      return true;
    } catch (e) {
      if (!mounted.current || operation.current !== generation) return false;
      setError((e as Error).message || String(e));
      setBusy(false);
      return false;
    }
  };

  const blank = async (): Promise<void> => {
    if (disabled || cliOptionError || cliParameterPending || !runtimeReady || !permissionReady || !selectedModelAllowed || !source.target || !repositories.ready) return;
    const generation = ++operation.current;
    setBusy(true); setError('');
    try {
      const checked = availability.snapshot;
      if (!mounted.current || operation.current !== generation) return;
      if (!runtimeSelectionAvailable(checked, registeredRef.current, effectiveRuntime, effectivePiMode)) throw new Error(t('所选 Worker 已不可用，请重新选择'));
      writeLastTaskRuntime(effectiveRuntime, effectivePiMode);
      if (isolate) await onBlankSession(effectiveRuntime, name.trim(), collectAdvanced(),
        { ...source.target, cwd: source.root?.path },
        { isolate, ...(repositories.request ? { isolationGroups: repositories.request.isolationGroups } : {}) });
      else await onBlankSession(effectiveRuntime, name.trim(), collectAdvanced(), source.target);
      if (mounted.current && operation.current === generation) {
        onClose();
        onSessionCreated?.();
      }
    } catch (e) {
      if (!mounted.current || operation.current !== generation) return;
      setError((e as Error).message || String(e)); setBusy(false);
    }
  };

  const saveTodo = async (): Promise<void> => {
    if (waitingForFiles || (!task.trim() && !attachments.length) || readingAttachments || disabled) return;
    const generation = ++operation.current;
    setBusy(true); setError('');
    try {
      const saved = await window.api.boardTodos.save({
        task, name, ...(attachments.length ? { attachments } : {}), workspaceId: workspace?.id ?? todo?.workspaceId,
        source: source.root ? { rootId: source.root.id, path: source.root.path } : todo?.source,
        surface, runtime: effectiveRuntime,
        advanced: isChat ? { configurePermissions, ...(extensionSource ? { extensionSource } : {}), ...(configurePermissions && core && guiMode ? { guiMode: guiMode as GuiWorkerMode } : {}),
          ...(configurePermissions && matchingNativeConfig ? { nativeConfig: matchingNativeConfig } : {}),
          ...(effectivePiMode ? { piModeId: effectivePiMode } : {}),
          ...(parseModelKey(modelKey) ? { model: parseModelKey(modelKey)! } : {}),
          ...(modelParameters ? { modelParameters } : {}) } : { configurePermissions, cliLaunchOptions: activeCliOptions, ...(modelParameters ? { modelParameters } : {}) },
        isolate, ...(isolate ? { isolationGroups: repositories.request?.isolationGroups ?? todo?.isolationGroups } : {})
      }, todo?.id);
      if (!mounted.current || operation.current !== generation) return;
      onTodoSaved?.(saved);
      onClose();
    } catch (error) {
      if (mounted.current && operation.current === generation) { setError((error as Error).message || String(error)); setBusy(false); }
    }
  };

  const deleteTodo = async (): Promise<void> => {
    if (!todo || busy) return;
    const generation = ++operation.current;
    setBusy(true); setError('');
    try {
      await window.api.boardTodos.delete(todo.id);
      if (mounted.current && operation.current === generation) onClose();
    } catch (error) {
      if (mounted.current && operation.current === generation) { setError((error as Error).message || String(error)); setBusy(false); }
    }
  };

  // 无目录时仍显示跟随默认；不把示例目录当作可用模型。
  const providerModelOptions = providers.flatMap((p) =>
    (p.models ?? []).map((m) => ({ value: `${p.id}|${m.id}`, label: `${p.name || p.id} · ${m.name || m.id}` }))
  );
  const runtimeOption = effectiveRuntime === 'acp' ? `acp:${effectivePiMode}` : effectiveRuntime;
  const scheduledOriginalModel = scheduledEdit?.advanced.model;
  const selectedModelAllowed = !isChat || !modelKey || allowModel(runtimeOption, modelKey) ||
    (!!scheduledEdit && preservedScheduledSelection && modelKey === `${scheduledOriginalModel?.providerId}|${scheduledOriginalModel?.modelId}`);
  const rawModelOptions = effectiveRuntime === 'codex-gui' ? (codexCatalogKey === source.requestKey ? codexModels.map(model => ({ value: `codex-gui|${model.id}`, label: model.displayName })) : [])
    : effectiveRuntime === 'pi' ? providerModelOptions
      : (effectiveRuntime === 'acp' || effectiveRuntime === 'claude' || effectiveRuntime === 'pi-external' || effectiveRuntime === 'omp' || effectiveRuntime === 'zcode-gui' || effectiveRuntime === 'muse-gui') && acpCatalogKey === `${effectiveRuntime}\0${effectiveRuntime === 'acp' ? effectivePiMode : ''}\0${source.requestKey}`
        ? acpModels.map(model => ({ value: `${effectiveRuntime}|${model.id}`, label: model.name })) : [];
  const modelOptions = rawModelOptions.filter(item => allowModel(runtimeOption, item.value));
  const runtimeOptions = enabledForSurface.map(entry => ({ value: entry.id, label: entry.label }));
  const cliParameterPending = usesKimiParameters && !!Object.keys(modelParameters ?? {}).length &&
    (!parameterState.snapshot || !!parameterState.snapshot.unavailable);
  let cliOptionError = '';
  if (!isChat) { try { normalizeCliLaunchOptions(effectiveRuntime, activeCliOptions, effEntry?.manifest, selectedCliModelLevels); } catch (error) { cliOptionError = (error as Error).message; } }
  const cliCatalog = catalogRuntime === 'codex-gui' && codexCatalogKey === source.requestKey
    ? codexModels.map(item => ({ id: item.id, name: item.displayName }))
    : acpCatalogKey === `${catalogRuntime}\0${catalogRuntime === 'acp' ? catalogAgent : ''}\0${source.requestKey}` ? acpModels : [];
  const cliHarnessKey = catalogRuntime === 'acp' ? `acp:${catalogAgent}` : catalogRuntime;
  const cliModels = cliCapability.model ? cliCatalog.flatMap(item => {
    if (!allowModel(cliHarnessKey, `${catalogRuntime}|${item.id}`)) return [];
    const pi = catalogRuntime === 'pi-external' || catalogRuntime === 'omp' ? parseExternalPiModelKey(item.id) : null;
    const id = pi ? (!pi.providerId.includes('/') ? `${pi.providerId}/${pi.modelId}` : '') : item.id;
    try { normalizeCliLaunchOptions(effectiveRuntime, { model: id }, effEntry?.manifest); }
    catch { return []; }
    return id ? [{ value: id, label: item.name }] : [];
  }) : [];
  const selectedUnavailable = availability.ready && !!runtimeOption && !runtimeReady;
  const choices = HARNESS_CATALOG.filter(entry => !!entry.runtimeId).map(entry => {
    const preset = entry.acpPresetId;
    const available = runtimeSelectionAvailable(availability.snapshot, runtimes, entry.runtimeId!, preset);
    return { value: preset ? `acp:${preset}` : entry.runtimeId!, name: entry.name, iconId: entry.id, available };
  });
  const catalogPresets = new Set(HARNESS_CATALOG.map(entry => entry.acpPresetId).filter(Boolean));
  for (const agent of acpAgents) {
    if (catalogPresets.has(agent.id)) continue;
    const available = runtimeSelectionAvailable(availability.snapshot, runtimes, 'acp', agent.id);
    choices.push({ value: `acp:${agent.id}`, name: agent.name, iconId: agent.id, available });
  }
  const catalogRuntimes = new Set(HARNESS_CATALOG.map(entry => entry.runtimeId).filter(Boolean));
  for (const entry of runtimes) {
    if (runtimeSurface(entry) !== 'chat' || catalogRuntimes.has(entry.id)) continue;
    const available = runtimeSelectionAvailable(availability.snapshot, runtimes, entry.id);
    choices.push({ value: entry.id, name: entry.label, iconId: entry.id, available });
  }
  const availableChoices = choices.filter(choice => choice.available);
  const selectedHarnessVisible = availableChoices.some(choice => choice.value === runtimeOption);
  const modelFollowLabel = effectiveRuntime === 'pi' ? t('跟随全局激活服务商') : t('跟随 {{runtime}} 配置', {
    runtime: choices.find(choice => choice.value === runtimeOption)?.name ?? effEntry?.label ?? effectiveRuntime
  });
  const activeHarness = isChat ? choices.find(choice => choice.value === runtimeOption) : undefined;
  const harnessLabel = activeHarness?.name ?? effEntry?.label ?? effectiveRuntime;
  const harnessIcon = activeHarness?.iconId ?? cliHarness?.id ?? effectiveRuntime;
  const activeModel = isChat ? modelOptions.find(option => option.value === modelKey)?.label ?? parseModelKey(modelKey)?.modelId ?? modelFollowLabel
    : cliModels.find(option => option.value === cliOptions.model)?.label ?? cliOptions.model ?? t('跟随 CLI 配置');
  const allIncluded = repositories.choices.length > 0 && repositories.choices.every(choice => repositories.selected.some(selected => selected.key === choice.key));
  const scopeLabel = repositories.loading ? t('读取仓库中…') : repositories.error || repositories.removed ? t('检查隔离范围')
    : !repositories.choices.length ? t('没有可隔离仓库') : allIncluded ? t('全部仓库')
      : t('已选 {{count}} 个仓库', { count: repositories.selected.length });
  const reasoningControls = parameterState.snapshot?.controls.filter(control => control.descriptor.semantic === 'reasoning') ?? [];
  const effortSummary = reasoningControls.flatMap(control => control.override
    ? control.descriptor.options.find(option => option.value === control.override)?.label ?? [] : []).join(' · ');
  const kimiPreparedSession = usesKimiParameters && !!parameterState.snapshot?.values.reasoning;
  const targetSummary = [isChat ? 'GUI' : 'CLI', harnessLabel || t('选择 Harness'), activeModel,
    isChat || usesKimiParameters ? effortSummary : cliOptions.reasoning].filter(Boolean).join(' · ');
  const confirmPicker = ({ harness, model, nativeLaunchModel, parameters }: PickerSelection) => {
    const nextIsChat = harness.surface === 'gui';
    const changedHarness = isChat !== nextIsChat || harness.runtimeId !== effectiveRuntime || (harness.acpPresetId ?? '') !== (effectiveRuntime === 'acp' ? effectivePiMode : '');
    setSurface(nextIsChat ? 'chat' : 'pty');
    setRuntime(harness.runtimeId);
    if (changedHarness) {
      setGuiMode(''); setNativeConfig(undefined); setPiMode(''); setModelKey(''); setCliOptions({});
    }
    if (nextIsChat) {
      if (changedHarness) setPiMode(harness.acpPresetId ?? '');
      setModelKey(model ? `${model.providerId}|${model.modelId}` : '');
      setModelParameters(Object.keys(parameters).length ? parameters : undefined);
    } else {
      const options = changedHarness ? {} : cliOptions;
      const { model: _oldModel, reasoning: _oldReasoning, ...remaining } = options;
      setCliOptions({ ...remaining, ...(nativeLaunchModel ? { model: nativeLaunchModel } : {}),
        ...(parameters.reasoning && harness.runtimeId !== 'kimi-cli' ? { reasoning: parameters.reasoning } : {}) });
      setModelParameters(harness.runtimeId === 'kimi-cli' && Object.keys(parameters).length ? parameters : undefined);
    }
    closePicker();
    return { ok: true };
  };
  const permissionFields = core ? undefined : <div className="task-permission-fields">
    {!isChat && cliCapability.permissions?.length ? <label className="new-task-field">{t('启动权限')}
      <CustomSelect ariaLabel={t('启动权限')} menuClassName="task-permission-menu" value={cliOptions.permission ?? ''} disabled={disabled || !configurePermissions}
        onChange={value => setCliOptions(previous => ({ ...previous, permission: value }))}
        options={[{ value: '', label: t('跟随 CLI 配置') }, ...cliCapability.permissions.map(item => ({ value: item.value, label: t(item.label) }))]} />
    </label> : !isChat ? <label className="new-task-field">{t('权限')}
      <CustomSelect ariaLabel={t('权限')} value="" disabled options={[{ value: '', label: t('由 CLI 管理') }]} onChange={() => {}} />
    </label> : null}
    {!isChat && cliPermissionMode && cliCapability.modes?.length ? <label className="new-task-field">{cliModeLabel}
      <CustomSelect ariaLabel={cliModeLabel} value={cliOptions.mode ?? ''} disabled={disabled || !configurePermissions}
        onChange={value => setCliOptions(previous => ({ ...previous, mode: value }))}
        options={[{ value: '', label: t('跟随 CLI 配置') }, ...cliCapability.modes.map(item => ({ value: item.value, label: t(item.label) }))]} />
    </label> : null}
    {isChat && selectedHarnessVisible && source.target ? <NativeConfigLaunchFields
      target={{ runtimeId: effectiveRuntime, presetId: effectiveRuntime === 'acp' ? effectivePiMode : undefined, source: source.target }}
      selection={matchingNativeConfig} onChange={setNativeConfig} disabled={disabled || !configurePermissions} /> : null}
  </div>;
  const permissionMode = (core && !configurePermissions ? 'auto' : guiMode || 'default') as GuiWorkerMode;
  const permissionLabel = core
    ? (configurePermissions && !guiMode ? t('跟随默认') : undefined)
    : isChat ? t('引擎设置') : t(cliCapability.permissions?.find(item => item.value === activeCliOptions.permission)?.label ?? '权限');

  const hasFeedback = !!(error || source.error || busy || queued || !permissionReady || selectedUnavailable ||
    (availability.ready && (isChat ? !availableChoices.length : !enabledForSurface.length)) ||
    (selectedHarnessVisible && effectiveRuntime === 'zcode-gui') || ((isChat || usesKimiParameters) && parameterState.error) || catalogNotice || runtimeConfigNotice || acpCatalogNotice || modelSelections.error || !selectedModelAllowed ||
    (isolate && (repositories.error || repositories.warning || repositories.removed)) ||
    cliOptionError || kimiPreparedSession || (!isChat && (cliOptions.reasoning || (effectiveRuntime === 'codex' && cliOptions.permission))) || (source.target && !queued && !precheckReady) || availability.loading || availability.error);

  return createPortal(<>
    <div
      className="new-task-overlay mp-scrim"
      data-mp-stage={presence.stage}
      aria-hidden={!open || undefined}
      {...(!open ? { inert: '' } : {})}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy && !showPicker) onClose();
      }}
    >
      <div
        className={`new-task-dialog mp-panel${isChat ? '' : ' is-cli'}${lockedTask ? ' is-handover' : ''}`}
        data-mp-stage={presence.stage}
        role="dialog"
        data-overlay-root=""
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <div className="new-task-head">
          <div className="new-task-title" id="new-task-title">{todo ? t('编辑代办') : scheduledEdit ? t('编辑任务') : t('新建任务')}</div>
          <button type="button" className="modal-close" disabled={busy} aria-label={t('关闭新建任务')} onClick={onClose}>×</button>
        </div>
        <div className="new-task-content">
        <div className="new-task-row new-task-environment">
          <TaskSourceField source={source} disabled={disabled || extensionSource?.scope === 'project'} showError={false} />
          {!scheduledEdit && <NewTaskIsolationPicker dialogOpen={open} disabled={disabled || !source.target} isolate={isolate}
            hasUncommittedChanges={precheckReady && repoDirty === true}
            onChange={setIsolate} selection={repositories} scopeLabel={scopeLabel} />}
          <label className="new-task-field new-task-field-name">
            <span>{scheduledEdit ? t('任务名称') : <>{t('会话名称')} <span className="new-task-optional">{t('可选')}</span></>}</span>
            <input value={name} disabled={disabled} placeholder={t('自动命名')} onChange={e => setName(e.target.value)} />
          </label>
        </div>
        <div className="new-task-composer" ref={taskRef}>
          {waitingForFiles ? <div role="status">{error
            ? <button type="button" className="git-btn" onClick={() => { setError(''); setFileRetry(n => n + 1); }}>{t('重试')}</button>
            : t('加载中…')}</div> : <AgentComposer key={openingId.current} surfaceKind="gui-session" workspaceId={source.target?.workspaceId ?? null}
            interactionActive={open && !showPicker} disabled={disabled} busy={false} onSend={submit} onValueChange={setTask}
            allowImages={!scheduledEdit} plusMenu extensionTask={!!extensionSource} extensionSkillNames={extensionSkillNames}
            skillTarget={skillTarget?.id} workerRoutingScope={!isWebGateway() && source.target
              ? { ...source.target, rootsRevision: source.target.rootsRevision ?? 0, cwd: source.root?.path } : undefined}
            permissionConfiguration={{ enabled: configurePermissions, onChange: setConfigurePermissions,
              disabled: disabled || (isChat ? !selectedHarnessVisible : !runtimeReady),
              triggerLabel: permissionLabel, fields: permissionFields,
              inherit: core ? { selected: !guiMode, reset: () => setGuiMode('') } : undefined }}
            mode={permissionMode} onModeChange={core ? setGuiMode : undefined}
            modeOrder={core ? permissionOptions.map(option => option.mode) : undefined}
            modeChipLabels={Object.fromEntries(permissionOptions.map(option => [option.mode, option.label]))}
            modeDescriptions={core ? Object.fromEntries(permissionOptions.map(option => [option.mode, option.description])) : undefined}
            modeDisabled={Object.fromEntries(permissionOptions.map(option => [option.mode, !!(option.disabled || option.legacy)]))}
            nativeSettings={<>
              {core && runtimeReady && (!!piModes?.length || !!piMode) ? <CustomSelect placement="above"
                className="task-composer-mode" ariaLabel={t('引擎模式')} menuClassName="task-composer-mode-menu"
                value={piMode} disabled={disabled} onChange={setPiMode}
                options={[{ value: '', label: t('标准') }, ...(piModes ?? []).map(p => ({ value: p.id, label: p.name }))]}
                placeholder={piMode} /> : null}
              {!scheduledEdit && !isChat && runtimeReady && !cliPermissionMode && !!cliCapability.modes?.length ?
                <CustomSelect placement="above" className="task-composer-mode" menuClassName="task-composer-mode-menu" ariaLabel={cliModeLabel} value={cliOptions.mode ?? ''} disabled={disabled}
                  onChange={mode => setCliOptions(previous => ({ ...previous, mode }))}
                  options={[{ value: '', label: cliModeLabel }, ...cliCapability.modes.map(item => ({ value: item.value, label: t(item.label) }))]} /> : null}
            </>}
            creation={{ initialText: task, initialAttachments: savedFiles?.items, onAttachments: attachmentsChanged,
              label: t(lockedTask ? '本次任务' : '任务'), placeholder: t(lockedTask ? '输入交接后的任务，交接信息会自动补充' : '想让 Agent 做什么？'),
              submitLabel: t(scheduledEdit ? '保存' : '开始任务'), allowEmpty: !!lockedTask, rootId: source.target?.rootId,
              cli: !isChat, skillFileReference: !isChat || !nativeSkillTarget,
              submitDisabled: !!cliOptionError || cliParameterPending || (!!scheduledEdit && !name.trim()) ||
                (!runtimeReady && !preservedScheduledSelection) || !permissionReady || !selectedModelAllowed ||
                !source.target || !precheckReady || !repositories.ready,
              targetButton: (
                <button ref={pickerTrigger} type="button" className="c-select-trigger new-task-harness-trigger"
                  style={{ anchorName: pickerAnchor } as React.CSSProperties} aria-controls={showPicker ? pickerId : undefined}
                  aria-label={t('选择 Harness 和模型')} aria-haspopup="dialog" aria-expanded={showPicker} aria-description={targetSummary} title={targetSummary}
                  disabled={disabled || !source.target} onClick={() => setShowPicker(current => !current)}>
                  {harnessIcon ? <HarnessIcon harnessId={harnessIcon} size={18} /> : null}
                  <span className="c-select-value">{targetSummary}</span>
                </button>
              ) }} />}
        </div>
        {lockedTask && handoverNeedsSandboxNotice ? <div className="new-task-note" role="status">
          {t('所选引擎的沙箱可能需要手动允许读取交接文档目录；如果无法读取，请调整引擎权限或选择其他 Harness。')}
        </div> : null}

        {!isChat && !configurePermissions && runtimeReady && !supportsAutomaticCliPermissions(effectiveRuntime, effEntry?.manifest)
          ? <span className="new-task-note" role="status">{t('此 CLI 未提供可靠的免审批参数，终端内仍可能要求确认。')}</span> : null}
        </div>
        <div ref={feedbackRef} className="new-task-feedback" aria-live="polite" aria-label={t('状态与提示')} tabIndex={hasFeedback ? 0 : undefined}>
        {error ? <ErrorTip message={localizeGuiHostError(localizeCliLaunchError(error))} /> : null}
        {source.error ? <ErrorTip message={source.error} /> : null}
        {source.target && !queued && !precheckReady && precheck?.key === source.requestKey && precheck.error ? <><ErrorTip message={t('目录预检失败：{{message}}', { message: precheck.error })} /><button type="button" className="git-btn ghost tiny" disabled={busy} onClick={() => setRetry(r => r + 1)}>{t('重试')}</button></> : null}
        {isolate && (repositories.error || repositories.warning || repositories.removed) ? <ErrorTip message={repositories.error || repositories.warning || t('所选仓库已失效，请重新选择隔离范围。')} /> : null}
        {!queued && availability.error && !availability.loading ? <><ErrorTip message={t('Worker 检测失败：{{message}}', { message: availability.error })} /><button type="button" className="git-btn ghost tiny" disabled={busy} onClick={() => void availability.refresh(true)}>{t('重新检测 Worker')}</button></> : null}
        {isChat && availability.ready && !availableChoices.length ? <span className="new-task-note" role="status">
          {t('暂无可用 Harness，请在设置 → Worker 中安装或配置。')}
          {onOpenWorkerSettings ? <button type="button" className="git-btn ghost tiny" disabled={disabled}
            onClick={() => { onClose(); onOpenWorkerSettings(); }}>{t('前往设置')}</button> : null}
        </span> : null}
        {!isChat && availability.ready && !enabledForSurface.length ? <span className="new-task-note" role="status">
          {t('暂无可用 CLI，请在设置 → Worker 中启用或配置终端入口。')}
          {onOpenWorkerSettings ? <button type="button" className="git-btn ghost tiny" disabled={disabled}
            onClick={() => { onClose(); onOpenWorkerSettings(); }}>{t('前往设置')}</button> : null}
        </span> : null}
        {!permissionReady ? <span className="new-task-note" role="alert">{t('当前 Harness 不支持所选权限，请重新选择权限。')}</span> : null}
        {selectedUnavailable && (isChat ? availableChoices.length > 0 : runtimeOptions.length > 0) ? <span className="new-task-note" role="status">{t('所选 Agent 当前不可用，请重新选择或前往设置检查。')}</span> : null}
        {(isChat || usesKimiParameters) && parameterState.error ? <span className="new-task-note" role="status">{parameterState.error}</span> : null}
        {catalogNotice ? <span className="new-task-note" role="status">{localizeGuiHostError(catalogNotice)}</span> : null}
        {modelSelections.error ? <span className="new-task-note" role="alert">{modelSelections.error}</span> : null}
        {!selectedModelAllowed ? <span className="new-task-note" role="status">{t('该模型已在设置中隐藏，请重新选择模型')}</span> : null}
        {runtimeConfigNotice ? <span className="new-task-note" role="status">{t('读取默认 Worker 失败：{{message}}', { message: runtimeConfigNotice })}</span> : null}
        {acpCatalogNotice ? <span className="new-task-note" role="status">{localizeGuiHostError(acpCatalogNotice)}</span> : null}
        {cliOptionError ? <span className="new-task-note" role="alert">{localizeCliLaunchError(cliOptionError)}</span> : null}
        {kimiPreparedSession ? <span className="new-task-note" role="status">{t('设置思考强度时，Kimi 会准备并接续会话，MCP 和会话钩子会额外启动一次。')}</span> : null}
        {!isChat && cliOptions.reasoning ? <span className="new-task-note" role="status">{t('思考强度的支持范围取决于 CLI 版本和所选模型。')}</span> : null}
        {configurePermissions && !isChat && effectiveRuntime === 'codex' && cliOptions.permission ? <span className="new-task-note" role="status">{t('Codex 恢复或分叉已有会话时沿用该会话原有权限。')}</span> : null}
        {selectedHarnessVisible && effectiveRuntime === 'zcode-gui' ? <span className="new-task-note">{t('当前使用 ZCode 兼容协议；原生 MCP 配置不会自动合并，请在工作台登记第三方 MCP。每轮会重新启动引擎。')}</span> : null}
        {source.target && !queued && !precheckReady && !(precheck?.key === source.requestKey && precheck.error)
          ? <div className="new-task-note" role="status">{t('正在检查所选目录…')}</div> : null}
        {queued ? <div className="new-task-note" role="status">{queued.queued ? t('任务已排队（第 {{position}} 位），空闲后将在所选目录启动。', { position: queued.queuePosition ?? 1 }) : t('任务已启动')}</div> : null}
        {!queued && availability.loading ? <div className="new-task-note" role="status">
          {!busy ? <BrandLoading>{t('正在检测 Worker…')}</BrandLoading> : t('正在检测 Worker…')}
        </div> : null}
        {busy ? <BrandLoading>{t('处理中…')}</BrandLoading> : null}
        </div>
        <div className="new-task-actions">
          <span className="new-task-shortcut">{/Mac/i.test(navigator.platform) ? '⌘ Enter' : 'Ctrl + Enter'}</span>
          <div className="new-task-actions-spacer" />
          <button type="button" className="git-btn ghost" disabled={busy} onClick={onClose}>
            {queued ? t('关闭') : t('取消')}
          </button>
          <div className="new-task-primary-actions">
          {todo ? <button type="button" className="git-btn ghost" disabled={busy} onClick={() => void deleteTodo()}>{t('删除代办')}</button> : null}
          {!lockedTask && !scheduledEdit ? <button type="button" className="git-btn" disabled={disabled || waitingForFiles || readingAttachments || (!task.trim() && !attachments.length)}
            title={t('保存到全局看板，双击继续编辑')} onClick={() => void saveTodo()}>
            {todo ? t('保存代办') : t('添加代办')}
          </button> : null}
          {!lockedTask && !scheduledEdit && !todo ? <button
            type="button"
            className="git-btn"
            disabled={disabled || !!cliOptionError || cliParameterPending || !runtimeReady || !permissionReady || !selectedModelAllowed || !source.target || !repositories.ready}
            title={t('先建一个空会话并发送简短的宿主介绍，稍后再派活')}
            onClick={() => void blank()}
          >
            {t('新建空白')}
          </button> : null}

          </div>
        </div>
      </div>
    </div>
    {pickerPresence.mounted && source.target && <ComposerFlyout variant="harness" anchor={{ ref: pickerTrigger, name: pickerAnchor }} popupRef={pickerPopup}>
      <div id={pickerId} role="dialog" aria-label={t('选择 Harness 和模型')}
        className="agent-composer-model-menu model-picker-popup mp-pop mp-pop-up" {...pickerPresence.spread}
        aria-hidden={!showPicker || !open || undefined} {...(!showPicker || !open ? { inert: '' } : {})}
        onBlur={event => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== pickerTrigger.current) setShowPicker(false);
        }}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault(); event.stopPropagation(); closePicker();
        }}>
        <HarnessModelPicker key={source.requestKey} active={open && showPicker} target={{ source: source.target, surface: isChat ? 'gui' : 'cli' }}
          initial={{ harness: effectiveRuntime ? { harnessId: harnessIcon, runtimeId: effectiveRuntime, surface: isChat ? 'gui' : 'cli',
            ...(effectiveRuntime === 'acp' ? { acpPresetId: effectivePiMode } : {}) } : undefined,
            model: isChat ? parseModelKey(modelKey) ?? null : undefined, nativeLaunchModel: isChat ? undefined : cliOptions.model,
            parameters: isChat || usesKimiParameters ? modelParameters : cliOptions.reasoning ? { reasoning: cliOptions.reasoning } : undefined }}
          surfaceSelection={{ cliDisabledReason: extensionSource ? t('扩展创作需要支持宿主工具的 GUI Harness') : undefined }}
          manualModel={harness => harness.surface === 'cli' && !scheduledEdit && !!cliCapabilities(harness.runtimeId, runtimes.find(entry => entry.id === harness.runtimeId)?.manifest).model}
          validate={({ harness, nativeLaunchModel, parameters }) => {
            if (harness.surface !== 'cli') return;
            try { normalizeCliLaunchOptions(harness.runtimeId, { model: nativeLaunchModel, reasoning: parameters.reasoning },
              runtimes.find(entry => entry.id === harness.runtimeId)?.manifest); }
            catch (error) { return localizeCliLaunchError((error as Error).message); }
          }}
          confirmLabel={t('确认配置')} onCancel={closePicker} onConfirm={confirmPicker} />
      </div>
    </ComposerFlyout>}
    </>,
    document.body
  );
}
