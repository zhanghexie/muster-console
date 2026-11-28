import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../../../../shared/i18n';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import type { SessionMeta } from '../../../../shared/types';
import type { NativeSessionHistoryAction, NativeSessionHistoryTarget } from '../../../../shared/sessionLifecycle';
import { ConnectionCleanupError } from '../../host/retirement';
import { boundedAcpRequest } from '../../processReclamation';
import type { GuiRuntimeDriver } from '../../types';
import { nativeHistoryPath, nativeHistoryScope } from '../historyBinding';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import { asZCodeRecord as object, resolveZCodeExecutable, respondZCodeRuntimePreferences, startZCodeProcess, zcodeWorkspace } from './process';

const validId = (value: string | undefined): value is string => !!value && /^sess_[A-Za-z0-9_-]{1,180}$/.test(value);
export const zcodeHistoryStorageKey = (): string => nativeHistoryScope('zcode', [
  nativeHistoryPath(process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir())
]);

export class ZCodeNativeHistory implements NonNullable<GuiRuntimeDriver['nativeHistory']> {
  private observed?: { version: string; storageKey: string; supported: boolean };

  constructor(private readonly getExecutable: () => string | undefined, private readonly start = startZCodeProcess) {}

  describe(session: Readonly<SessionMeta>): NativeSessionHistoryTarget | undefined {
    if (!validId(session.runtimeResumeToken)) return;
    const storageKey = session.nativeHistoryStorageKey ?? zcodeHistoryStorageKey();
    return { provider: 'ZCode', storageKey, ids: [session.runtimeResumeToken],
      actions: this.observed?.supported && this.observed.storageKey === storageKey ? ['delete'] : [] };
  }

  async prepare(session: Readonly<SessionMeta>, action: NativeSessionHistoryAction): Promise<void> {
    if (action !== 'delete') return;
    const scope = this.describe(session);
    if (!scope || scope.storageKey !== zcodeHistoryStorageKey()) return;
    const executable = resolveZCodeExecutable(this.getExecutable());
    if (!executable) return;
    const version = nativeExecutableVersion(executable, 'zcode-history-v4');
    if (this.observed?.version === version && this.observed.storageKey === scope.storageKey) return;
    try {
      const supported = await this.withProcess(session, async request => object(await request('runtime/capabilities', {})).historyFirst === true);
      this.observed = { version, storageKey: scope.storageKey, supported };
    } catch (error) {
      if (error instanceof ConnectionCleanupError || this.observed?.supported) throw error;
      console.warn('[zcode history]', error instanceof Error ? error.message : String(error));
    }
  }

  async update(session: Readonly<SessionMeta>, action: NativeSessionHistoryAction): Promise<void> {
    const scope = this.describe(session);
    if (!scope || scope.storageKey !== zcodeHistoryStorageKey()) {
      throw new Error(t('原生会话属于另一个历史目录，请使用原来的引擎配置后重试。'));
    }
    const cwd = session.nativeHistoryCwd ?? session.cwd;
    if (!cwd || !path.isAbsolute(cwd) || action !== 'delete') throw new Error(t('会话状态已变化，请重新扫描。'));
    const id = scope.ids[0];
    const workspace = zcodeWorkspace(cwd);
    await this.withProcess(session, async request => {
      if (object(await request('runtime/capabilities', {})).historyFirst !== true) {
        throw new Error(t('{{provider}} 当前版本未声明此会话历史能力。', { provider: 'ZCode' }));
      }
      const exists = async (scoped: boolean): Promise<boolean> => {
        const { sessions } = object(await request('session/list', { ...(scoped ? { workspace } : {}), sessionIds: [id] }));
        if (!Array.isArray(sessions) || sessions.some(row => object(row).sessionId !== id)) {
          throw new Error(t('{{provider}} 未确认原生会话操作。', { provider: 'ZCode' }));
        }
        return sessions.length > 0;
      };
      if (!await exists(true)) {
        if (await exists(false)) throw new Error(t('ZCode 会话属于另一个工作目录。'));
        return;
      }
      const commandId = randomUUID();
      const result = object(await request('v4/command', {
        workspace, commandId, clientId: 'muster-history', issuedAt: Date.now(), sessionId: id, type: 'deleteSession', payload: {}
      }));
      if (result.commandId !== commandId || (result.status !== 'accepted' && result.status !== 'duplicate') || await exists(false)) {
        throw new Error(t('{{provider}} 未确认原生会话操作。', { provider: 'ZCode' }));
      }
    });
  }

  private async withProcess<T>(session: Readonly<SessionMeta>, run: (
    request: (method: string, params: unknown) => Promise<unknown>
  ) => Promise<T>): Promise<T> {
    const cwd = session.nativeHistoryCwd ?? session.cwd;
    const launchCwd = cwd && fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory() ? cwd : os.homedir();
    const native = this.start(launchCwd, this.getExecutable());
    native.rpc.on('message', message => {
      if (respondZCodeRuntimePreferences(native.rpc, message)) return;
      if (message.id != null && message.method) native.rpc.respondError(message.id, 'ZCode history client does not accept this request', -32601);
    });
    try {
      await boundedAcpRequest(native.waitReady(), 15_000, 'ZCode 历史进程启动');
      return await run((method, params) => boundedAcpRequest(native.rpc.request(method, params), 15_000, `ZCode ${method}`));
    } catch (error) {
      throw new Error(redactSafetyText(error instanceof Error ? error.message : String(error), collectEnvSecrets(process.env)).slice(0, 800));
    } finally {
      try { await native.close(); }
      catch (error) { throw new ConnectionCleanupError(`ZCode 历史进程回收失败：${(error as Error).message}`); }
    }
  }
}
