/**
 * CLI Worker 入站 MCP 的 pid → 会话身份表。
 * Claude Code 不向 MCP 子进程传播 MUSTER_*，沿 ppid 上溯对本表（对齐 wmux pid-map）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InboundMcpPidRecord } from '../../shared/inboundMcp';
const owners = new Map<string, object>();

export function inboundMcpPidMapDir(home = os.homedir()): string {
  return path.join(home, '.muster', 'pid-map');
}

export function pidMapFile(pid: number, home?: string): string {
  return path.join(inboundMcpPidMapDir(home), `${pid}.json`);
}

export function writeInboundMcpPidRecord(rec: InboundMcpPidRecord, home?: string): void {
  const dir = inboundMcpPidMapDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = pidMapFile(rec.ptyPid, home), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(rec)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  owners.set(target, {});
}

/** An auxiliary process lease cannot remove a later binding after PID reuse. */
export function bindInboundMcpPidRecord(rec: InboundMcpPidRecord, home?: string): () => void {
  writeInboundMcpPidRecord(rec, home);
  const key = pidMapFile(rec.ptyPid, home), owner = owners.get(key);
  return () => {
    if (owners.get(key) !== owner) return;
    const current = readInboundMcpPidRecord(rec.ptyPid, home);
    if (current?.sessionId === rec.sessionId && current.token === rec.token &&
      current.statusUrl === rec.statusUrl && current.toolUrl === rec.toolUrl)
      removeInboundMcpPidRecord(rec.ptyPid, home);
    else owners.delete(key);
  };
}

export function bindSessionProcessRoots(sessionId: string, pids: readonly number[], env: Record<string, string>, home?: string): () => void {
  if (!pids.length) return () => {};
  const token = env.MUSTER_SESSION_TOKEN?.trim(), statusUrl = env.MUSTER_STATUS_URL?.trim(), toolUrl = env.MUSTER_TOOL_URL?.trim();
  if (!token || !statusUrl || !toolUrl) throw new Error('Owned runtime backend has no host session identity');
  const releases: Array<() => void> = [];
  try {
    for (const pid of new Set(pids)) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Runtime backend returned an invalid process ID');
      releases.push(bindInboundMcpPidRecord({ ptyPid: pid, sessionId, token, statusUrl, toolUrl }, home));
    }
  } catch (error) { for (const end of releases.reverse()) end(); throw error; }
  return () => { for (const end of releases.splice(0).reverse()) end(); };
}

export function removeInboundMcpPidRecord(pid: number, home?: string): void {
  owners.delete(pidMapFile(pid, home));
  try {
    fs.unlinkSync(pidMapFile(pid, home));
  } catch {
    // 已不在
  }
}

export function readInboundMcpPidRecord(pid: number, home?: string): InboundMcpPidRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pidMapFile(pid, home), 'utf8')) as InboundMcpPidRecord;
    if (!raw || typeof raw.token !== 'string' || !raw.token.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

export function parentPidOf(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const wmic = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'wbem', 'wmic.exe')
        : 'wmic';
      try {
        const out = execFileSync(wmic,
          ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'],
          { encoding: 'utf8', windowsHide: true, timeout: 4000 });
        const m = /ParentProcessId=(\d+)/i.exec(out);
        if (m && Number(m[1]) > 0) return Number(m[1]);
      } catch { /* WMIC is absent on current Windows; use the built-in CIM client. */ }
      const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      const n = Number(String(out).trim());
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const rest = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/) : stat.trim().split(/\s+/);
      const ppid = Number(rest[1]);
      return ppid > 0 ? ppid : null;
    }
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000
    });
    const n = parseInt(out.trim(), 10);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
