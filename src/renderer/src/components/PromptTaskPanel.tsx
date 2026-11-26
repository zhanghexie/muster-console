import { ErrorTip } from './ErrorTip';
import { AppConfirmDialog } from './AppConfirmDialog';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptTask } from '../../../shared/types';
import { t } from '../../../shared/i18n';
import { useRuntimesStore, useWorkspaceStore } from '../store';
import { defaultRootFor } from '../../../shared/workspaceRoots';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { ServiceView } from './ServiceView';
import { IconChevronDown } from './icons';
import { AppLogo } from './AppLogo';
import { usePresenceValue } from './motion';
import { availableRuntimeEntries, useRuntimeAvailability } from '../hooks/useRuntimeAvailability';

/** 星期短标签（key=中文原文，取值函数现场翻译；越界回退数字） */
function weekdayShort(day: number): string {
  switch (day) {
    case 0:
      return t('日');
    case 1:
      return t('一');
    case 2:
      return t('二');
    case 3:
      return t('三');
    case 4:
      return t('四');
    case 5:
      return t('五');
    case 6:
      return t('六');
    default:
      return String(day);
  }
}

function formatScheduleText(task: PromptTask): string {
  const schedule = task.schedule;
  if (schedule.kind === 'interval') return t('每 {{n}} 分钟', { n: schedule.intervalMinutes });
  if (schedule.kind === 'once') return t('单次 {{at}}', { at: schedule.at });
  if (schedule.kind === 'weekly') {
    const days = [...schedule.weekdays].sort((a, b) => a - b).map(weekdayShort).join('/');
    return t('每周({{days}}) {{time}}', { days, time: schedule.time });
  }
  return t('每天 {{time}}', { time: schedule.time });
}

/** 详情区双页签：详情（编辑器/摘要）与运行历史互斥切换 */
type DetailView = 'detail' | 'history';

