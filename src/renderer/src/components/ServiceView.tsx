import { ErrorTip, ErrorTipDetails } from './ErrorTip';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseModelKey } from '../modelKey';
import type {
  GuiThinkingLevel,
  GuiWorkerMode,
  MissedPolicy,
  PromptTask,
  TaskRun,
  TaskSchedule
} from '../../../shared/types';
import { supportsGuiPermissionMode } from '../../../shared/guiPermissionOptions';
import { useRuntimesStore, useUiStore, useWorkspaceStore } from '../store';
import { jumpToSession } from '../sessionJump';
import { t } from '../../../shared/i18n';
import { CustomSelect } from './CustomSelect';
import { NewTaskDialog } from './NewTaskDialog';
import { useTaskSource } from './TaskSourceField';
import { availableRuntimeEntries, runtimeSelectionAvailable, useRuntimeAvailability } from '../hooks/useRuntimeAvailability';

interface Props {
  serviceId: string;
  /** 定时任务面板内使用时传入：跳转会话后收起工具面板 */
  onNavigateToSession?: () => void;
  /** 任务定义被改动（保存/启停）后回调，宿主面板据此刷新列表 */
  onMutate?: () => void;
  /** 挂载后直接进入编辑态（新建任务场景，默认只读需再点编辑太绕） */
  autoEdit?: boolean;
  /** autoEdit 消费后回调（宿主清标记，避免切回同任务再次进编辑） */
  onAutoEditConsumed?: () => void;
}

const hourOptions = Array.from({ length: 24 }, (_, value) => ({ value: String(value).padStart(2, '0'), label: String(value).padStart(2, '0') }));
const minuteOptions = Array.from({ length: 60 }, (_, value) => ({ value: String(value).padStart(2, '0'), label: String(value).padStart(2, '0') }));

/** 星期标签（key=中文原文，取值函数现场翻译，对齐 planStatusLabel 先例） */
function weekdayLabel(day: number): string {
  switch (day) {
    case 0:
      return t('周日');
    case 1:
      return t('周一');
    case 2:
      return t('周二');
    case 3:
      return t('周三');
    case 4:
      return t('周四');
    case 5:
      return t('周五');
    case 6:
      return t('周六');
    default:
      return String(day);
  }
}

