import { ErrorTip, ErrorTipDetails } from '../ErrorTip';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalStorageAction, LocalStorageCategory, LocalStorageCleanupResult, LocalStorageItem, LocalStorageReason, LocalStorageSnapshot } from '../../../../shared/localStorage';
import { MAX_LOCAL_STORAGE_SELECTION } from '../../../../shared/localStorage';
import { planLocalStorageCleanup } from '../../../../shared/localStoragePlan';
import { storageMaintenanceCopy } from '../../../../shared/storageMaintenance';
import { AppConfirmDialog } from '../AppConfirmDialog';
import { BrandLoading } from '../BrandLoader';
import { usePresence, usePresenceValue } from '../motion';
import { CustomSelect } from '../CustomSelect';
import { SearchBar } from '../SearchBar';
import { IconBranch, IconChat, IconFile, IconFolder, IconGlobe, IconLayers, IconPalette, IconPhone, IconPuzzle } from '../icons';
import { SettingsResourceItem } from './SettingsResource';
import './local-storage.css';
import './settings-path-field.css';

const categories: LocalStorageCategory[] = ['worktrees', 'sessions', 'attachments', 'handovers', 'extensions', 'apps', 'browser', 'themes', 'other'];
const icons = { worktrees: IconBranch, sessions: IconChat, attachments: IconFile, handovers: IconFile, extensions: IconPuzzle, apps: IconPhone, browser: IconGlobe, themes: IconPalette, other: IconLayers };
type T = ReturnType<typeof useTranslation>['t'];

