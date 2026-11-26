import { app, shell, webContents } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import inspector from 'node:inspector';
import v8 from 'node:v8';
import { promisify } from 'node:util';
import type { OwnedProcessMonitorMeta, ProcessMonitorCpuStartResult, ProcessMonitorNode, ProcessMonitorProfileResult, ProcessMonitorSnapshot } from '../shared/processMonitor';
import { handle } from './ipc/handle';
import { userDataStorage } from './runtimeKernel/storageRootResolver';

const execFileAsync = promisify(execFile);
const HISTORY_CAPACITY = 45;
const history: Array<{ capturedAt: number; pids: number[] }> = [];
const cpuHistory: NonNullable<ProcessMonitorSnapshot['cpuHistory']> = [];
const ownedProcesses = new Map<number, OwnedProcessMonitorMeta>();
const activeCpuCaptures = new Map<number, { startedAt: number; stop(): Promise<ProcessMonitorProfileResult>; timer: NodeJS.Timeout }>();
const SYSTEM_CACHE_MS = 3000;
const SYSTEM_HISTORY_CAPACITY = 45;
type SystemProcessRow = { pid: number; parentPid: number | null; name: string; workingSetKb: number; privateKb?: number; creationTime: number; cpuPercent: number };
let systemCache: { refreshedAt: number; rows: SystemProcessRow[] } | undefined;

export function registerOwnedProcess(pid: number, meta: OwnedProcessMonitorMeta): void {
  if (Number.isSafeInteger(pid) && pid > 0) ownedProcesses.set(pid, meta);
}

export function unregisterOwnedProcess(pid: number): void {
  ownedProcesses.delete(pid);
}

type WindowsProcessRow = { ProcessId?: number; ParentProcessId?: number; Name?: string; WorkingSetSize?: number; PrivatePageCount?: number; CreationDate?: string };
type WindowsCpuRow = { IDProcess?: number; PercentProcessorTime?: number };

