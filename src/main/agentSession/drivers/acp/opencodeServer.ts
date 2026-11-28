import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { spawnOwnedProcess } from '../../process/owner';
import { ConnectionCleanupError } from '../../host/retirement';
import { externalPiLaunchArgs } from '../externalPi/executable';
import { boundedAcpRequest } from '../../processReclamation';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';

const MAX_RESPONSE = 16 * 1024 * 1024;
export type OpenCodeServerInput = { executable: string; cwd: string; env: NodeJS.ProcessEnv };
export type OpenCodeRequest = (url: string, authorized: boolean, options?: RequestInit) => Promise<Response>;

export async function openCodeBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE) throw new Error('OpenCode 原生历史超过安全读取上限');
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length).toString('utf8');
}

export async function withOpenCodeServer<T>(
  input: OpenCodeServerInput, run: (request: OpenCodeRequest) => Promise<T>
): Promise<T> {
  const password = randomBytes(32).toString('base64url');
  const launch = externalPiLaunchArgs(input.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
  const owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({ ...launch, windows: { kind: 'taskkill' },
    spawnOptions: { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...input.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
      windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(launch.command) } });
  let resolveEndpoint!: (value: string) => void;
  let rejectEndpoint!: (error: Error) => void;
  const endpoint = new Promise<string>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
  // Startup errors can precede the await below.
  void endpoint.catch(() => {});
  let output = '';
  let stderr = '';
  const secrets = [password, ...collectEnvSecrets(input.env)];
  owner.child.stdout.setEncoding('utf8');
  owner.child.stdout.on('data', (chunk: string) => {
    output = (output + chunk).slice(-16384);
    const match = /(?:^|\n)(?:opencode )?server listening on http:\/\/127\.0\.0\.1:(\d{1,5})(?:\r?\n|$)/i.exec(output);
    const port = match ? Number(match[1]) : 0;
    if (port > 0 && port <= 65535) resolveEndpoint(`http://127.0.0.1:${port}`);
  });
  owner.child.stdout.on('error', rejectEndpoint);
  owner.child.on('error', rejectEndpoint);
  owner.child.stderr.setEncoding('utf8');
  owner.child.stderr.on('data', (chunk: string) => { stderr = (stderr + redactSafetyText(chunk, secrets)).slice(-1200); });
  void owner.exited.then(() => rejectEndpoint(new Error(`OpenCode 本地服务提前退出${stderr.trim() ? `：${stderr.trim()}` : ''}`)));
  try {
    await boundedAcpRequest(owner.ready, 30_000, 'OpenCode 本地服务启动');
    const base = await boundedAcpRequest(endpoint, 30_000, 'OpenCode 本地服务就绪');
    const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
    return await run((url, authorized, options = {}) => fetch(base + url, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...(authorized ? { authorization: auth } : {}), ...(options.headers ?? {}) }
    }));
  } finally {
    try { await owner.reclaim(); }
    catch (error) { throw new ConnectionCleanupError(`OpenCode 本地服务回收失败：${(error as Error).message}`); }
  }
}