export function PromptTaskPanel({ onNavigateToSession }: { onNavigateToSession?: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const { runtimes } = useRuntimesStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const workspace = workspaces.find(ws => ws.id === activeWorkspaceId);
  const activeRef = useRef(activeWorkspaceId);
  const createRevision = useRef(0);
  if (activeRef.current !== activeWorkspaceId) createRevision.current++;
  activeRef.current = activeWorkspaceId;
  const mounted = useRef(true);
  const refreshRevision = useRef(0);
  const [creating, setCreating] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshRevision.current++; }; }, []);
  const availability = useRuntimeAvailability(true);
  const registeredRef = useRef(runtimes);
  registeredRef.current = runtimes;
  const enabledRuntimes = useMemo(() => availableRuntimeEntries(availability.snapshot, runtimes), [availability.snapshot, runtimes]);
  const [tasks, setTasks] = useState<PromptTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 刚创建的任务：详情挂载后直接进编辑态（免得新建完还要再点一次「编辑」） */
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<DetailView>('detail');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const generation = ++refreshRevision.current;
    try {
      setError('');
      if (!activeWorkspaceId) { setTasks([]); return; }
      const result = (await window.api.services.list(activeWorkspaceId)) as { services: PromptTask[] };
      if (!mounted.current || activeRef.current !== activeWorkspaceId || refreshRevision.current !== generation) return;
      const scheduled = result.services;
      setTasks(scheduled);
      setSelectedId((current) =>
        current && scheduled.some((task) => task.id === current) ? current : null
      );
    } catch (e) {
      if (mounted.current && activeRef.current === activeWorkspaceId && refreshRevision.current === generation) setError((e as Error).message);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    setCreating(false);
    setTasks([]); setSelectedId(null); setJustCreatedId(null); setConfirmDeleteId(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 切换选中任务时回到「详情」页签；停留在同一任务内切页签不受影响。
  useEffect(() => {
    setDetailView('detail');
  }, [selectedId]);

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId]
  );
  // 详情手风琴：选中驱动 acc 展开；收起期间保留最后任务内容至收拢完
  const { presence: detailPresence, value: shownTask } = usePresenceValue(selectedTask);

  const selectTask = useCallback((id: string) => {
    setConfirmDeleteId(null);
    setSelectedId(id);
  }, []);

  const { onListKeyDown, getItemProps } = useListKeyboardNav({
    items: taskIds,
    selectedId,
    // Keyboard must not toggle-deselect when Arrow stays on same row (boundary).
    onSelect: selectTask
  });

  const create = async (): Promise<void> => {
    if (creating || !availability.ready || !enabledRuntimes.length || !workspace) return;
    const workspaceId = workspace.id;
    const generation = ++createRevision.current;
    setCreating(true);
    try {
      setError('');
      const root = defaultRootFor(workspace);
      const target = { workspaceId, rootId: root.id, rootsRevision: workspace.rootsRevision };
      const cfg = await window.api.config.get();
      if (!mounted.current || activeRef.current !== workspaceId || createRevision.current !== generation) return;
      const checked = await availability.refresh(true);
      if (!mounted.current || activeRef.current !== workspaceId || createRevision.current !== generation) return;
      const available = availableRuntimeEntries(checked, registeredRef.current);
      const runtime =
        available.find((r) => r.id === cfg.defaultRuntime)?.id ?? available[0]?.id;
      if (!runtime) {
        setError(t('暂无可用 Worker，请在设置中安装或配置'));
        return;
      }
      const task = (await window.api.services.create({
        ...target,
        name: t('新定时任务'),
        runtime,
        ...(runtime === 'acp' ? { piModeId: checked!.acpAgents[0].id } : {}),
        prompt: t('请在这里填写要执行的提示词'),
        schedule: { kind: 'daily', time: '09:00' }
      })) as PromptTask;
      if (!mounted.current || activeRef.current !== workspaceId || createRevision.current !== generation) return;
      await refresh();
      if (!mounted.current || activeRef.current !== workspaceId || createRevision.current !== generation) return;
      setSelectedId(task.id);
      setJustCreatedId(task.id);
    } catch (e) {
      if (mounted.current && activeRef.current === workspaceId && createRevision.current === generation) setError((e as Error).message);
    } finally {
      if (mounted.current && createRevision.current === generation) setCreating(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setConfirmDeleteId(null);
    try {
      setError('');
      await window.api.services.delete(id);
      setConfirmDeleteId(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 页签左右键切换（两枚 chip 的最小 tablist 键盘支持）
  const onTabsKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setDetailView('detail');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setDetailView('history');
    }
  }, []);

  // 点击选中任务后把详情区滚进视野（键盘上下浏览不触发，避免列表抖动）
  const detailSectionRef = useRef<HTMLElement | null>(null);
  const revealDetail = useCallback((): void => {
    requestAnimationFrame(() => {
      detailSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, []);

  return (
    <main className="prompt-task-panel">
      <header className="prompt-task-toolbar">
        <div>
          <h1>{t('定时任务')}</h1>
          <span>{t('{{n}} 个任务 · 当前工作区', { n: tasks.length })}</span>
        </div>
        <div className="prompt-task-toolbar-actions">
          <button type="button" disabled={creating || !workspace || !availability.ready || !enabledRuntimes.length} className="ui-btn primary" onClick={() => void create()}>
            {t('＋ 新建任务')}
          </button>
        </div>
      </header>
      {error && <ErrorTip message={error} />}
      {availability.loading || availability.error || !enabledRuntimes.length ? <div className="settings-hint" role="status">
        {availability.loading ? t('正在检测 Worker…') : availability.error ? t('Worker 检测失败：{{message}}', { message: availability.error }) : t('暂无可用 Worker，请在设置中安装或配置')}
        {!availability.loading ? <button type="button" disabled={creating} onClick={() => void availability.refresh(true)}>{t('重新检测 Worker')}</button> : null}
      </div> : null}

      {tasks.length === 0 ? (
        <div className="ui-empty prompt-task-empty">
          <div className="empty-logo" aria-hidden>
            <AppLogo size={56} />
          </div>
          <p className="ui-empty-title">{t('还没有定时任务')}</p>
          <p className="ui-empty-desc">{t('定时用已启用的 Agent Runtime 跑固定提示词。')}</p>
          <div className="ui-empty-actions">
            <button type="button" disabled={creating || !workspace || !availability.ready || !enabledRuntimes.length} className="ui-btn primary" onClick={() => void create()}>
              {t('新建任务')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="prompt-task-list-caption">{t('任务列表')}</div>
          <div
            className="prompt-task-list"
            tabIndex={0}
            onKeyDown={onListKeyDown}
            role="listbox"
            aria-label={t('定时任务列表')}
          >
            {tasks.map((task) => (
              <button
                type="button"
                key={task.id}
                {...getItemProps(task.id)}
                role="option"
                aria-selected={selectedId === task.id}
                className={`prompt-task-row${selectedId === task.id ? ' is-selected' : ''}`}
                onClick={() => {
                  const wasSelected = selectedId === task.id;
                  setConfirmDeleteId(null);
                  setSelectedId(wasSelected ? null : task.id);
                  if (!wasSelected) revealDetail();
                }}
              >
                <span className="prompt-task-row-name">{task.name}</span>
                <span className={`task-status-pill${task.enabled ? ' is-enabled' : ''}`}>
                  <span />
                  {task.enabled ? t('已启用') : t('已停用')}
                </span>
                <span className="prompt-task-row-schedule">{formatScheduleText(task)}</span>
                <span className="prompt-task-row-mode">
                  {runtimes.find((r) => r.id === task.runtime)?.label ?? task.runtime}
                </span>
                <span className="prompt-task-row-next">
                  {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : t('未安排')}
                </span>
                <span className="prompt-task-chevron" aria-hidden="true">
                  <IconChevronDown
                    size={13}
                    className={selectedId === task.id ? 'is-open' : undefined}
                  />
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {tasks.length > 0 && detailPresence.mounted && (
        <section className="prompt-task-detail-section" aria-label={t('任务详情')} ref={detailSectionRef}>
          <div className="prompt-task-section-caption">{t('任务详情')}</div>
          {/* 手风琴展开（grid-rows 过渡）+ presence 延迟卸载：收起时高度平滑收拢、
              内容保留至收拢完；收拢中重选则从当前高度回弹 */}
          <div className={`acc${detailPresence.mounted ? ' is-open' : ''}`}>
            <div className="acc-body">
              {shownTask ? (
                <div className="prompt-task-detail" data-view={detailView}>
              <div className="prompt-task-detail-head">
                <span className={`task-status-pill${shownTask.enabled ? ' is-enabled' : ''}`}>
                  <span />
                  {shownTask.enabled ? t('已启用') : t('已停用')}
                </span>
                <div
                  className="prompt-task-tabs"
                  role="tablist"
                  aria-label={t('任务视图切换')}
                  onKeyDown={onTabsKeyDown}
                >
                  <button
                    type="button"
                    id="prompt-task-tab-detail"
                    role="tab"
                    aria-selected={detailView === 'detail'}
                    aria-controls="prompt-task-detail-panel"
                    className={`prompt-task-tab${detailView === 'detail' ? ' is-active' : ''}`}
                    onClick={() => setDetailView('detail')}
                  >
                    {t('详情')}
                  </button>
                  <button
                    type="button"
                    id="prompt-task-tab-history"
                    role="tab"
                    aria-selected={detailView === 'history'}
                    aria-controls="prompt-task-detail-panel"
                    className={`prompt-task-tab${detailView === 'history' ? ' is-active' : ''}`}
                    onClick={() => setDetailView('history')}
                  >
                    {t('运行历史')}
                  </button>
                </div>
              </div>
              <div
                id="prompt-task-detail-panel"
                className="prompt-task-detail-body"
                role="tabpanel"
              >
                <ServiceView
                  key={shownTask.id}
                  serviceId={shownTask.id}
                  onNavigateToSession={onNavigateToSession}
                  onMutate={() => void refresh()}
                  autoEdit={justCreatedId === shownTask.id}
                  onAutoEditConsumed={() => setJustCreatedId(null)}
                />
              </div>
              <button type="button" className="prompt-task-delete ui-btn tiny danger" onClick={() => setConfirmDeleteId(shownTask.id)}>{t('删除任务')}</button>
              <AppConfirmDialog open={confirmDeleteId === shownTask.id} title={t('确认删除该任务？')}
                detail={shownTask.name} confirmLabel={t('确认删除')} danger onCancel={() => setConfirmDeleteId(null)}
                onConfirm={() => { if (confirmDeleteId === shownTask.id) void remove(shownTask.id); }}/>

            </div>
              ) : (
                <div className="prompt-task-detail-empty">
                  <span aria-hidden="true">[ · ]</span>
                  <p>{t('在上方选择一个任务，查看详情与运行历史')}</p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
