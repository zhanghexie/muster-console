import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { desktopRuntime } from './runtime';

export interface X11WindowObservation {
  nativeHandle: string; title: string; titleTruncated: boolean; pid: number | null; clientMachine: string;
  processImage: string | null; processCreated: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  coordinateSpace: 'x11-root-pixels'; limitations: string[];
}
export interface X11InventoryResult { windows: X11WindowObservation[]; complete: boolean; omitted: number; limitations: string[] }
interface Candidate { nativeHandle: string; title: string; pid: number | null; clientMachine: string; bounds: X11WindowObservation['bounds'] }

/** wmctrl is a line protocol: titles and client-provided PID are untrusted, never actionable identities. */
export function parseX11WindowList(output: string, limit = 500): { candidates: Candidate[]; omitted: number; truncated: boolean } {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid X11 inventory input');
  const candidates: Candidate[] = [], seen = new Set<string>();
  let omitted = 0, truncated = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/i.exec(line);
    if (!match) { omitted++; continue; }
    const handle = match[1].toLowerCase(), pid = Number(match[3]), x = Number(match[4]), y = Number(match[5]), width = Number(match[6]), height = Number(match[7]);
    if (seen.has(handle) || ![pid, x, y, width, height].every(Number.isSafeInteger) || pid < 0 || width < 1 || height < 1 || width > 1_000_000 || height > 1_000_000) { omitted++; continue; }
    seen.add(handle);
    if (candidates.length >= limit) { truncated = true; continue; }
    candidates.push({ nativeHandle: handle, pid: pid || null, clientMachine: match[8], title: match[9], bounds: { x, y, width, height } });
  }
  return { candidates, omitted, truncated };
}

/** /proc stat starttime is an opaque kernel tick count, not a wall-clock timestamp. */
export function parseLinuxProcessStart(stat: string): string {
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error('Invalid process stat');
  const fields = stat.slice(end + 1).trim().split(/\s+/), start = fields[19];
  if (!/^\d+$/.test(start ?? '')) throw new Error('Invalid process start time');
  return start;
}

async function processIdentity(pid: number): Promise<{ image: string; created: string } | null> {
  try {
    const stat = `/proc/${pid}/stat`, before = parseLinuxProcessStart(await fs.readFile(stat, 'utf8'));
    const image = await fs.readlink(`/proc/${pid}/exe`);
    const after = parseLinuxProcessStart(await fs.readFile(stat, 'utf8'));
    return image && before === after ? { image, created: before } : null;
  } catch { return null; }
}

function runWmctrl(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['-u', '-l', '-p', '-G'], { env, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

/** Read-only EWMH inventory; no capture, activation or native Wayland/XWayland claims. */
export async function enumerateLinuxX11Windows(options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; limit?: number; executable?: string;
  run?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string>;
  identify?: (pid: number) => Promise<{ image: string; created: string } | null>; hostname?: string;
} = {}): Promise<X11InventoryResult> {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  if (platform !== 'linux') throw new Error('X11 inventory is unavailable on this platform');
  const runtime = desktopRuntime(platform, env);
  if (runtime === 'linux-wayland') throw new Error('Native Wayland inventory requires a compositor or portal adapter; XWayland alone is not equivalent');
  if (runtime !== 'linux-x11' || !env.DISPLAY?.trim()) throw new Error('An active X11 DISPLAY is required');
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid window inventory limit');
  const executable = options.executable ?? '/usr/bin/wmctrl';
  if (!executable.startsWith('/') || executable.includes('\0')) throw new Error('wmctrl executable must be an absolute path');
  let output: string;
  try { output = await (options.run ?? runWmctrl)(executable, env); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('wmctrl is unavailable; install it with your distribution package manager or configure its absolute path');
    throw new Error(`X11 window inventory failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseX11WindowList(output, limit), identify = options.identify ?? processIdentity;
  const hostname = options.hostname ?? os.hostname();
  const windows: X11WindowObservation[] = [];
  for (const item of parsed.candidates) {
    const local = item.clientMachine === hostname || item.clientMachine === 'localhost';
    const identity = local && item.pid ? await identify(item.pid).catch(() => null) : null;
    const limitations = ['window_incarnation_unverified', 'x11_pid_client_asserted', 'wmctrl_line_protocol_untrusted', 'geometry_unverified'];
    if (!local) limitations.push('remote_or_unknown_client_machine');
    if (!identity) limitations.push('process_identity_unavailable');
    windows.push({ ...item, title: item.title.slice(0, 1024), titleTruncated: item.title.length > 1024,
      processImage: identity?.image ?? null, processCreated: identity?.created ?? null, coordinateSpace: 'x11-root-pixels', limitations });
  }
  return { windows, complete: !parsed.truncated && parsed.omitted === 0, omitted: parsed.omitted,
    limitations: ['ewmh_client_list_only', 'wmctrl_line_protocol_untrusted', 'window_incarnation_unverified',
      ...(parsed.truncated ? ['inventory_truncated'] : []), ...(parsed.omitted ? ['malformed_or_unavailable_windows'] : [])] };
}
