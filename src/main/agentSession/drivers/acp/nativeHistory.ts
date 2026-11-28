import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../../../../shared/i18n';
import type { NativeSessionHistoryAction, NativeSessionHistoryTarget } from '../../../../shared/sessionLifecycle';
import type { SessionMeta } from '../../../../shared/types';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { ConnectionCleanupError } from '../../host/retirement';
import { createControlledChild } from '../../process/controlledChild';
import { boundedAcpRequest } from '../../processReclamation';
import type { GuiRuntimeDriver } from '../../types';
import { nativeHistoryPath, nativeHistoryScope } from '../historyBinding';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import type { AcpTransport } from './driver';
import { NdjsonRpc, NdjsonRpcResponseError } from './jsonRpc';
import { acpLaunchEnvironment, decodeAcpResumeToken } from './launchPolicy';
import { acpConfigCapabilities } from './nativeConfig';
import { deleteGrokHistory, isGrokHistoryId, probeGrokHistory } from './grokHistory';
import { isOpenCodeHistoryId, probeOpenCodeHistory, updateOpenCodeHistory } from './opencodeHistory';

type Launch = { command: string; args: string[]; executable?: string };
type Command = Launch & { cwd: string; env: NodeJS.ProcessEnv };
type Identity = { id: string; label: string; sessionId: string; cwd: string; env: NodeJS.ProcessEnv; storageKey: string };
type Target = Identity & { launch: Launch; executableVersion: string };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const acpInitializeParams = {
  protocolVersion: 1,
  clientInfo: { name: 'muster-workbench', version: '0.1' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: acpConfigCapabilities }
};

