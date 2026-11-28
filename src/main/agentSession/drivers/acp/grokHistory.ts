import { t } from '../../../../shared/i18n';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { ConnectionCleanupError } from '../../host/retirement';
import { createControlledChild } from '../../process/controlledChild';
import { boundedAcpRequest } from '../../processReclamation';
import { wrapCmdShimIfNeeded } from './agents';

type GrokHistoryInput = { executable: string; cwd: string; env: NodeJS.ProcessEnv };

export const isGrokHistoryId = (id: string): boolean => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

async function runGrokHistory(input: GrokHistoryInput, argument: string): Promise<{ code: number | null; stdout: string }> {
  const launch = wrapCmdShimIfNeeded(input.executable, ['--no-auto-update', 'sessions', 'delete', argument]);
  if ('error' in launch) throw new Error(launch.error);
  const owner = createControlledChild(launch.command, launch.args, {
    cwd: input.cwd, env: input.env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: launch.command === 'cmd.exe'
  });
  const { child } = owner;
  let stdout = '', stderr = '', oversized = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (stdout.length + chunk.length > 8192) oversized = true;
    if (!oversized) stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  void completed.catch(() => {});
  try {
    await boundedAcpRequest(owner.ready, 15_000, 'Grok Build 历史进程启动');
    const code = await boundedAcpRequest(completed, 15_000, 'Grok Build 历史操作');
    const detail = redactSafetyText(stderr.trim(), collectEnvSecrets(input.env)).slice(0, 600);
    if (code !== 0 && detail) throw new Error(detail);
    return { code, stdout: oversized ? '' : stdout.trim() };
  } finally {
    try { await owner.reclaim(); }
    catch (error) { throw new ConnectionCleanupError(`Grok Build 历史进程回收失败：${(error as Error).message}`); }
  }
}

export async function probeGrokHistory(input: GrokHistoryInput): Promise<boolean> {
  const result = await runGrokHistory(input, '--help');
  return result.code === 0 && /^Usage: grok sessions delete \[OPTIONS\] <ID>\r?$/m.test(result.stdout);
}

export async function deleteGrokHistory(input: GrokHistoryInput, id: string): Promise<void> {
  if (!isGrokHistoryId(id)) throw new Error(t('会话状态已变化，请重新扫描。'));
  const result = await runGrokHistory(input, id);
  if (result.code !== 0 || (result.stdout !== `Deleted session ${id}` && result.stdout !== `Session '${id}' not found.`)) {
    throw new Error(t('{{provider}} 未确认原生会话操作。', { provider: 'Grok Build' }));
  }
}
