import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProcessMonitorNode, ProcessMonitorProfileResult, ProcessMonitorSnapshot } from '../../../shared/processMonitor';
import { IconChevronDown, IconRefresh } from '../components/icons';
import { MOTION, usePresence } from '../components/motion';
import { useChordLabel, useOverlayDismiss } from '../keybindings/KeybindingHost';

interface Props { open: boolean; onClose: () => void; }

function flatten(nodes: ProcessMonitorNode[], depth = 0): Array<ProcessMonitorNode & { depth: number }> {
  return nodes.flatMap(node => [{ ...node, depth }, ...flatten(node.children, depth + 1)]);
}

function ProcessRow({ node, depth, selected, onSelect }: { node: ProcessMonitorNode & { depth: number }; depth: number; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const memory = node.workingSetKb >= 1024 ? `${(node.workingSetKb / 1024).toFixed(0)} MB` : `${node.workingSetKb} KB`;
  const label = node.businessLabel || node.title || node.name;
  const workspace = node.workspaceName || node.workspaceId || '—';
  const session = node.sessionName || node.sessionId || '—';
  return <button type="button" className={`process-monitor-row${selected ? ' is-selected' : ''}`} onClick={onSelect}>
    <span className="process-monitor-tree-label" style={{ paddingLeft: `${depth * 18}px` }}>
      {depth > 0 ? <span className="process-monitor-tree-branch" aria-hidden>↳</span> : null}
      {node.children.length ? <IconChevronDown size={12} /> : <span className="process-monitor-leaf" aria-hidden />}
      <span className="process-monitor-node-icon">{node.type === 'Browser' ? 'M' : node.type === 'GPU' ? 'G' : node.type === 'Tab' ? 'T' : '·'}</span>
      <span className="process-monitor-node-copy"><strong>{label}</strong><span className="process-monitor-row-meta">{node.role || node.type}</span></span>
    </span>
    <span className="process-monitor-cell process-monitor-mono">{node.pid}</span>
    <span className="process-monitor-cell process-monitor-muted">{workspace}</span>
    <span className="process-monitor-cell process-monitor-muted">{session}</span>
    <span className="process-monitor-cell">{node.cpuPercent.toFixed(1)}%</span>
    <span className="process-monitor-cell">{memory}</span>
    <span className="process-monitor-cell process-monitor-muted">{node.serviceName || '—'}</span>
  </button>;
}

function CpuBars({ snapshot, pid }: { snapshot: ProcessMonitorSnapshot | null; pid?: number }): React.JSX.Element {
  const { t } = useTranslation();
  const values = (snapshot?.cpuHistory ?? []).map(item => item.values.find(value => value.pid === pid)?.cpuPercent ?? 0).slice(-24);
  const max = Math.max(1, ...values);
  return <div className="process-monitor-chart" aria-label={t('CPU 历史条形图')}>
    <div className="process-monitor-chart-bars">{values.length ? values.map((value, index) => <span key={`${index}-${value}`} title={`${value.toFixed(1)}%`} style={{ height: `${Math.max(4, Math.min(100, value / max * 100))}%` }} />) : <span className="process-monitor-chart-empty" />}</div>
    <div className="process-monitor-chart-caption"><span>{t('最近采样')}</span><strong>{values.length ? `${values.at(-1)!.toFixed(1)}%` : '—'}</strong></div>
  </div>;
}

export function ProcessMonitorPanel({ open, onClose }: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const chord = useChordLabel('processMonitor.toggle');
  const presence = usePresence(open, MOTION.exitMs);
  const [snapshot, setSnapshot] = useState<ProcessMonitorSnapshot | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [profileBusy, setProfileBusy] = useState<'cpu' | 'heap' | null>(null);
  const [profileResult, setProfileResult] = useState<ProcessMonitorProfileResult | null>(null);
  const [cpuCapture, setCpuCapture] = useState<{ pid: number; deadline: number } | null>(null);
  const [cpuRemainingMs, setCpuRemainingMs] = useState(0);
  const [artifactStatus, setArtifactStatus] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try { setSnapshot(await window.api.processMonitor.snapshot()); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);
  useOverlayDismiss(open, onClose);

  const rows = useMemo(() => flatten(snapshot?.nodes ?? []), [snapshot]);
  const selected = rows.find(row => row.pid === selectedPid) ?? rows[0];
  const runHeapSnapshot = useCallback(async (): Promise<void> => {
    if (!selected) return;
    setProfileBusy('heap');
    setProfileResult(null);
    setArtifactStatus('');
    try {
      setProfileResult(await window.api.processMonitor.heapSnapshot(selected.pid));
    } finally { setProfileBusy(null); }
  }, [selected]);
  const toggleCpuCapture = useCallback(async (): Promise<void> => {
    if (!selected) return;
    setProfileBusy('cpu');
    setProfileResult(null);
    setArtifactStatus('');
    try {
      if (cpuCapture?.pid === selected.pid) {
        const result = await window.api.processMonitor.cpuStop(selected.pid);
        setProfileResult(result);
        setCpuCapture(null);
        setCpuRemainingMs(0);
      } else {
        const result = await window.api.processMonitor.cpuStart(selected.pid);
        if (result.ok) {
          setCpuCapture({ pid: result.pid, deadline: result.startedAt + result.maxDurationMs });
          setCpuRemainingMs(result.maxDurationMs);
        } else setProfileResult(result);
      }
    } finally { setProfileBusy(null); }
  }, [cpuCapture, selected]);
  useEffect(() => {
    if (!cpuCapture) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, cpuCapture.deadline - Date.now());
      setCpuRemainingMs(remaining);
      if (!remaining) {
        window.clearInterval(timer);
        void window.api.processMonitor.cpuStop(cpuCapture.pid).then(result => {
          setProfileResult(result);
          setCpuCapture(null);
        });
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [cpuCapture]);
  const openArtifact = useCallback(async (): Promise<void> => {
    if (!profileResult?.ok) return;
    const result = await window.api.processMonitor.openArtifact(profileResult.path);
    setArtifactStatus(result.ok ? t('已打开文件位置') : result.error);
  }, [profileResult, t]);
  if (!presence.mounted) return null;
  const selectedMemory = selected ? (selected.workingSetKb / 1024).toFixed(1) : '0';
  const canProfile = !!selected && ['Browser', 'Tab', 'Renderer', 'Utility'].includes(selected.type);
  const cpuCaptureSelected = !!selected && cpuCapture?.pid === selected.pid;
  const formatRemaining = (ms: number): string => `${String(Math.ceil(ms / 60_000)).padStart(2, '0')}:${String(Math.ceil(ms / 1000) % 60).padStart(2, '0')}`;

  return <div
    className="process-monitor-overlay mp-fly-overlay"
    {...presence.spread}
    aria-hidden={!open || undefined}
    {...(!open ? { inert: '' } : {})}
    onPointerDown={(event) => {
      if (event.button === 0 && event.target === event.currentTarget) onClose();
    }}
  >
    <div className="mp-scrim-layer backdrop-blur-overlay mp-scrim" {...presence.spread} aria-hidden />
    <section className="process-monitor-sheet mp-panel mp-panel-fly" data-mp-stage={presence.stage} role="dialog" aria-modal="false" aria-label={t('运行监视器')}>
      <header className="process-monitor-toolbar">
        <div className="process-monitor-title"><span className="process-monitor-mark">◇</span><div><h2>{t('运行监视器')}</h2><p>{t('按任务查看 Electron 与受管子进程的实时关系')}</p></div></div>
        <div className="process-monitor-toolbar-meta"><span className="process-monitor-live-dot" />{loading ? t('采样中…') : t('轻量采样')}<span className="process-monitor-keyhint">{chord}</span></div>
        <button type="button" className="process-monitor-icon-btn" title={t('刷新')} aria-label={t('刷新')} onClick={() => void refresh()}><IconRefresh size={15} /></button>
      </header>
      <div className="process-monitor-summary">
        <div><span>{t('进程')}</span><strong>{snapshot?.processCount ?? '—'}</strong></div>
        <div><span>{t('轻量记录')}</span><strong>{snapshot ? `${snapshot.historySize}/${snapshot.historyCapacity}` : '—'}</strong></div>
        <div><span>{t('根进程')}</span><strong className="process-monitor-mono">{snapshot?.rootPid ?? '—'}</strong></div>
        <div className="process-monitor-summary-note">{t('自动采样轻量运行；重型采集请在详情中手动触发')}</div>
      </div>
      <div className="process-monitor-body">
        <div className="process-monitor-list-wrap">
          <div className="process-monitor-list-head"><span>{t('父子进程关系')}</span><span>{t('PID')}</span><span>{t('工作区')}</span><span>{t('会话')}</span><span>{t('CPU')}</span><span>{t('内存')}</span><span>{t('服务')}</span></div>
          <div className="process-monitor-list" role="list">{rows.length ? rows.map(row => <ProcessRow key={row.key} node={row} depth={row.depth} selected={selected?.pid === row.pid} onSelect={() => setSelectedPid(row.pid)} />) : <div className="process-monitor-empty">{t('暂时没有可观测进程')}</div>}</div>
        </div>
        <aside className="process-monitor-detail">
          <div className="process-monitor-detail-kicker">{t('当前进程')}</div>
          {selected ? <>
            <div className="process-monitor-detail-title"><span className="process-monitor-detail-icon">{selected.type === 'Browser' ? 'M' : '·'}</span><div><h3>{selected.businessLabel || selected.title || selected.name}</h3><p>{selected.role || selected.type} · PID {selected.pid}</p></div></div>
            <div className="process-monitor-detail-grid"><div><span>{t('CPU')}</span><strong>{selected.cpuPercent.toFixed(1)}%</strong></div><div><span>{t('工作集')}</span><strong>{selectedMemory} MB</strong></div></div>
            <CpuBars snapshot={snapshot} pid={selected.pid} />
            <div className="process-monitor-detail-actions">
              <button type="button" onClick={() => void toggleCpuCapture()} disabled={!canProfile || profileBusy === 'heap' || (!!cpuCapture && !cpuCaptureSelected)}>{cpuCaptureSelected ? t('停止采集（{{time}}）', { time: formatRemaining(cpuRemainingMs) }) : t('开始 CPU 采集')}</button>
              <button type="button" onClick={() => void runHeapSnapshot()} disabled={!canProfile || profileBusy !== null}>{profileBusy === 'heap' ? t('生成堆快照…') : t('生成堆快照')}</button>
            </div>
            {profileResult ? <div className={`process-monitor-profile-result${profileResult.ok ? '' : ' is-error'}`}><span>{profileResult.ok ? t('{{label}}：{{path}}', { label: profileResult.kind === 'cpu-profile' ? 'CPU profile' : t('堆快照'), path: profileResult.path }) : profileResult.error}</span>{profileResult.ok ? <button type="button" onClick={() => void openArtifact()}>{t('在资源管理器中打开')}</button> : null}</div> : null}
            {artifactStatus ? <div className="process-monitor-artifact-status">{artifactStatus}</div> : null}
            <div className="process-monitor-detail-section"><span>{t('归属')}</span><p>{selected.parentPid ? t('父进程 PID {{pid}}', { pid: selected.parentPid }) : t('应用根进程')}</p></div>
            <div className="process-monitor-detail-section"><span>{t('业务上下文')}</span><p>{[
              selected.workspaceName || selected.workspaceId ? t('工作区：{{name}}', { name: selected.workspaceName || selected.workspaceId }) : '',
              selected.sessionName || selected.sessionId ? t('会话：{{name}}', { name: selected.sessionName || selected.sessionId }) : '',
              selected.taskLabel || selected.taskId ? t('任务：{{name}}', { name: selected.taskLabel || selected.taskId }) : ''
            ].filter(Boolean).join(' · ') || t('未绑定到具体工作区或会话')}</p></div>
            <div className="process-monitor-detail-section"><span>{t('说明')}</span><p>{selected.url || selected.serviceName || t('由 Electron 统一进程指标提供')}</p></div>
          </> : <div className="process-monitor-empty">{t('选择一个进程查看详情')}</div>}
          <div className="process-monitor-detail-foot">{t('自动采样只保留内存环形记录；CPU 与堆快照仅在手动触发后生成有界诊断文件')}</div>
        </aside>
      </div>
    </section>
  </div>;
}