// ACP identities are opaque and belong to one preset and storage profile.
// Treat changes to known storage roots as a different profile.
const profilePaths: Record<string, string[]> = {
  opencode: ['OPENCODE_DB', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG'],
  gemini: ['GEMINI_CLI_HOME'], 'github-copilot': ['COPILOT_HOME'],
  qwen: ['QWEN_CODE_HOME', 'QWEN_DIR', 'DASHSCOPE_CLI_HOME'],
  kimi: ['KIMI_HOME', 'KIMI_CODE_HOME', 'KIMI_CODE_DATA_DIR'],
  hermes: ['HERMES_HOME'], cursor: ['CURSOR_AGENT_HOME'], cline: ['CLINE_DIR', 'CLINE_HOME'],
  deepseek: ['DSH_HOME', 'DSH_CONFIG_DIR'], 'mimo-code': ['MIMO_HOME'], commandcode: ['COMMAND_CODE_HOME'], grok: ['GROK_HOME'],
  'codebuddy-cli': ['CODEBUDDY_CONFIG_DIR']
};

export function acpHistoryStorageKey(id: string, env: NodeJS.ProcessEnv): string {
  const paths = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', ...(profilePaths[id] ?? [])];
  return nativeHistoryScope('acp:' + id, [nativeHistoryPath(os.homedir()),
    ...paths.map(key => env[key]?.trim() ? nativeHistoryPath(env[key]!) : null)]);
}

export function acpHistoryActions(reply: unknown): NativeSessionHistoryAction[] {
  const init = record(reply);
  if (init?.protocolVersion !== 1) return [];
  const capability = record(record(init.agentCapabilities)?.sessionCapabilities);
  const actions: NativeSessionHistoryAction[] = [];
  if (record(capability?.delete)) actions.push('delete');
  if (record(capability?.archive) && record(capability?.list)) actions.push('archive', 'unarchive');
  return actions;
}

function supportsQwenDeletion(reply: unknown): boolean {
  const init = record(reply);
  const info = record(init?.agentInfo);
  if (init?.protocolVersion !== 1 || info?.name !== 'qwen-code' || typeof info.version !== 'string') return false;
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(info.version);
  if (!version) return false;
  const [major, minor, patch] = version.slice(1).map(Number);
  return major > 0 || minor > 28 || (minor === 28 && patch >= 7);
}

const isQwenSession = (id: string): boolean => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

const isKimiCodeCli = (reply: unknown): boolean => record(record(reply)?.agentInfo)?.name === 'Kimi Code CLI';

function spawnAcpHistoryAgent(launch: Command): AcpTransport {
  const owner = createControlledChild(launch.command, launch.args, {
    cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: process.platform === 'win32' && path.basename(launch.command).toLowerCase() === 'cmd.exe'
  });
  const child = owner.child;
  child.stderr.resume();
  const rpc = new NdjsonRpc(child.stdin, child.stdout);
  child.on('error', error => rpc.failExternal(error));
  rpc.on('message', message => {
    if (message.id != null && message.method) rpc.respondError(message.id, 'ACP history client does not accept agent requests', -32601);
  });
  return { rpc, waitReady: () => owner.ready, kill: () => owner.reclaim() };
}

export class AcpNativeHistory implements NonNullable<GuiRuntimeDriver['nativeHistory']> {
  private readonly capabilities = new Map<string, {
    version: string; storageKey: string; actions: NativeSessionHistoryAction[]; qwenDelete: boolean; kimiCodeCli: boolean;
  }>();
  private openCodeV2?: { version: string; storageKey: string; available: boolean };
  private grokCli?: { version: string; storageKey: string; available: boolean };

  constructor(private readonly options: {
    label(id: string): string | undefined;
    resolve(id: string): Launch | undefined;
    spawn?: (command: Command) => AcpTransport;
    timeout?: number;
  }) {}

  private identity(session: Readonly<SessionMeta>): Identity | undefined {
    if (!session.runtimeResumeToken) return;
    // Legacy rows can use their explicitly recorded preset. Do not resolve an
    // unbound archived record via whichever executable happens to be on PATH.
    const boundId = /^acp:([^:]+):[a-f0-9]{64}$/.exec(session.nativeHistoryStorageKey ?? '')?.[1];
    const id = boundId ?? session.piModeId;
    if (!id || (boundId && session.piModeId && boundId !== session.piModeId)) return;
    const label = this.options.label(id);
    const cwd = session.nativeHistoryCwd ?? session.cwd;
    if (!label || !cwd || !path.isAbsolute(cwd)) return;
    const env = acpLaunchEnvironment(id, process.env);
    const sessionId = decodeAcpResumeToken(id, session.runtimeResumeToken);
    if (!sessionId || /[\u0000-\u001f\u007f]/.test(sessionId)) return;
    return { id, label, sessionId, cwd, env, storageKey: session.nativeHistoryStorageKey ?? acpHistoryStorageKey(id, env) };
  }

  private target(identity: Identity): Target | undefined {
    const launch = this.options.resolve(identity.id);
    if (!launch) return;
    return { ...identity, launch, executableVersion: nativeExecutableVersion(launch.executable ?? launch.command, JSON.stringify(launch.args)) };
  }

  observe(id: string, launch: Launch, env: NodeJS.ProcessEnv, init: unknown): void {
    this.capabilities.set(id, {
      version: nativeExecutableVersion(launch.executable ?? launch.command, JSON.stringify(launch.args)),
      storageKey: acpHistoryStorageKey(id, env), actions: acpHistoryActions(init),
      qwenDelete: id === 'qwen' && supportsQwenDeletion(init), kimiCodeCli: id === 'kimi' && isKimiCodeCli(init)
    });
  }

  private usesGrokCli(identity: Identity): boolean {
    const known = this.capabilities.get(identity.id);
    return identity.id === 'grok' && !!this.grokCli?.available && this.grokCli.storageKey === identity.storageKey &&
      isGrokHistoryId(identity.sessionId) && !(known?.storageKey === identity.storageKey && known.actions.includes('delete'));
  }

  describe(session: Readonly<SessionMeta>): NativeSessionHistoryTarget | undefined {
    const identity = this.identity(session);
    if (!identity) return;
    const known = this.capabilities.get(identity.id);
    if (identity.id === 'opencode' && isOpenCodeHistoryId(identity.sessionId) &&
        this.openCodeV2?.available && this.openCodeV2.storageKey === identity.storageKey) {
      return { provider: identity.label, storageKey: identity.storageKey, ids: [identity.sessionId],
        actions: ['delete', 'archive', 'unarchive'], permanentDelete: true, deletesNativeChildSessions: true };
    }
    const actions = new Set<NativeSessionHistoryAction>(known?.storageKey === identity.storageKey ? known.actions : []);
    if (known?.storageKey === identity.storageKey && known.qwenDelete && isQwenSession(identity.sessionId)) actions.add('delete');
    const grokDelete = this.usesGrokCli(identity);
    if (grokDelete) actions.add('delete');
    const permanentDelete = grokDelete || (known?.storageKey === identity.storageKey && known.kimiCodeCli && actions.has('delete'));
    return { provider: identity.label, storageKey: identity.storageKey, ids: [identity.sessionId], actions: [...actions],
      ...(permanentDelete ? { permanentDelete: true } : {}) };
  }

  async prepare(session: Readonly<SessionMeta>, action?: NativeSessionHistoryAction): Promise<void> {
    const identity = this.identity(session);
    if (!identity) return;
    const known = this.capabilities.get(identity.id);
    const target = this.target(identity);
    if (!target) return;
    if (identity.storageKey !== acpHistoryStorageKey(identity.id, identity.env)) return;
    const matching = (entry: { version: string; storageKey: string } | undefined): boolean =>
      entry?.version === target.executableVersion && entry.storageKey === target.storageKey;
    try {
      if (!matching(known)) {
        const init = await this.withConnection(target, async (_rpc, value) => value);
        this.observe(identity.id, target.launch, identity.env, init);
      }
    } catch (error) {
      if (error instanceof ConnectionCleanupError || known?.actions.length || known?.qwenDelete) throw error;
      // Installation failures during optional capability discovery cannot
      // prevent the workbench-only action for an engine with unknown support.
      console.warn('[acp history]', identity.label, error instanceof Error ? error.message : String(error));
    }
    if (identity.id === 'opencode' && target.launch.executable && isOpenCodeHistoryId(identity.sessionId) && !matching(this.openCodeV2)) {
      try {
        const available = await probeOpenCodeHistory({ executable: target.launch.executable, cwd: this.launchCwd(target), env: target.env });
        this.openCodeV2 = { version: target.executableVersion, storageKey: target.storageKey, available };
      } catch (error) {
        if (error instanceof ConnectionCleanupError || this.openCodeV2?.available) throw error;
        console.warn('[opencode history]', error instanceof Error ? error.message : String(error));
        this.openCodeV2 = { version: target.executableVersion, storageKey: target.storageKey, available: false };
      }
    }
    if (action === 'delete' && identity.id === 'grok' && target.launch.executable && isGrokHistoryId(identity.sessionId) &&
        !this.capabilities.get(identity.id)?.actions.includes('delete') && !matching(this.grokCli)) {
      try {
        const available = await probeGrokHistory({ executable: target.launch.executable, cwd: this.launchCwd(target), env: target.env });
        this.grokCli = { version: target.executableVersion, storageKey: target.storageKey, available };
      } catch (error) {
        if (error instanceof ConnectionCleanupError || this.grokCli?.available) throw error;
        console.warn('[grok history]', error instanceof Error ? error.message : String(error));
      }
    }
  }

  async update(session: Readonly<SessionMeta>, action: NativeSessionHistoryAction, otherSessionIds?: ReadonlySet<string>): Promise<void> {
    const identity = this.identity(session);
    if (!identity) throw new Error(t('会话状态已变化，请重新扫描。'));
    if (identity.storageKey !== acpHistoryStorageKey(identity.id, identity.env)) {
      throw new Error(t('原生会话属于另一个历史目录，请使用原来的引擎配置后重试。'));
    }
    const target = this.target(identity);
    if (!target) throw new Error(t('未找到 {{provider}}，无法同步会话历史。', { provider: identity.label }));
    if (action === 'delete' && this.usesGrokCli(identity)) {
      if (!target.launch.executable || this.grokCli?.version !== target.executableVersion) {
        throw new Error(t('会话状态已变化，请重新扫描。'));
      }
      await deleteGrokHistory({ executable: target.launch.executable, cwd: this.launchCwd(target), env: target.env }, identity.sessionId);
      return;
    }
    if (identity.id === 'opencode' && this.openCodeV2?.available && this.openCodeV2.storageKey === identity.storageKey &&
        isOpenCodeHistoryId(identity.sessionId)) {
      if (!target.launch.executable || this.openCodeV2.version !== target.executableVersion) {
        throw new Error(t('会话状态已变化，请重新扫描。'));
      }
      await updateOpenCodeHistory({ executable: target.launch.executable, cwd: this.launchCwd(target), env: target.env },
        identity.sessionId, action, otherSessionIds);
      return;
    }
    await this.withConnection(target, async (rpc, init) => {
      const actions = acpHistoryActions(init);
      if (action === 'delete' && identity.id === 'qwen' && !actions.includes(action) &&
          supportsQwenDeletion(init) && isQwenSession(identity.sessionId)) {
        // Qwen's released VS Code companion sends this vendor wire method
        // without an underscore. It resolves the transcript using this cwd.
        const result = record(await boundedAcpRequest(rpc.request('deleteSession', { sessionId: identity.sessionId, cwd: identity.cwd }),
          this.options.timeout ?? 15_000, 'Qwen Code deleteSession'));
        if (result?.success !== true) throw new Error(t('{{provider}} 未确认原生会话操作。', { provider: identity.label }));
        return;
      }
      if (!actions.includes(action)) throw new Error(t('{{provider}} 当前版本未声明此会话历史能力。', { provider: identity.label }));
      try {
        const result = record(await boundedAcpRequest(rpc.request(`session/${action}`, { sessionId: identity.sessionId }),
          this.options.timeout ?? 15_000, `ACP session/${action}`));
        if (!result || Object.keys(result).some(key => key !== '_meta')) {
          throw new Error(t('{{provider}} 未确认原生会话操作。', { provider: identity.label }));
        }
      } catch (error) {
        if (action === 'delete' && error instanceof NdjsonRpcResponseError) {
          if (error.code === -32002) return;
          // This vendor uses InvalidParams for an already deleted session. Do
          // not accept other parameter errors or errors naming another ID.
          if (identity.id === 'kimi' && isKimiCodeCli(init) && error.code === -32602 &&
              record(error.data)?.sessionId === identity.sessionId && error.message.endsWith(`Unknown sessionId: ${identity.sessionId}`)) return;
        }
        throw error;
      }
    });
  }

  private async withConnection<T>(target: Target, run: (rpc: NdjsonRpc, init: unknown) => Promise<T>): Promise<T> {
    const timeout = this.options.timeout ?? 15_000;
    const cwd = this.launchCwd(target);
    const transport = (this.options.spawn ?? spawnAcpHistoryAgent)({ ...target.launch, cwd, env: target.env });
    const clean = (error: unknown) => redactSafetyText(error instanceof Error ? error.message : String(error),
      collectEnvSecrets(target.env)).slice(0, 800);
    try {
      if (transport.waitReady) await boundedAcpRequest(transport.waitReady(), timeout, 'ACP 历史进程启动');
      const init = await boundedAcpRequest(transport.rpc.request('initialize', acpInitializeParams), timeout, 'ACP 历史能力协商');
      return await run(transport.rpc, init);
    } catch (error) { throw new Error(clean(error)); }
    finally {
      transport.rpc.close();
      try { await transport.kill(); }
      catch (error) { throw new ConnectionCleanupError(`ACP 历史进程回收失败：${clean(error)}`); }
    }
  }

  private launchCwd(target: Identity): string {
    return fs.statSync(target.cwd, { throwIfNoEntry: false })?.isDirectory() ? target.cwd : os.homedir();
  }
}