async function readSystemProcessRows(): Promise<SystemProcessRow[]> {
  const now = Date.now();
  if (systemCache && now - systemCache.refreshedAt < SYSTEM_CACHE_MS) return systemCache.rows;
  const rows: SystemProcessRow[] = [];
  try {
    if (process.platform === 'win32') {
      const powershell = process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : 'powershell.exe';
      const result = await execFileAsync(powershell, [
        '-NoProfile', '-NonInteractive', '-Command',
        '$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CreationDate; $c=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,PercentProcessorTime; [pscustomobject]@{processes=$p;cpu=$c} | ConvertTo-Json -Compress'
      ], { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
      const parsed = JSON.parse(String(result.stdout).trim() || '{}') as { processes?: WindowsProcessRow | WindowsProcessRow[]; cpu?: WindowsCpuRow | WindowsCpuRow[] };
      const cpuRows = Array.isArray(parsed.cpu) ? parsed.cpu : parsed.cpu ? [parsed.cpu] : [];
      const cpuByPid = new Map(cpuRows.map(row => [Number(row.IDProcess), Math.max(0, Number(row.PercentProcessorTime) || 0)]));
      const processRows = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : [];
      for (const row of processRows) {
        const pid = Number(row.ProcessId), parent = Number(row.ParentProcessId);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        rows.push({ pid, parentPid: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
          name: typeof row.Name === 'string' && row.Name ? row.Name : 'System process',
          workingSetKb: Math.max(0, Number(row.WorkingSetSize) / 1024 || 0),
          ...(row.PrivatePageCount === undefined ? {} : { privateKb: Math.max(0, Number(row.PrivatePageCount) / 1024 || 0) }),
          creationTime: typeof row.CreationDate === 'string' ? Date.parse(row.CreationDate) || now : now,
          cpuPercent: cpuByPid.get(pid) ?? 0 });
      }
    } else {
      const result = await execFileAsync('ps', ['-e', '-o', 'pid=,ppid=,pcpu=,comm=,rss=,etimes='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
      for (const line of String(result.stdout).split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[0]), parent = Number(parts[1]), cpu = Number(parts[2]), rss = Number(parts[parts.length - 2]), elapsed = Number(parts[parts.length - 1]);
        const name = parts.slice(3, -2).join(' ') || 'System process';
        if (Number.isSafeInteger(pid) && pid > 0) rows.push({ pid, parentPid: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
          name, workingSetKb: Math.max(0, rss || 0), creationTime: now - Math.max(0, elapsed || 0) * 1000, cpuPercent: Math.max(0, cpu || 0) });
      }
    }
  } catch (error) {
    console.warn('[process-monitor] system process list unavailable:', error instanceof Error ? error.message : String(error));
  }
  systemCache = { refreshedAt: now, rows };
  return rows;
}

function webContentsLabels(): Map<number, { title?: string; url?: string; type?: string }> {
  const labels = new Map<number, { title?: string; url?: string; type?: string }>();
  for (const contents of webContents.getAllWebContents()) {
    try {
      const pid = contents.getOSProcessId();
      labels.set(pid, { title: contents.getTitle() || undefined, url: contents.getURL() || undefined, type: contents.getType() });
    } catch {
      // WebContents may disappear between enumeration and inspection.
    }
  }
  return labels;
}

function businessLabel(type: string, name: string, serviceName?: string, title?: string): string {
  if (title) return title;
  const service = (serviceName || name).toLowerCase();
  if (service.includes('audio')) return '音频服务';
  if (service.includes('network')) return '网络服务';
  if (service.includes('storage')) return '存储服务';
  if (type === 'Browser') return 'Muster 主进程';
  if (type === 'GPU') return '图形加速进程';
  if (type === 'Tab' || type === 'Renderer') return '工作区页面';
  if (type === 'Utility') return serviceName ? `Electron ${serviceName}` : 'Electron 工具进程';
  if (/^(node|node\.exe)$/i.test(name)) return 'Node 工作进程';
  if (/^(powershell|pwsh)(\.exe)?$/i.test(name)) return 'PowerShell 任务';
  if (/^conhost(\.exe)?$/i.test(name)) return 'Windows 控制台';
  if (/cursor/i.test(name)) return 'Cursor Agent';
  if (/zcode/i.test(name)) return 'ZCode 任务';
  if (/electron/i.test(name)) return 'Electron 外部进程';
  return name || type;
}

function captureDirectory(): string {
  const dir = userDataStorage(app.getPath('userData')).manifestPath('process-monitor-captures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pruneCaptures(dir: string): void {
  const entries = fs.readdirSync(dir).filter(name => /\.(cpuprofile|heapsnapshot)$/.test(name)).map(name => {
    const file = path.join(dir, name);
    try { return { file, stat: fs.statSync(file) }; } catch { return undefined; }
  }).filter((entry): entry is { file: string; stat: fs.Stats } => !!entry).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let total = entries.reduce((sum, entry) => sum + entry.stat.size, 0);
  for (const [index, entry] of entries.entries()) {
    if (index < 8 && total <= 128 * 1024 * 1024) continue;
    total -= entry.stat.size;
    try { fs.rmSync(entry.file, { force: true }); } catch { /* best effort cleanup */ }
  }
}

function profileFile(pid: number, suffix: 'cpuprofile' | 'heapsnapshot'): string {
  return path.join(captureDirectory(), `${Date.now()}-${pid}.${suffix}`);
}

function postInspector(session: inspector.Session, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => session.post(method, params ?? {}, (error, value) => error ? reject(error) : resolve((value ?? {}) as Record<string, unknown>)));
}

async function startCpuCapture(pid: number): Promise<ProcessMonitorCpuStartResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, error: '进程 PID 无效' };
  if (activeCpuCaptures.has(pid)) return { ok: false, error: '该进程已经在采集 CPU' };
  const startedAt = Date.now();
  const maxDurationMs = 10 * 60 * 1000;
  let mainSession: inspector.Session | undefined;
  let contents: Electron.WebContents | undefined;
  let finished = false;
  try {
    if (pid === process.pid) {
      mainSession = new inspector.Session();
      mainSession.connect();
      await postInspector(mainSession, 'Profiler.enable');
      await postInspector(mainSession, 'Profiler.start');
    } else {
      contents = webContents.getAllWebContents().find(item => {
        try { return item.getOSProcessId() === pid; } catch { return false; }
      });
      if (!contents) return { ok: false, error: '该进程不是可附加的 Electron/Chromium 进程' };
      if (contents.debugger.isAttached()) return { ok: false, error: '该页面已被 DevTools 占用，请先关闭 DevTools 后重试' };
      contents.debugger.attach('1.3');
      await contents.debugger.sendCommand('Profiler.enable');
      await contents.debugger.sendCommand('Profiler.start');
    }
    const stop = async (): Promise<ProcessMonitorProfileResult> => {
      if (finished) return { ok: false, error: 'CPU 采集已经结束' };
      finished = true;
      const capturedAt = Date.now();
      const file = profileFile(pid, 'cpuprofile');
      try {
        const result = mainSession
          ? await postInspector(mainSession, 'Profiler.stop')
          : await contents!.debugger.sendCommand('Profiler.stop');
        fs.writeFileSync(file, JSON.stringify(result.profile ?? result), 'utf8');
        pruneCaptures(path.dirname(file));
        return { ok: true, kind: 'cpu-profile', pid, path: file, sizeBytes: fs.statSync(file).size, capturedAt, durationMs: capturedAt - startedAt };
      } catch (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        try {
          if (mainSession) { await postInspector(mainSession, 'Profiler.disable'); mainSession.disconnect(); }
          else {
            try { await contents!.debugger.sendCommand('Profiler.disable'); } catch { /* profile already stopped */ }
            if (contents?.debugger.isAttached()) contents.debugger.detach();
          }
        } finally {
          activeCpuCaptures.delete(pid);
        }
      }
    };
    const timer = setTimeout(() => { void stop(); }, maxDurationMs);
    timer.unref?.();
    activeCpuCaptures.set(pid, { startedAt, stop, timer });
    return { ok: true, pid, startedAt, maxDurationMs };
  } catch (error) {
    try {
      if (mainSession) { try { await postInspector(mainSession, 'Profiler.disable'); } catch { /* ignore */ } mainSession.disconnect(); }
      if (contents?.debugger.isAttached()) contents.debugger.detach();
    } catch { /* ignore cleanup errors */ }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function stopCpuCapture(pid: number): Promise<ProcessMonitorProfileResult> {
  const active = activeCpuCaptures.get(pid);
  if (!active) return { ok: false, error: '该进程没有正在进行的 CPU 采集' };
  clearTimeout(active.timer);
  return active.stop();
}

async function captureCpuProfile(pid: number, durationMs: number): Promise<ProcessMonitorProfileResult> {
  const started = await startCpuCapture(pid);
  if (!started.ok) return started;
  await new Promise(resolve => setTimeout(resolve, Math.min(10_000, Math.max(500, durationMs))));
  return stopCpuCapture(pid);
}

async function captureHeapSnapshot(pid: number): Promise<ProcessMonitorProfileResult> {
  const capturedAt = Date.now();
  const file = profileFile(pid, 'heapsnapshot');
  try {
    if (pid === process.pid) v8.writeHeapSnapshot(file);
    else {
      const contents = webContents.getAllWebContents().find(item => {
        try { return item.getOSProcessId() === pid; } catch { return false; }
      });
      if (!contents) return { ok: false, error: '该进程不支持 Electron 堆快照' };
      await contents.takeHeapSnapshot(file);
    }
    pruneCaptures(path.dirname(file));
    return { ok: true, kind: 'heap-snapshot', pid, path: file, sizeBytes: fs.statSync(file).size, capturedAt };
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function openCaptureArtifact(filePath: string): { ok: true } | { ok: false; error: string } {
  try {
    const root = path.resolve(captureDirectory());
    const target = path.resolve(filePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return { ok: false, error: '诊断文件路径不在受管目录内' };
    if (!fs.existsSync(target)) return { ok: false, error: '诊断文件已不存在' };
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function collectProcessMonitorSnapshot(): Promise<ProcessMonitorSnapshot> {
  const capturedAt = Date.now();
  const metrics = app.getAppMetrics();
  const labels = webContentsLabels();
  const systemRows = await readSystemProcessRows();
  const systemByPid = new Map(systemRows.map(row => [row.pid, row]));
  const records = new Map<number, ProcessMonitorNode>();
  for (const metric of metrics) {
    const label = labels.get(metric.pid);
    const parentPid = metric.pid === process.pid ? null : (systemByPid.get(metric.pid)?.parentPid ?? null);
    records.set(metric.pid, {
      key: `${metric.pid}:${metric.creationTime}`,
      pid: metric.pid,
      parentPid,
      type: metric.type,
      name: metric.name || metric.serviceName || metric.type,
      businessLabel: businessLabel(metric.type, metric.name || metric.serviceName || metric.type, metric.serviceName, label?.title),
      ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
      ...(label?.title ? { title: label.title } : {}),
      ...(label?.url ? { url: label.url } : {}),
      creationTime: metric.creationTime,
      cpuPercent: Math.max(0, Number(metric.cpu.percentCPUUsage) || 0),
      workingSetKb: Math.max(0, Number(metric.memory.workingSetSize) || 0),
      ...(metric.memory.privateBytes === undefined ? {} : { privateKb: Math.max(0, Number(metric.memory.privateBytes) || 0) }),
      ...(metric.sandboxed === undefined ? {} : { sandboxed: metric.sandboxed }),
      children: []
    });
  }
  for (const [pid, owned] of ownedProcesses) {
    const existing = records.get(pid);
    if (existing) {
      records.set(pid, {
        ...existing,
        ...(owned.businessLabel ? { businessLabel: owned.businessLabel } : {}),
        ...(owned.role ? { role: owned.role } : {}),
        ...(owned.workspaceId ? { workspaceId: owned.workspaceId } : {}),
        ...(owned.workspaceName ? { workspaceName: owned.workspaceName } : {}),
        ...(owned.sessionId ? { sessionId: owned.sessionId } : {}),
        ...(owned.sessionName ? { sessionName: owned.sessionName } : {}),
        ...(owned.taskId ? { taskId: owned.taskId } : {}),
        ...(owned.taskLabel ? { taskLabel: owned.taskLabel } : {})
      });
      continue;
    }
    const parentPid = systemByPid.get(pid)?.parentPid ?? null;
    records.set(pid, {
      key: `${pid}:owned:${owned.startedAt}`,
      pid,
      parentPid,
      type: owned.type,
      name: owned.name,
      ...(owned.businessLabel ? { businessLabel: owned.businessLabel } : {}),
      ...(owned.serviceName ? { serviceName: owned.serviceName } : {}),
      ...(owned.role ? { role: owned.role } : {}),
      ...(owned.workspaceId ? { workspaceId: owned.workspaceId } : {}),
      ...(owned.workspaceName ? { workspaceName: owned.workspaceName } : {}),
      ...(owned.sessionId ? { sessionId: owned.sessionId } : {}),
      ...(owned.sessionName ? { sessionName: owned.sessionName } : {}),
      ...(owned.taskId ? { taskId: owned.taskId } : {}),
      ...(owned.taskLabel ? { taskLabel: owned.taskLabel } : {}),
      creationTime: owned.startedAt,
      cpuPercent: 0,
      workingSetKb: 0,
      children: []
    });
  }
  if (!records.has(process.pid)) {
    records.set(process.pid, {
      key: `${process.pid}:${process.getCreationTime() ?? capturedAt}`,
      pid: process.pid,
      parentPid: null,
      type: 'Browser',
      name: 'Muster 主进程',
      businessLabel: 'Muster 主进程',
      creationTime: process.getCreationTime() ?? capturedAt,
      cpuPercent: Math.max(0, Number(process.getCPUUsage().percentCPUUsage) || 0),
      workingSetKb: 0,
      children: []
    });
  }
  const roots: ProcessMonitorNode[] = [];
  for (const node of records.values()) {
    const parent = node.parentPid === null ? undefined : records.get(node.parentPid);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortTree = (items: ProcessMonitorNode[]): void => {
    items.sort((a, b) => a.pid - b.pid);
    items.forEach(item => sortTree(item.children));
  };
  sortTree(roots);
  history.push({ capturedAt, pids: [...records.keys()] });
  while (history.length > HISTORY_CAPACITY) history.shift();
  cpuHistory.push({ capturedAt, values: [...records.values()].map(node => ({ pid: node.pid, cpuPercent: node.cpuPercent })) });
  while (cpuHistory.length > SYSTEM_HISTORY_CAPACITY) cpuHistory.shift();
  return { capturedAt, rootPid: process.pid, processCount: records.size, historySize: history.length, historyCapacity: HISTORY_CAPACITY, nodes: roots, cpuHistory: cpuHistory.map(item => ({ capturedAt: item.capturedAt, values: item.values.map(value => ({ ...value })) })) };
}

export function registerProcessMonitorIpc(): void {
  handle('processMonitor:snapshot', () => collectProcessMonitorSnapshot());
  handle('processMonitor:capture', () => collectProcessMonitorSnapshot());
  handle('processMonitor:cpuProfile', (_event, input?: { pid?: number; durationMs?: number }) => captureCpuProfile(Number(input?.pid), Number(input?.durationMs) || 3000));
  handle('processMonitor:cpuStart', (_event, input?: { pid?: number }) => startCpuCapture(Number(input?.pid)));
  handle('processMonitor:cpuStop', (_event, input?: { pid?: number }) => stopCpuCapture(Number(input?.pid)));
  handle('processMonitor:heapSnapshot', (_event, input?: { pid?: number }) => captureHeapSnapshot(Number(input?.pid)));
  handle('processMonitor:openArtifact', (_event, input?: { path?: string }) => openCaptureArtifact(String(input?.path ?? '')));
}

