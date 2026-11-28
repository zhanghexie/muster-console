import { createRequire } from 'node:module';
import os from 'node:os';
import type { NativeSessionHistoryTarget } from '../../../../shared/sessionLifecycle';
import type { SessionMeta } from '../../../../shared/types';
import { t } from '../../../../shared/i18n';
import { ConnectionCleanupError } from '../../host/retirement';
import { createControlledChild } from '../../process/controlledChild';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { boundedAcpRequest } from '../../processReclamation';
import { NdjsonRpc } from '../acp/jsonRpc';
import { nativeHistoryPath, nativeHistoryScope } from '../historyBinding';

const sdkRequire = createRequire(import.meta.url);
const isSessionId = (id: string | undefined): id is string =>
  !!id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);

export function claudeHistoryStorageKey(configDir: string): string {
  return nativeHistoryScope('claude', [nativeHistoryPath(configDir)]);
}

export function describeClaudeHistory(session: Readonly<SessionMeta>, configDir: string): NativeSessionHistoryTarget | undefined {
  if (!isSessionId(session.runtimeResumeToken)) return;
  return { provider: 'Claude Code', storageKey: session.nativeHistoryStorageKey ?? claudeHistoryStorageKey(configDir),
    ids: [session.runtimeResumeToken], actions: ['delete'], permanentDelete: true, deletesNativeChildSessions: true };
}

// The SDK's local transcript APIs read CLAUDE_CONFIG_DIR from their process
// environment. Never change the app process's environment around a mutation.
const worker = String.raw`
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', async line => {
  const { id, params: { sessionId } } = JSON.parse(line);
  const reply = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...value }) + '\n');
  try {
    const sdk = await import(pathToFileURL(process.argv[1]).href);
    try { await sdk.deleteSession(sessionId); }
    catch (error) {
      if (error?.message !== 'Session ' + sessionId + ' not found in any project directory') throw error;
    }
    if (await sdk.getSessionInfo(sessionId)) throw new Error('Claude still lists the requested session');
    reply({ result: { sessionId } });
  } catch (error) { reply({ error: { code: -32603, message: String(error?.message ?? error).slice(0, 1200) } }); }
  finally { lines.close(); }
});
`;

export async function deleteClaudeHistory(session: Readonly<SessionMeta>, configDir: string): Promise<void> {
  const target = describeClaudeHistory(session, configDir);
  if (!target || target.storageKey !== claudeHistoryStorageKey(configDir)) {
    throw new Error(t('原生会话属于另一个历史目录，请使用原来的引擎配置后重试。'));
  }
  const sessionId = target.ids[0];
  const owner = createControlledChild(process.execPath, ['-e', worker, sdkRequire.resolve('@anthropic-ai/claude-agent-sdk')], {
    cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'],
    env: genericWorkerEnvironment({ ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: configDir })
  });
  const child = owner.child;
  child.stderr.resume();
  const rpc = new NdjsonRpc(child.stdin, child.stdout);
  child.on('error', error => rpc.failExternal(error));
  try {
    await boundedAcpRequest(owner.ready, 15_000, 'Claude Code 历史进程启动');
    const result = await boundedAcpRequest(rpc.request('deleteSession', { sessionId }), 15_000, 'Claude Code 删除会话') as { sessionId?: string } | undefined;
    if (result?.sessionId !== sessionId) throw new Error(t('{{provider}} 未确认原生会话操作。', { provider: 'Claude Code' }));
  } finally {
    rpc.close();
    try { await owner.reclaim(); }
    catch (error) { throw new ConnectionCleanupError(`Claude Code 历史进程回收失败：${(error as Error).message}`); }
  }
}