/** 运行状态文案（比较值不翻，显示值现场翻译） */
function runStatusLabel(status: TaskRun['status']): string {
  switch (status) {
    case 'running':
      return t('运行中');
    case 'ok':
      return t('成功');
    case 'error':
      return t('失败');
    case 'missed':
      return t('错过');
    case 'skipped':
      return t('已跳过');
    default:
      return status;
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return t('{{n}} 秒', { n: Math.round(ms / 1000) });
  if (ms < 3_600_000)
    return t('{{m}} 分 {{s}} 秒', {
      m: Math.floor(ms / 60_000),
      s: Math.round((ms % 60_000) / 1000)
    });
  return t('{{h}} 小时 {{m}} 分', {
    h: Math.floor(ms / 3_600_000),
    m: Math.floor((ms % 3_600_000) / 60_000)
  });
}

/** 中栏定时服务视图：元数据 + 计划任务状态 + 日志，不伪装成交互 agent。 */
export function ServiceView(props: Props): React.JSX.Element {
  return <ServiceViewContent key={props.serviceId} {...props} />;
}

function ServiceViewContent({
  serviceId,
  onNavigateToSession,
  onMutate,
  autoEdit,
  onAutoEditConsumed
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { runtimes } = useRuntimesStore();
  const { requestAgentPanel } = useUiStore();
  const { workspaces } = useWorkspaceStore();
  const [def, setDef] = useState<PromptTask | null>(null);
  const availability = useRuntimeAvailability(!!def);
  const registeredRef = useRef(runtimes);
  registeredRef.current = runtimes;
  const [runs, setRuns] = useState<TaskRun[]>([]);
  /** 编辑门（用户验收口径）：默认只读；点「编辑」才可改，改前自动停用；
   * 保存可「保存并启用」或保持停用；可丢弃改动（含恢复原启用态） */
  const [editing, setEditing] = useState(false);
  const [taskEditorOpen, setTaskEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const refreshGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const source = useTaskSource(editing, workspaces.find(ws => ws.id === def?.workspaceId),
    def?.sourceRoot ?? { rootId: '', path: '' });
  const editingRef = useRef(false);
  const wasEnabledRef = useRef(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntime] = useState<PromptTask['runtime']>('');
  const runtimeOptions = useMemo(() => availableRuntimeEntries(availability.snapshot, runtimes), [availability.snapshot, runtimes]);
  const [scheduleKind, setScheduleKind] = useState<TaskSchedule['kind']>('daily');
  const [time, setTime] = useState('09:00');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [missedPolicy, setMissedPolicy] = useState<MissedPolicy>('skip');
  const [guiMode, setGuiMode] = useState('');
  const [configurePermissions, setConfigurePermissions] = useState(false);
  const [cliLaunchOptions, setCliLaunchOptions] = useState<import('../../../shared/cliLaunchOptions').CliLaunchOptions>();
  const [nativeConfig, setNativeConfig] = useState<import('../../../shared/nativeSessionConfig').NativeConfigIntent>();
  const [piMode, setPiMode] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [thinking, setThinking] = useState('');
  const [modelParameters, setModelParameters] = useState<import('../../../shared/modelParameters').ModelParameterValues | undefined>();
  const [error, setError] = useState('');
  const selectedReady = availability.ready && runtimeSelectionAvailable(availability.snapshot, runtimes, runtime, piMode);
  const definitionReady = availability.ready && runtimeSelectionAvailable(availability.snapshot, runtimes, def?.runtime ?? '', def?.piModeId);
  const preservingWorker = runtime === def?.runtime && piMode === (def?.piModeId ?? '');
  const verifyWorker = async (id: string, acpAgent?: string): Promise<boolean> => {
    const checked = await availability.refresh(true);
    if (!mounted.current) return false;
    if (!runtimeSelectionAvailable(checked, registeredRef.current, id, acpAgent)) throw new Error(t('所选 Worker 已不可用，请重新选择'));
    return true;
  };

  /** 把任务定义灌进编辑字段（进入只读态 / 丢弃改动时用） */
  const applyDefToFields = useCallback((d: PromptTask): void => {
    setName(d.name);
    setPrompt(d.prompt);
    setRuntime(d.runtime);
    setGuiMode(d.runtime === 'pi' ? d.guiMode || '' : '');
    setConfigurePermissions(d.configurePermissions === true);
    setCliLaunchOptions(d.cliLaunchOptions);
    setNativeConfig(d.nativeConfig);
    setPiMode(d.piModeId || '');
    setThinking(d.thinking || '');
    setModelParameters(d.modelParameters);
    setModelKey(d.providerId && d.modelId ? `${d.providerId}|${d.modelId}` : '');
    setScheduleKind(d.schedule.kind);
    if (d.schedule.kind === 'interval') setIntervalMinutes(d.schedule.intervalMinutes);
    else if (d.schedule.kind !== 'once') {
      setTime(d.schedule.time);
      if (d.schedule.kind === 'weekly') {
        setWeekdays(d.schedule.weekdays.length ? [...d.schedule.weekdays] : [1]);
      }
    }
    setMissedPolicy(d.missedPolicy === 'catch-up' || d.missedPolicy === 'confirm' ? d.missedPolicy : 'skip');
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      setError('');
      const [d, runsResult] = await Promise.all([
        window.api.services.get(serviceId) as Promise<PromptTask>,
        window.api.services.runs(serviceId)
      ]);
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setDef(d);
      setRuns(runsResult.runs);
      // 编辑中：轮询只更新元数据与历史，不覆盖正在编辑的字段（防「改着改着被刷新」）
      if (!editingRef.current) applyDefToFields(d);
    } catch (e) {
      if (mounted.current && generation === refreshGeneration.current) setError((e as Error).message);
    }
  }, [serviceId, applyDefToFields]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const runNow = async (): Promise<void> => {
    if (busy || !def || !definitionReady) return;
    setBusy(true);
    try {
      if (!await verifyWorker(def.runtime, def.piModeId)) return;
      await window.api.services.runNow(serviceId);
      setTimeout(() => void refresh(), 3000);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const toggle = async (): Promise<void> => {
    if (!def || busy || !def.enabled && !definitionReady) return;
    setBusy(true);
    try {
      if (def.enabled) await window.api.services.disable(serviceId);
      else {
        if (!await verifyWorker(def.runtime, def.piModeId)) return;
        await window.api.services.enable(serviceId);
      }
      await refresh();
      onMutate?.();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /** 进入编辑：启用中的任务先自动停用（改配置不允许边跑边改） */
  const startEdit = async (openTask = false): Promise<void> => {
    if (!def || busy) return;
    setBusy(true);
    try {
      const current = (await window.api.services.get(serviceId)) as PromptTask;
      if (!mounted.current) return;
      wasEnabledRef.current = current.enabled;
      if (current.enabled) {
        await window.api.services.disable(serviceId);
        await refresh();
      }
      const latest = (await window.api.services.get(serviceId)) as PromptTask;
      if (!mounted.current) return;
      refreshGeneration.current++;
      setDef(latest);
      applyDefToFields(latest);
      editingRef.current = true;
      setEditing(true);
      if (openTask) setTaskEditorOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const finishEditing = (): void => {
    setTaskEditorOpen(false);
    editingRef.current = false;
    setEditing(false);
  };

  // 新建任务：定义加载完直接进编辑（只读门默认关着，新建后还要再点一次编辑太绕）
  const autoEditRef = useRef(false);
  useEffect(() => {
    if (!autoEdit || autoEditRef.current || !def) return;
    autoEditRef.current = true;
    onAutoEditConsumed?.();
    void startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit, def]);

  /** 丢弃改动：字段回滚到当前定义；编辑前是启用态则恢复启用 */
  const cancelEdit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const d = (await window.api.services.get(serviceId)) as PromptTask;
      if (!mounted.current) return;
      refreshGeneration.current++;
      setDef(d);
      applyDefToFields(d);
      if (wasEnabledRef.current && !d.enabled) {
        const checked = await availability.refresh(true);
        if (!mounted.current) return;
        if (runtimeSelectionAvailable(checked, registeredRef.current, d.runtime, d.piModeId)) {
          await window.api.services.enable(serviceId);
          await refresh();
        } else setError(t('所选 Worker 已不可用，请重新选择'));
      }
      finishEditing();
      onMutate?.();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /** 保存（保持停用）/ 保存并启用 */
  const saveWithOptions = async (enable: boolean): Promise<void> => {
    if (busy || !def || !source.target || (enable || !preservingWorker) && !selectedReady) return;
    if (configurePermissions && runtime === 'pi' && guiMode && !supportsGuiPermissionMode(runtime, guiMode as GuiWorkerMode)) {
      setError(t('当前引擎不支持此权限档，请重新选择'));
      return;
    }
    if (scheduleKind === 'weekly' && !weekdays.length) {
      setError(t('请至少选择一个星期'));
      return;
    }
    try {
      setBusy(true);
      if ((enable || !preservingWorker) && !await verifyWorker(runtime, piMode)) return;
      const schedule: TaskSchedule =
        scheduleKind === 'once'
          ? // once 无 UI 编辑面：保存时原样保留，禁止被下拉默认改写成 daily
            (def?.schedule as TaskSchedule) ?? { kind: 'once', at: new Date().toISOString() }
          : scheduleKind === 'interval'
            ? { kind: 'interval', intervalMinutes }
            : scheduleKind === 'weekly'
              ? { kind: 'weekly', time, weekdays: [...weekdays].sort((a, b) => a - b) }
              : { kind: 'daily', time };
      const model = parseModelKey(modelKey);
      const providerId = model?.providerId ?? '';
      const modelId = model?.modelId ?? '';
      const d = (await window.api.services.update(serviceId, {
        ...source.target,
        name,
        prompt,
        runtime,
        configurePermissions,
        ...(JSON.stringify(cliLaunchOptions ?? null) !== JSON.stringify(def.cliLaunchOptions ?? null)
          ? { cliLaunchOptions: cliLaunchOptions ?? null } : {}),
        providerId,
        modelId,
        ...(guiMode !== (def?.guiMode ?? '') ? { guiMode: (guiMode || null) as GuiWorkerMode | null } : {}),
        ...(JSON.stringify(nativeConfig ?? null) !== JSON.stringify(def.nativeConfig ?? null)
          ? { nativeConfig: nativeConfig ?? null } : {}),
        ...(piMode !== (def?.piModeId ?? '') ? { piModeId: piMode || null } : {}),
        ...(thinking !== (def?.thinking ?? '') ? { thinking: (thinking || null) as GuiThinkingLevel | null } : {}),
        ...(JSON.stringify(modelParameters ?? null) !== JSON.stringify(def?.modelParameters ?? null)
          ? { modelParameters: modelParameters ?? null } : {}),
        schedule,
        missedPolicy
      })) as PromptTask;
      if (!mounted.current) return;
      refreshGeneration.current++;
      setDef(d);
      applyDefToFields(d);
      if (enable && !d.enabled) {
        await window.api.services.enable(serviceId);
        await refresh();
      }
      finishEditing();
      onMutate?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const jumpToRun = (run: TaskRun): void => {
    if (!def) return;
    if (run.sessionId) {
      void jumpToSession({ sessionId: run.sessionId });
      onNavigateToSession?.();
      return;
    }
    if (run.piSessionPath) {
      // 无头运行：装载对应 Pi 会话进调度面板并聚焦
      void window.api.chat
        .sessionOpen(def.workspaceId, run.piSessionPath)
        .then((res) => {
          if (res.ok) {
            requestAgentPanel(def.workspaceId);
            onNavigateToSession?.();
          } else {
            setError(res.error ?? t('装载会话失败'));
          }
        })
        .catch((e) => setError((e as Error).message));
    }
  };

  if (!def) {
    return (
      <div className="service-view">
        {error ? <ErrorTip message={error} /> : t('加载中…')}
      </div>
    );
  }

  return (
    <div className="service-view task-editor">
      <div className="task-editor-header">
        <div>
          <div className="task-eyebrow">PROMPT TASK</div>
          <h2>{def.name}</h2>
          <div className="task-subtitle">
            {def.runtime} · {def.workspaceId}
            {editing ? t(' · 编辑中（已自动停用）') : ''}
          </div>
        </div>
        <div className={`task-status-pill ${def.enabled ? 'is-enabled' : 'is-disabled'}`}>
          <span />
          {def.enabled ? t('已启用') : t('已停用')}
        </div>
      </div>
      <div className="service-meta task-settings-grid">
        <div className="full task-definition-summary">
          <span className="task-definition-name">{name}</span>
          <button type="button" className="ui-btn" disabled={busy} onClick={() => editing ? setTaskEditorOpen(true) : void startEdit(true)}>{t('编辑任务')}</button>
        </div>
        {editing && !taskEditorOpen && source.error ? <ErrorTip message={source.error} /> : null}
        <div>
          <label>{t('执行策略')}</label>
          <CustomSelect
            ariaLabel={t('执行策略')}
            disabled={!editing || busy}
            value={scheduleKind}
            onChange={(v) => setScheduleKind(v as TaskSchedule['kind'])}
            options={[
              { value: 'daily', label: t('每天') },
              { value: 'weekly', label: t('每周') },
              { value: 'interval', label: t('固定间隔') },
              ...(scheduleKind === 'once' ? [{ value: 'once', label: t('单次') }] : [])
            ]}
          />
        </div>
        <div>
          <label>
            {scheduleKind === 'interval'
              ? t('间隔分钟')
              : scheduleKind === 'once'
                ? t('执行时刻')
                : t('执行时间')}
          </label>
          {scheduleKind === 'interval' ? (
            <input
              type="number"
              min={1}
              max={43200}
              value={intervalMinutes}
              disabled={!editing || busy}
              onChange={(e) => {
                const n = Number(e.target.value);
                setIntervalMinutes(
                  Number.isFinite(n) && n > 0 ? Math.min(43200, Math.round(n)) : 1
                );
              }}
            />
          ) : scheduleKind === 'once' ? (
            <input
              type="time"
              value={time}
              disabled={!editing || busy}
              onChange={(e) => setTime(e.target.value)}
            />
          ) : (
            <div className="task-time-picker">
              <CustomSelect ariaLabel={t('执行小时')} value={time.slice(0, 2)} disabled={!editing || busy}
                options={hourOptions} onChange={hour => setTime(`${hour}:${time.slice(3, 5)}`)} />
              <span aria-hidden="true">:</span>
              <CustomSelect ariaLabel={t('执行分钟')} value={time.slice(3, 5)} disabled={!editing || busy}
                options={minuteOptions} onChange={minute => setTime(`${time.slice(0, 2)}:${minute}`)} />
            </div>
          )}
        </div>
        {scheduleKind === 'weekly' && (
          <div className="full">
            <label>{t('星期（可多选）')}</label>
            <div className="weekday-toggles">
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <button
                  key={day}
                  type="button"
                  disabled={!editing || busy}
                  className={`weekday-toggle${weekdays.includes(day) ? ' is-on' : ''}`}
                  onClick={() =>
                    setWeekdays((cur) =>
                      cur.includes(day) ? cur.filter((x) => x !== day) : [...cur, day]
                    )
                  }
                >
                  {weekdayLabel(day)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label>{t('错过策略')}</label>
          <CustomSelect
            ariaLabel={t('错过策略')}
            disabled={!editing || busy}
            value={missedPolicy}
            onChange={(v) => setMissedPolicy(v as MissedPolicy)}
            options={[
              { value: 'skip', label: t('跳过（默认）') },
              { value: 'catch-up', label: t('补跑') },
              { value: 'confirm', label: t('待确认') }
            ]}
          />
        </div>
      </div>
      <NewTaskDialog
        open={taskEditorOpen}
        runtimes={runtimes}
        workspace={workspaces.find(ws => ws.id === def.workspaceId)}
        initialTask={prompt}
        initialName={name}
        initialSource={source.root ? { rootId: source.root.id, path: source.root.path } : def.sourceRoot ?? { rootId: '', path: '' }}
        scheduledEdit={{ runtime, advanced: {
          configurePermissions,
          ...(cliLaunchOptions ? { cliLaunchOptions } : {}),
          ...(guiMode ? { guiMode: guiMode as GuiWorkerMode } : {}),
          ...(nativeConfig ? { nativeConfig } : {}),
          ...(piMode ? { piModeId: piMode } : {}),
          ...(parseModelKey(modelKey) ? { model: parseModelKey(modelKey)! } : {}),
          ...(modelParameters ? { modelParameters } : {})
        }, onSave: value => {
          setName(value.name); setPrompt(value.task); setRuntime(value.runtime);
          setGuiMode(value.advanced.guiMode ?? ''); setPiMode(value.advanced.piModeId ?? '');
          setNativeConfig(value.advanced.nativeConfig);
          setConfigurePermissions(value.advanced.configurePermissions === true);
          setCliLaunchOptions(value.advanced.cliLaunchOptions);
          setModelKey(value.advanced.model ? `${value.advanced.model.providerId}|${value.advanced.model.modelId}` : '');
          if (value.runtime !== runtime || (value.advanced.piModeId ?? '') !== piMode ||
              (value.advanced.model ? `${value.advanced.model.providerId}|${value.advanced.model.modelId}` : '') !== modelKey ||
              JSON.stringify(value.advanced.modelParameters ?? null) !== JSON.stringify(modelParameters ?? null)) setThinking('');
          setModelParameters(value.advanced.modelParameters);
          source.select(value.source.rootId);
        } }}
        onClose={() => setTaskEditorOpen(false)}
        onDelegate={async () => { throw new Error('Scheduled task editor cannot start a session'); }}
        onBlankSession={async () => { throw new Error('Scheduled task editor cannot start a session'); }}
      />
      <div className="service-actions task-actions">
        {editing ? (
          <>
            <button disabled={busy || !source.target || !preservingWorker && !selectedReady} onClick={() => void saveWithOptions(false)}>{t('保存（保持停用）')}</button>
            <button disabled={busy || !source.target || !selectedReady} className="primary" onClick={() => void saveWithOptions(true)}>
              {t('保存并启用')}
            </button>
            <button disabled={busy} onClick={() => void cancelEdit()}>{t('丢弃改动')}</button>
          </>
        ) : (
          <>
            <button disabled={busy} className="primary" onClick={() => void startEdit()}>
              {t('编辑')}
            </button>
            <button disabled={busy || !definitionReady} onClick={() => void runNow()}>{t('立即执行')}</button>
            {def.missedPendingConfirm ? (
              <button disabled={busy || !definitionReady} className="primary" onClick={() => void runNow()}>
                {t('确认补跑')}
              </button>
            ) : null}
            <button disabled={busy || !def.enabled && !definitionReady} onClick={() => void toggle()}>{def.enabled ? t('停用') : t('启用')}</button>
            <button disabled={busy} onClick={() => void refresh()}>{t('刷新')}</button>
          </>
        )}
      </div>
      {availability.loading || availability.error || !(editing ? selectedReady : definitionReady) ? <p className="settings-hint" role="status">
        {availability.loading ? t('正在检测 Worker…') : availability.error ? t('Worker 检测失败：{{message}}', { message: availability.error })
          : !runtimeOptions.length ? t('暂无可用 Worker，请在设置中安装或配置') : t('所选 Worker 已不可用，请重新选择')}
        {!availability.loading ? <button type="button" disabled={busy} onClick={() => void availability.refresh(true)}>{t('重新检测 Worker')}</button> : null}
      </p> : null}
      {def.missedPendingConfirm && !editing ? (
        <p className="settings-hint" data-testid="missed-pending-hint">
          {t('上次错过待确认补跑')}
        </p>
      ) : null}
      {error && <ErrorTip message={error} />}
      <div className="service-meta task-run-summary">
        <div>
          <label>{t('下次执行')}</label>
          <code>{def.nextRunAt ? new Date(def.nextRunAt).toLocaleString() : t('未安排')}</code>
        </div>
        <div>
          <label>{t('上次结果')}</label>
          <code className={def.lastResult === 'ok' ? 'ok' : def.lastResult === 'error' ? 'warn' : ''}>
            {def.lastResult === 'ok' ? t('成功') : def.lastResult === 'error' ? t('失败') : t('暂无')}
          </code>
        </div>
        {def.lastError && (
          <div className="full">
            <label>{t('错误')}</label>
            <code>{def.lastError}</code>
          </div>
        )}
      </div>
      <div className="task-run-history">
        <div className="task-run-history-header">{t('运行历史')}</div>
        {runs.length === 0 ? (
          <div className="task-run-empty">{t('还没有运行记录')}</div>
        ) : (
          <div className="task-run-list">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`task-run-row is-${run.status}${run.sessionId || run.piSessionPath ? ' is-jumpable' : ''}`}
                onClick={() => jumpToRun(run)}
                disabled={!run.sessionId && !run.piSessionPath}
                title={run.error ?? run.output ?? ''}
              >
                <span className={`task-run-status is-${run.status}`}>{runStatusLabel(run.status)}</span>
                <span className="task-run-time">{new Date(run.startedAt).toLocaleString()}</span>
                {run.durationMs != null && (
                  <span className="task-run-duration">{formatDuration(run.durationMs)}</span>
                )}
                <span className="task-run-mode">
                  {run.mode === 'missed'
                    ? t('错过')
                    : run.mode === 'skipped'
                      ? t('去抖')
                      : run.mode === 'terminal'
                        ? t('终端')
                        : t('无头')}
                </span>
                {run.error && <ErrorTipDetails message={run.error} />}
                {run.sessionId && <span className="task-run-jump">{t('会话 ↗')}</span>}
                {!run.sessionId && run.piSessionPath && (
                  <span className="task-run-jump">{t('调度 ↗')}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