function categoryName(category: LocalStorageCategory, t: T): string {
  switch (category) {
    case 'worktrees': return t('任务 worktree');
    case 'sessions': return t('会话');
    case 'attachments': return t('聊天附件');
    case 'handovers': return t('交接文档');
    case 'extensions': return t('扩展');
    case 'apps': return t('手机应用');
    case 'browser': return t('浏览器');
    case 'themes': return t('主题');
    case 'other': return t('其他数据');
  }
}
function categoryDescription(category: LocalStorageCategory, t: T): string {
  switch (category) {
    case 'worktrees': return t('任务创建的隔离工作目录。');
    case 'sessions': return t('工作台记录的会话和相关状态。');
    case 'attachments': return t('聊天中发送的文件副本和处理结果。');
    case 'handovers': return t('交接给目标会话的文档及附件。');
    case 'extensions': return t('扩展的共享登记、快照和数据。');
    case 'apps': return t('应用安装记录与共享数据库。');
    case 'browser': return t('内置浏览器的下载、采集和站点数据。');
    case 'themes': return t('保存在本机的自定义主题。');
    case 'other': return t('工作台使用的其他本机数据。');
  }
}
function reasonText(reason: LocalStorageReason | undefined, t: T): string {
  switch (reason) {
    case 'active': return t('正在使用或尚未归档，暂不可清理。');
    case 'subsessions': return t('包含子会话，请先在会话列表处理。');
    case 'worktree': return t('涉及任务 worktree，请先在会话列表处理。');
    case 'unknown': return t('归属无法确认，仅供查看。');
    case 'unknownDownload': return t('下载来源或完成记录未知，不可清理。');
    case 'shared': return t('共享或受其他功能管理，仅供查看。');
    case 'builtin': return t('内置内容不可删除。');
    case 'unavailable': return t('无法完整读取或确认此项目。');
    case 'duplicate': return t('与其他项目的存储范围重叠，仅统计一次。');
    case 'processing': return t('关联清理正在后台进行。');
    case 'restartPending': return t('等待下次启动清理。');
    default: return '';
  }
}
function impact(action: LocalStorageAction | undefined, deleteData: boolean, t: T): string {
  switch (action) {
    case 'worktree': return t('重新核对仓库状态，只清理已合入且没有未提交改动的任务 worktree；不符合条件的内容会保留。');
    case 'session': return t('永久删除会话记录，并在后台清理关联附件和交接文档；外部引擎的记录可能保留。');
    case 'attachment': return t('删除该会话的附件副本及处理结果，历史消息中的附件可能无法再查看；原始文件不受影响。');
    case 'handover': return t('删除交接文档及其附件副本，目标会话将无法再读取这些文件。');
    case 'theme': return t('删除自定义主题；使用它的全局和工作区设置会回退。');
    case 'app': return deleteData
      ? t('卸载此工作区的应用并删除其业务记录，关联提醒会停止；图片文件和共享应用库可能保留，数据库文件不一定缩小。')
      : t('卸载此工作区的应用并保留业务数据，关联提醒会停止；共享应用库保留。');
    case 'download': return t('删除内置浏览器保存的下载文件。');
    case 'artifact': return t('删除单个采集或诊断文件。历史预览及诊断记录可能无法查看。');
    case 'extension': return t('卸载全局扩展，将源码包移入系统回收站。工作区数据单独保存。');
    case 'extensionActivation': return t('停用该工作区中的扩展。');
    case 'browserData': return t('清除所有工作区共用的浏览器站点数据和缓存，各网站登录态、Cookie 和本地存储将失效。打开的页面可能重新写入数据或需要刷新。');
    default: return '';
  }
}
function itemImpact(item: LocalStorageItem, deleteData: boolean, t: T, discardWorktree = false): string {
  if (item.action === 'startupCleanup' && item.maintenanceId) {
    return `${t('下次启动时清理。')} ${t(storageMaintenanceCopy[item.maintenanceId].effect)}`;
  }
  if (item.action === 'session' && item.stopsSession) return t('停止并永久删除会话。关联附件和交接文档在后台清理。');
  if (item.action === 'worktree' && discardWorktree) return t('丢弃未提交改动和未合入的本地分支，删除已核验的任务 worktree。');
  if (item.action === 'worktree' && item.pathStatuses?.some(entry => entry.status === 'missing')) {
    return t('部分或全部目录已不存在；清理时会重新检查 Git 登记和任务分支，通过安全检查后移除失效登记。无法确认或未合入的内容会保留。');
  }
  return impact(item.action, deleteData, t);
}
function itemSource(item: LocalStorageItem, t: T): string {
  return categoryDescription(item.category, t);
}
function itemRisk(item: LocalStorageItem, deleteData: boolean, t: T): string {
  if (item.maintenanceId) {
    const risk = storageMaintenanceCopy[item.maintenanceId].risk;
    if (risk === 'low') return t('较低风险');
    if (risk === 'medium') return t('中等风险');
  }
  if (item.action === 'worktree') return t('较低风险');
  if (item.action === 'theme' || (item.action === 'app' && !deleteData)) return t('中等风险');
  return t('高风险');
}
function itemStatus(item: LocalStorageItem, t: T): string {
  const missing = item.pathStatuses?.some(entry => entry.status === 'missing');
  const allMissing = missing && item.pathStatuses?.every(entry => entry.status === 'missing');
  const inaccessible = item.pathStatuses?.some(entry => entry.status === 'unavailable');
  const reason = item.action ? '' : reasonText(item.reason, t);
  return [missing && !allMissing ? t('部分目录不存在') : '', inaccessible ? t('无法访问') : '', reason].filter(Boolean).join(' · ');
}
function itemName(item: LocalStorageItem, t: T): string {
  if (item.maintenanceId) return t(storageMaintenanceCopy[item.maintenanceId].name);
  if (item.action === 'browserData') return t('浏览器站点数据');
  if (item.action === 'extensionActivation') return t('停用 {{name}}', { name: item.name });
  if (item.reason !== 'shared' || !item.paths.length) return item.name;
  switch (item.name) {
    case 'extension': return item.category === 'extensions' ? t('扩展共享数据') : item.name;
    case 'agent-apps': return item.category === 'apps' ? t('应用数据库') : item.name;
    case 'agent-app-library': return item.category === 'apps' ? t('应用共享库') : item.name;
    case 'agent-app-assets': return item.category === 'apps' ? t('应用图片和资源') : item.name;
    case 'Partitions': return item.category === 'browser' ? t('浏览器站点数据') : item.name;
    case 'browser-captures': return item.category === 'browser' ? t('浏览器采集文件') : item.name;
    default: return item.name;
  }
}
function size(bytes: number | null, partial: boolean, locale: string, t: T): string {
  if (bytes === null) return t('大小未知');
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${partial ? '≥ ' : ''}${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 2 : 0 }).format(n)} ${units[unit]}`;
}
function total(items: LocalStorageItem[]): number { return items.reduce((sum, item) => sum + (item.bytes ?? 0), 0); }
function itemSize(item: LocalStorageItem, locale: string, t: T): string {
  return item.bytes === null && item.sizeKind === 'shared' ? t('共享存储') : size(item.bytes, item.partial, locale, t);
}
function sizeIncomplete(item: LocalStorageItem): boolean {
  const missing = !!item.pathStatuses?.length && item.pathStatuses.every(entry => entry.status === 'missing');
  return item.partial || (item.bytes === null && item.sizeKind !== 'shared' && !missing);
}
function groupSize(items: LocalStorageItem[], locale: string, t: T): string {
  if (!items.length) return size(0, false, locale, t);
  if (items.some(item => item.bytes !== null)) return size(total(items), items.some(sizeIncomplete), locale, t);
  if (items.every(item => !!item.pathStatuses?.length && item.pathStatuses.every(entry => entry.status === 'missing'))) return size(0, false, locale, t);
  return items.every(item => item.sizeKind === 'shared') ? t('共享存储') : t('大小未知');
}

function applyCleanupResults(snapshot: LocalStorageSnapshot, chosen: string[], results: LocalStorageCleanupResult[]): LocalStorageSnapshot {
  const attempted = new Set(chosen);
  const byId = new Map(results.filter(result => attempted.has(result.id)).map(result => [result.id, result]));
  const startedSessions = new Set(snapshot.items.filter(item => item.action === 'session' && byId.get(item.id)?.status === 'started').map(item => item.sessionId));
  const removed = new Set(results.filter(item => item.status === 'completed' || item.status === 'started').map(item => item.id));
  return { ...snapshot, dependencies: snapshot.dependencies?.filter(edge => !removed.has(edge.dependentId) && !removed.has(edge.prerequisiteId)), items: snapshot.items.flatMap(item => {
    const result = byId.get(item.id);
    if (result?.status === 'completed') return [];
    const processing = result?.status === 'started' || result?.status === 'skipped' ||
      (!!item.sessionId && startedSessions.has(item.sessionId) && (item.category === 'attachments' || item.category === 'handovers'));
    if (processing || attempted.has(item.id)) {
      const { action: _action, ...rest } = item;
      const reason = result?.status === 'scheduled' ? 'restartPending' : processing ? 'processing' : 'unavailable';
      return [{ ...rest, reason, ...(result?.error ? { issue: result.error } : {}) }];
    }
    return [item];
  }) };
}

export function LocalStoragePane(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<LocalStorageSnapshot | null>(null);
  const [knownWorkspaces, setKnownWorkspaces] = useState<LocalStorageSnapshot['workspaces']>([]);
  const [category, setCategory] = useState<LocalStorageCategory>('worktrees');
  const [scope, setScope] = useState('all');
  const [focused, setFocused] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [appData, setAppData] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<'all' | 'available' | 'unavailable'>('all');
  const [sort, setSort] = useState<'size-desc' | 'size-asc' | 'name'>('size-desc');
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, boolean>>({});
  const [discard, setDiscard] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [pathErrors, setPathErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Array<LocalStorageCleanupResult & { name: string }>>([]);
  const [showResultDetails, setShowResultDetails] = useState(false);
  const resultPresence = usePresence(showResultDetails);
  const { presence: inspectionPresence, value: inspectionId } = usePresenceValue(focused || null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const detailRef = useRef<HTMLDivElement>(null);
  const inspectionRef = useRef<HTMLElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const restoreReviewFocus = useRef(false);
  const resetDetailScroll = (): void => { if (detailRef.current) detailRef.current.scrollTop = 0; };
  const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setHasScanned(true); setLoading(true); setError(''); setPathErrors({}); setShowResultDetails(false);
    setSnapshot(null); setSelected({}); setAppData({}); setFocused('');
    try {
      const value = await window.api.localStorage.scan();
      if (request === generation.current) {
        setSnapshot(value);
        setKnownWorkspaces(value.workspaces);
        setResults([]);
        setScope(previous => previous.startsWith('workspace:') && !value.workspaces.some(ws => ws.id === previous.slice('workspace:'.length)) ? 'all' : previous);
      }
    } catch (cause) { if (request === generation.current) setError((cause as Error)?.message || String(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useLayoutEffect(() => {
    const trigger = reviewButton.current;
    if (!confirm) {
      if (restoreReviewFocus.current && trigger && !trigger.disabled) trigger.focus({ preventScroll: true });
      restoreReviewFocus.current = false;
      return;
    }
    const root = trigger?.closest<HTMLElement>('#root');
    if (!root || root.inert) return;
    root.inert = true;
    restoreReviewFocus.current = true;
    return () => { root.inert = false; };
  }, [confirm]);
  useLayoutEffect(() => { resetDetailScroll(); }, [category, scope, query, availability, sort]);
  useLayoutEffect(() => {
    const scroller = detailRef.current, inspection = inspectionRef.current;
    if (!focused || !scroller || !inspection) return;
    const reveal = (): void => {
      const view = scroller.getBoundingClientRect(), content = inspection.getBoundingClientRect();
      const bottom = Math.min(content.bottom, content.top + 96);
      if (bottom > view.bottom) scroller.scrollTop += bottom - view.bottom;
    };
    reveal();
    // The accordion starts at zero height, so the scroll range may not exist
    // until the transition grows. Follow only this expansion, then disconnect.
    const accordion = inspection.parentElement?.parentElement;
    if (!accordion || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reveal);
    observer.observe(accordion);
    const finish = (event: TransitionEvent): void => {
      if (event.target === accordion && event.propertyName === 'grid-template-rows') { reveal(); observer.disconnect(); }
    };
    accordion.addEventListener('transitionend', finish);
    return () => { observer.disconnect(); accordion.removeEventListener('transitionend', finish); };
  }, [focused, inspectionPresence.mounted]);
  const scoped = useMemo(() => (snapshot?.items ?? []).filter(item => scope === 'all' || (scope === 'shared' ? !item.workspaceId : item.workspaceId === scope.slice('workspace:'.length))), [snapshot, scope]);
  const group = scoped.filter(item => item.category === category);
  const workspaceNames = new Map((snapshot?.workspaces ?? []).map(ws => [ws.id, ws.name]));
  const search = query.trim().toLowerCase();
  const filtered = group.filter(item => {
    if (availability === 'available' && !item.action) return false;
    if (availability === 'unavailable' && item.action) return false;
    return !search || [item.name, itemName(item, t), item.owner ?? '', workspaceNames.get(item.workspaceId ?? '') ?? '', ...item.paths].some(value => value.toLowerCase().includes(search));
  }).sort((a, b) => {
    if (sort !== 'name') {
      if (a.bytes === null || b.bytes === null) return a.bytes === b.bytes ? 0 : a.bytes === null ? 1 : -1;
      const difference = sort === 'size-desc' ? b.bytes - a.bytes : a.bytes - b.bytes;
      if (difference) return difference;
    }
    return itemName(a, t).localeCompare(itemName(b, t), locale, { numeric: true, sensitivity: 'base' });
  });
  const detail = filtered.find(item => item.id === focused);
  const selection = (snapshot?.items ?? []).filter(item => selected[item.id] && item.action);
  const itemsById = useMemo(() => new Map((snapshot?.items ?? []).map(item => [item.id, item])), [snapshot]);
  const plan = confirm && snapshot ? planLocalStorageCleanup(snapshot.items, snapshot.dependencies ?? [], selection.map(item => item.id)) : null;
  const required = (plan?.required ?? []).map(id => itemsById.get(id)!);
  const suggested = (plan?.recommended ?? []).map(id => itemsById.get(id)!);
  const confirmed = [...selection, ...required, ...suggested.filter(item => suggestions[item.id])];
  const discardable = confirmed.filter(item => item.action === 'worktree' && item.canDiscardWorktree);
  const blocked = !!plan && (plan.cycle || !!plan.blocked.length || confirmed.length > MAX_LOCAL_STORAGE_SELECTION);
  const selectionSummary = selection.length ? selection.some(item => item.bytes !== null)
    ? t('已选择 {{n}} 项 · {{size}}', { n: selection.length, size: size(total(selection), selection.some(item => item.partial || item.bytes === null), locale, t) })
    : t('已选择 {{n}} 项', { n: selection.length }) : t('尚未选择项目');
  const selectable = filtered.filter(item => !!item.action);
  const selectedInView = selectable.filter(item => selected[item.id]).length;
  const allSelected = selectable.length > 0 && selectedInView === selectable.length;
  useLayoutEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedInView > 0 && !allSelected;
  }, [selectedInView, allSelected]);
  const selectFiltered = (checked: boolean): void => {
    if (!checked) setAppData(previous => {
      const next = { ...previous };
      for (const item of selectable) delete next[item.id];
      return next;
    });
    setSelected(previous => {
      const next = { ...previous };
      let remaining = MAX_LOCAL_STORAGE_SELECTION - Object.values(next).filter(Boolean).length;
      for (const item of selectable) {
        if (!checked) delete next[item.id];
        else if (!next[item.id] && remaining > 0) { next[item.id] = true; remaining--; }
      }
      return next;
    });
  };
  const partial = scoped.some(sizeIncomplete);
  const summarySize = size(total(scoped), partial, locale, t);
  const scopeOptions = useMemo(() => [
    { value: 'all', label: t('全部范围') }, { value: 'shared', label: t('跨工作区及未知归属') },
    ...knownWorkspaces.map(ws => ({ value: `workspace:${ws.id}`, label: ws.name }))
  ], [knownWorkspaces, t]);

  const clean = async (): Promise<void> => {
    if (!snapshot || !plan || blocked || !confirmed.length || cleaning) return;
    const chosen = confirmed.map(item => ({
      id: item.id, deleteAppData: appData[item.id] === true,
      ...(discard[item.id] && item.action === 'worktree' ? { discardWorktree: true } : {})
    }));
    const names = new Map(confirmed.map(item => [item.id, itemName(item, t)]));
    let started = false;
    setConfirm(false); setCleaning(true); setError(''); setResults([]); setShowResultDetails(false); setProgress({ done: 0, total: chosen.length });
    try {
      const job = await window.api.localStorage.startCleanup(snapshot.id, chosen); started = true;
      let state = await window.api.localStorage.cleanupStatus(job.id);
      while (!state.done && mounted.current) {
        setProgress({ done: state.results.length, total: state.total });
        await new Promise<void>(resolve => window.setTimeout(resolve, 500));
        if (!mounted.current) return;
        state = await window.api.localStorage.cleanupStatus(job.id);
      }
      if (!mounted.current) return;
      setResults(state.results.map(item => ({ ...item, name: names.get(item.id) ?? item.id })));
      setSnapshot(previous => previous ? applyCleanupResults(previous, chosen.map(item => item.id), state.results) : previous);
      if (state.error && mounted.current) setError(state.error);
    } catch (cause) {
      const message = (cause as Error)?.message || String(cause);
      if (!mounted.current) return;
      setSnapshot(previous => previous ? applyCleanupResults(previous, chosen.map(item => item.id), []) : previous);
      if (mounted.current) setError(started ? t('清理结果暂未确认，操作可能仍在后台进行：{{error}}', { error: message }) : message);
    } finally { if (mounted.current) { setSelected({}); setAppData({}); setFocused(''); setCleaning(false); setProgress(null); } }
  };
  const reviewName = (item: LocalStorageItem) => {
    return [itemName(item, t), workspaceNames.get(item.workspaceId ?? ''), categoryName(item.category, t)].filter(Boolean).join(' · ');
  };
  const describe = (items: LocalStorageItem[]): string => {
    const groups = new Map<string, string[]>();
    for (const item of items) {
      const discarding = discardable.includes(item) && !!discard[item.id];
      const risk = discarding ? t('高风险') : itemRisk(item, !!appData[item.id], t);
      const reversibility = item.action === 'extension' ? t('移入系统回收站') : item.action === 'extensionActivation' ? t('可重新启用') : t('不可恢复');
      const effect = item.action
        ? `${risk} · ${reversibility} · ${itemImpact(item, !!appData[item.id], t, discarding)}`
        : reasonText(item.reason, t);
      const names = groups.get(effect) ?? [];
      names.push(reviewName(item));
      groups.set(effect, names);
    }
    return [...groups].map(([effect, names]) => [effect, ...names].filter(Boolean).join('\n')).join('\n\n');
  };
  const requiredIds = new Set(plan?.required);
  const review = confirm && describe(confirmed.filter(item => !requiredIds.has(item.id)));
  const resultCounts = {
    completed: results.filter(result => result.status === 'completed').length,
    started: results.filter(result => result.status === 'started').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    failed: results.filter(result => result.status === 'failed').length,
    scheduled: results.filter(result => result.status === 'scheduled').length
  };
  const resultSummary = [
    resultCounts.completed && t('已完成 {{n}} 项', { n: resultCounts.completed }),
    resultCounts.started && t('已发起 {{n}} 项', { n: resultCounts.started }),
    resultCounts.skipped && t('由会话处理 {{n}} 项', { n: resultCounts.skipped }),
    resultCounts.scheduled && t('{{n}} 项等待重启清理', { n: resultCounts.scheduled }),
    resultCounts.failed && t('未完成 {{n}} 项', { n: resultCounts.failed })
  ].filter(Boolean).join(' · ');
  const failedResults = results.filter(result => result.status === 'failed');
  const restartPending = snapshot?.items.some(item => item.reason === 'restartPending') ?? false;
  const restart = async (): Promise<void> => {
    setRestarting(true); setError('');
    try { await window.api.app.relaunch(); }
    catch (cause) { setError(t('无法重启工作台。下次手动启动时仍会处理清理队列。{{error}}', { error: (cause as Error)?.message || String(cause) })); }
    finally { setRestarting(false); }
  };
  const revealPath = async (file: string): Promise<void> => {
    try {
      const result = await window.api.shell.revealPath(file);
      setPathErrors(previous => ({ ...previous, [file]: result.ok ? '' : result.error || t('无法打开位置') }));
    } catch (cause) {
      setPathErrors(previous => ({ ...previous, [file]: (cause as Error)?.message || String(cause) }));
    }
  };

  return <div className="local-storage" data-settings-item="localStorage">
    <div className="local-storage-heading">
      <div className="local-storage-heading-copy"><h2>{t('存储项目')}</h2>
        <div className="local-storage-summary" aria-live="polite">{snapshot ? <>{t('已统计文件')} <strong>{summarySize}</strong><span aria-hidden="true"> · </span>{t('{{n}} 项可清理', { n: scoped.filter(item => !!item.action).length })}</> : loading ? t('扫描中…') : hasScanned ? t('等待重新扫描') : t('尚未扫描')}</div>
      </div>
      <div className="local-storage-tools">
        <CustomSelect className="s-select" ariaLabel={t('选择存储范围')} value={scope} options={scopeOptions} disabled={!snapshot || loading || cleaning}
          onChange={value => { setScope(value); setSelected({}); setAppData({}); setFocused(''); setLimit(100); resetDetailScroll(); }} />
        <button type="button" className="btn tiny" disabled={loading || cleaning} onClick={() => void refresh()}>{hasScanned ? t('重新扫描') : t('开始扫描')}</button>
        {restartPending && <button type="button" className="btn tiny" disabled={cleaning || restarting} onClick={() => void restart()}>{t('重启并清理')}</button>}
      </div>
    </div>
    <div className="local-storage-bar" aria-hidden="true">{categories.map((cat, index) => {
      const bytes = total(scoped.filter(item => item.category === cat));
      return bytes > 0 ? <span key={cat} style={{ flexGrow: bytes, opacity: [0.8, 0.48, 0.25][index % 3] }} /> : null;
    })}</div>
    <div className="settings-group-body local-storage-body">
    <ErrorTip message={error ? t('本机存储：{{error}}', { error }) : null} />
    {loading && <div className="local-storage-state"><BrandLoading size={32}>{t('正在扫描本机存储…')}</BrandLoading></div>}
    {!snapshot && !loading && <div className="local-storage-state"><p>{hasScanned ? t('请重新扫描以更新存储信息。') : t('点击“开始扫描”查看本机存储占用。')}</p></div>}
    {snapshot && !loading && <>
      <div className="settings-resource-layout local-storage-layout">
        <nav className="settings-resource-nav" aria-label={t('存储类别')}><div className="settings-resource-items">{categories.map(cat => {
          const Icon = icons[cat], items = scoped.filter(item => item.category === cat);
          return <SettingsResourceItem key={cat} name={categoryName(cat, t)} icon={<Icon size={16} />} selected={category === cat}
            meta={items.length === 1 ? t('1 项 · {{size}}', { size: groupSize(items, locale, t) }) : t('{{n}} 项 · {{size}}', { n: items.length, size: groupSize(items, locale, t) })}
            onClick={() => { setCategory(cat); setFocused(''); setLimit(100); resetDetailScroll(); }} />;
        })}</div></nav>
        <div key={`${scope}:${category}`} className="settings-resource-detail local-storage-detail" ref={detailRef}>
          <div className="local-storage-detail-heading"><div><h3>{categoryName(category, t)}</h3><p>{categoryDescription(category, t)}</p></div><strong>{groupSize(group, locale, t)}</strong></div>
          <div className="local-storage-list-tools">
            <SearchBar aria-label={t('搜索存储项目')} placeholder={t('搜索名称或路径…')} value={query} disabled={cleaning}
              onChange={value => { setQuery(value); setFocused(''); setLimit(100); resetDetailScroll(); }} />
            <CustomSelect className="s-select local-storage-filter" ariaLabel={t('筛选存储项目')} value={availability} disabled={cleaning}
              onChange={value => { setAvailability(value as typeof availability); setFocused(''); setLimit(100); resetDetailScroll(); }} options={[
                { value: 'all', label: t('全部项目') }, { value: 'available', label: t('仅可清理') }, { value: 'unavailable', label: t('仅不可清理') }
              ]} />
            <CustomSelect className="s-select local-storage-sort" ariaLabel={t('排序存储项目')} value={sort} disabled={cleaning}
              onChange={value => { setSort(value as typeof sort); setLimit(100); resetDetailScroll(); }} options={[
                { value: 'size-desc', label: t('占用从大到小') }, { value: 'size-asc', label: t('占用从小到大') }, { value: 'name', label: t('名称升序') }
              ]} />
          </div>
          <div className="local-storage-list-heading"><h4>{t('项目')}</h4>
            <label className="local-storage-select-all"><input ref={selectAllRef} type="checkbox" aria-label={t('全选当前结果中的可清理项目')} checked={allSelected}
              disabled={cleaning || !selectable.length || (!selectedInView && selection.length >= MAX_LOCAL_STORAGE_SELECTION)}
              onChange={event => selectFiltered(selection.length >= MAX_LOCAL_STORAGE_SELECTION && selectedInView > 0 ? false : event.target.checked)} />{t('全选可清理')}</label>
            <span>{search || availability !== 'all' ? t('{{n}} / {{total}} 项', { n: filtered.length, total: group.length }) : filtered.length === 1 ? t('1 项') : t('{{n}} 项', { n: filtered.length })}</span>
          </div>
          {!group.length ? <p className="local-storage-empty">{t('当前范围没有此类数据。')}</p> : !filtered.length && <p className="local-storage-empty">{t('没有匹配的项目。')}</p>}
          <div className="local-storage-items">{filtered.slice(0, limit).map(item => <React.Fragment key={item.id}>
            <div className={`local-storage-row${detail?.id === item.id ? ' is-focused' : ''}`}>
              <input type="checkbox" aria-label={t('选择 {{name}}', { name: itemName(item, t) })} title={!item.action ? reasonText(item.reason, t) : undefined} checked={!!selected[item.id]} disabled={!item.action || loading || cleaning || (!selected[item.id] && selection.length >= MAX_LOCAL_STORAGE_SELECTION)}
                onChange={event => { const checked = event.target.checked; setSelected(previous => ({ ...previous, [item.id]: checked })); if (!checked) setAppData(previous => { const next = { ...previous }; delete next[item.id]; return next; }); }} />
              <button type="button" className="local-storage-row-button" aria-expanded={detail?.id === item.id} onClick={() => setFocused(previous => previous === item.id ? '' : item.id)}>
                <span className="local-storage-row-copy"><span>{itemName(item, t)}</span><small>{snapshot.workspaces.find(ws => ws.id === item.workspaceId)?.name ?? t('跨工作区或未知归属')}{itemStatus(item, t) && <> · {itemStatus(item, t)}</>}</small></span>
                <span className="local-storage-size">{item.pathStatuses?.length && item.pathStatuses.every(entry => entry.status === 'missing') ? t('目录不存在') : itemSize(item, locale, t)}</span>
              </button>
            </div>
            {inspectionPresence.mounted && inspectionId === item.id && <div className={`acc${focused === item.id && inspectionPresence.stage === 'in' ? ' is-open' : ''}`} {...inspectionPresence.spread} aria-hidden={focused !== item.id || undefined} ref={node => { if (node) node.inert = focused !== item.id; }}><div className="acc-body"><section className="local-storage-inspection" ref={inspectionRef}><h4>{t('项目详情')}</h4>
              <p>{t('来源：{{source}}', { source: itemSource(item, t) })}</p>
              <p>{t('最近观测更新：{{time}}', { time: item.modifiedAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(item.modifiedAt) : t('未知') })}</p>
              {item.paths.map(file => <React.Fragment key={file}>
                <div className="s-path-control local-storage-path"><input className="ui-input s-input mono" aria-label={`${itemName(item, t)} · ${t('目录路径')}`} title={file} value={file} readOnly/>{item.pathStatuses?.find(entry => entry.path === file)?.status === 'missing' ? <span className="local-storage-path-status">{t('目录不存在')}</span> : item.pathStatuses?.find(entry => entry.path === file)?.status === 'unavailable' ? <span className="local-storage-path-status">{t('无法访问')}</span> : <button type="button" className="btn tiny" onClick={() => void revealPath(file)}><IconFolder size={14}/>{t('打开位置')}</button>}</div>
                {pathErrors[file] && <ErrorTip message={t('无法打开位置：{{error}}', { error: pathErrors[file] })} />}
              </React.Fragment>)}
              <p>{item.action ? `${itemRisk(item, !!appData[item.id], t)} · ${t('不可恢复')} · ${itemImpact(item, !!appData[item.id], t)}` : reasonText(item.reason, t)}</p>
              {item.sizeKind === 'shared' && <p>{t('此项目使用共享存储，容量计入对应的共享文件。')}</p>}
              {item.partial && <p>{t('此项目的大小未完整统计。')}</p>}
              {item.issue && <p>{item.maintenanceId ? item.issue : t('读取失败：{{error}}', { error: item.issue })}</p>}
              {item.action === 'app' && <label className="local-storage-app-option"><input type="checkbox" disabled={cleaning} checked={!!appData[item.id]} onChange={event => setAppData(previous => ({ ...previous, [item.id]: event.target.checked }))} />{t('卸载时同时删除此工作区的应用数据')}</label>}
            </section></div></div>}
          </React.Fragment>)}</div>
          {limit < filtered.length && <button className="btn tiny" type="button" onClick={() => setLimit(n => n + 100)}>{t('显示更多')}</button>}
        </div>
      </div>
      {selection.length >= MAX_LOCAL_STORAGE_SELECTION && <p className="local-storage-note">{t('每次最多处理 {{n}} 项。', { n: MAX_LOCAL_STORAGE_SELECTION })}</p>}
      {progress && <p className="local-storage-note" role="status">{t('正在处理 {{done}} / {{total}} 项…', progress)}</p>}
      <div className="local-storage-actions"><span className={results.length && !selection.length ? 'local-storage-results' : undefined} role="status" title={selection.length ? selectionSummary : resultSummary}>{selection.length ? <>{t('已选择 {{n}} 项', { n: selection.length })}{selection.some(item => item.bytes !== null) && <span className="local-storage-selected-size"> · {size(total(selection), selection.some(item => item.partial || item.bytes === null), locale, t)}</span>}</> : results.length ? resultSummary : t('尚未选择项目')}</span><div><button className="btn tiny" type="button" disabled={!selection.length || cleaning} onClick={() => { setSelected({}); setAppData({}); }}>{t('清空选择')}</button><button ref={reviewButton} className="btn tiny primary" type="button" disabled={!selection.length || loading || cleaning} onClick={() => { setSuggestions({}); setDiscard({}); setConfirm(true); }}>{t('检查清理影响')}</button></div></div>
    </>}
    {!snapshot && !loading && results.length > 0 && <div className="local-storage-results" role="status">{resultSummary}</div>}
    {failedResults.length > 0 && !loading && <div className="local-storage-result-controls"><button type="button" className="local-storage-result-toggle" aria-expanded={showResultDetails} onClick={() => setShowResultDetails(value => !value)}>{t('查看未完成项目')}</button></div>}
    {resultPresence.mounted && <div className={`acc local-storage-result-details${showResultDetails && resultPresence.stage === 'in' ? ' is-open' : ''}`} {...resultPresence.spread} aria-hidden={!showResultDetails || undefined} ref={node => { if (node) node.inert = !showResultDetails; }}><div className="acc-body"><div className="local-storage-result-list" tabIndex={0}>{failedResults.map(result => <p key={result.id}>{result.name} {result.error && <ErrorTipDetails message={result.error} />}</p>)}</div></div></div>}
    </div>
    <AppConfirmDialog open={confirm} className="local-storage-confirm-mask" title={t('确认清理所选项目？')}
      confirmLabel={t('确认清理')} confirmDisabled={blocked} focusCancel danger onCancel={() => setConfirm(false)} onConfirm={() => void clean()}
      content={<>
        <div className="confirm-detail local-storage-review" tabIndex={0}>
          {required.length > 0 && <section>
            <h4>{t('必须一并清理')}</h4>
            <p>{describe(required)}</p>
          </section>}
          <p>{review}</p>
        </div>
        {(suggested.length > 0 || discardable.length > 0 || blocked) && <div className="local-storage-plan-options">
          {confirm && blocked && <ErrorTip message={confirmed.length > MAX_LOCAL_STORAGE_SELECTION ? t('每次最多处理 {{n}} 项。', { n: MAX_LOCAL_STORAGE_SELECTION })
            : plan?.cycle ? t('清理清单缺少必删项目或存在循环依赖，请重新检查。') : t('有必删项目暂不可清理。请处理该项目后重新扫描。')} />}
          {suggested.length > 0 && <fieldset>
            <legend>{t('建议一并清理')}</legend>
            {suggested.map(item => <label key={item.id}>
              <input type="checkbox" checked={!!suggestions[item.id]} onChange={event => setSuggestions(previous => ({ ...previous, [item.id]: event.target.checked }))} />
              {t('同时清理 {{name}}', { name: reviewName(item) })}
            </label>)}
          </fieldset>}
          {discardable.length > 0 && <fieldset>
            <legend>{t('丢弃 Git 改动')}</legend>
            {discardable.map(item => <label key={item.id}>
              <input type="checkbox" checked={!!discard[item.id]} onChange={event => setDiscard(previous => ({ ...previous, [item.id]: event.target.checked }))} />
              {t('丢弃 {{name}} 的未提交改动及未合入分支', { name: reviewName(item) })}
            </label>)}
          </fieldset>}
        </div>}
      </>} />
  </div>;
}
