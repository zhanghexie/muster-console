import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PRODUCT_STORAGE_DIR } from '../../shared/productIdentity';

/**
 * Muster 存储根解析器（clean-break）。
 *
 * 业务代码不得自行拼接旧产品名或 `app.getPath('userData')` 的隐式分支；
 * 所有新产品落盘路径从这里按 scope + purpose 派生。开发环境下把候选路径
 * 交给 `assertWritable()` 可以在写入前拒绝落到旧产品根目录。
 */

export type StorageScope = 'app' | 'workspace' | 'session';
export type StoragePurpose =
  | 'sessions'
  | 'scheduler'
  | 'agent-sessions'
  | 'scheduler-sessions'
  | 'agent-session-events'
  | 'extensions'
  | 'memory'
  | 'cache'
  | 'logs'
  | 'evidence'
  | 'dev-sandbox'
  | 'themes'
  | 'conversation-attachments'
  | 'browser-captures'
  | 'browser-downloads'
  | 'browser-download-receipts'
  | 'desktop'
  | 'desktop-captures'
  | 'terminal-captures'
  | 'bg-outputs'
  | 'cli-runs'
  | 'agent-apps'
  | 'pi-sessions'
  | 'backdrops'
  | 'avatars'
  | 'feedback'
  | 'messaging'
  | 'session-handovers'
  | 'extension'
  | 'capability-management'
  | 'capability-home'
  | 'safety'
  | 'agent-runtimes'
  | 'agent-messages'
  | 'feishu-qr'
  | 'cli-discovery'
  | 'agent-fork-pending'
  | 'agent-fork-context'
  | 'agent-fork-points'
  | 'agent-inputs'
  | 'trim-cache'
  | 'muster-core'
  | 'pi-native-sessions'
  | 'pi-modes'
  | 'claude-gui-home'
  | 'declaration-trust'
  | 'turn-changes';

const PURPOSE_SEGMENT: Record<StoragePurpose, string> = {
  sessions: 'sessions',
  scheduler: 'scheduler',
  'agent-sessions': 'agent-sessions',
  'scheduler-sessions': 'scheduler-sessions',
  'agent-session-events': 'agent-session-events',
  extensions: 'extensions',
  memory: 'memory',
  cache: 'cache',
  logs: 'logs',
  evidence: 'evidence',
  'dev-sandbox': 'dev-sandbox',
  'themes': 'themes',
  'conversation-attachments': 'conversation-attachments',
  'browser-captures': 'browser-captures',
  'browser-downloads': 'browser-downloads',
  'browser-download-receipts': 'browser-download-receipts',
  'desktop': 'desktop',
  'desktop-captures': 'desktop-captures',
  'terminal-captures': 'terminal-captures',
  'bg-outputs': 'bg-outputs',
  'cli-runs': 'cli-runs',
  'agent-apps': 'agent-apps',
  'pi-sessions': 'pi-sessions',
  'backdrops': 'backdrops',
  'avatars': 'avatars',
  'feedback': 'feedback',
  'messaging': 'messaging',
  'session-handovers': 'session-handovers',
  'extension': 'extension',
  'capability-management': 'capability-management',
  'capability-home': 'capability-home',
  'safety': 'safety',
  'agent-runtimes': 'agent-runtimes',
  'agent-messages': 'agent-messages',
  'feishu-qr': 'feishu-qr',
  'cli-discovery': 'cli-discovery',
  'agent-fork-pending': 'agent-fork-pending',
  'agent-fork-context': 'agent-fork-context',
  'agent-fork-points': 'agent-fork-points',
  'agent-inputs': 'agent-inputs',
  'trim-cache': 'trim-cache',
  'muster-core': 'muster-core',
  'pi-native-sessions': 'agents/pi/sessions',
  'pi-modes': 'agents/pi/modes',
  'claude-gui-home': 'agents/claude-gui',
  'declaration-trust': 'declaration-trust',
  'turn-changes': 'turn-changes'
};

const FILE_SEGMENT = {
  "shell-api": "shell-api.json",
  "web-access": "web-access.json",
  "bg-tasks": "bg-tasks.json",
  "session-ended": "session-ended.json",
  "prompt-tasks": "prompt-tasks.json",
  "task-runs": "task-runs.json",
  "usage-stats": "usage-stats.json",
  "usage-llm-calls": "usage-llm-calls.json",
  "usage-tool-failures": "usage-tool-failures.json",
  "agent-modes": "agent-modes.json",
  "agent-models": "agent-models.json",
  "agent-thinking": "agent-thinking.json",
  "scheduler-status": "scheduler-status.json",
  "instance-ports": "instance-ports.json",
  "permission-always-rules": "permission-always-rules.json",
  "harness-model-selections": "harness-model-selections.json",
  "harness-model-catalogs": "harness-model-catalogs.json",
  "provider-model-catalogs": "provider-model-catalogs.json",
  "capability-usage": "capability-usage.json",
  "inbound-mcp-managed": "inbound-mcp-managed.json",
  "config": "config.json",
  "sessions": "sessions.json",
  "runtime-awareness": "runtime-awareness.json",
  "event-log": "event-log.sqlite",
  "session-reminders": "session-reminders.sqlite",
  "waiting-tips": "waiting-tips.json",
  "desktop-continuation-sources": "desktop/continuation-sources.sqlite",
  "browser-preload": "browser-view-preload.js",
  "devtools-port": "DevToolsActivePort"
} as const;
export type StorageFilePurpose = keyof typeof FILE_SEGMENT;

/**
 * Convert an owner identity to a filesystem leaf without aliasing two owners.
 *
 * Lowercase simple IDs keep their established paths. Any lossy, mixed-case,
 * reserved, normalized, or overlong identity carries a stable hash suffix so
 * that workspace, session, scheduler, and mailbox buckets cannot collapse on
 * case-insensitive or normalization-folding filesystems.
 */
export function safeScopedKey(value: string, maxLength = 64): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Storage scope requires a nonempty identity');
  const normalized = value.normalize('NFC');
  const clean = normalized.replace(/[^a-zA-Z0-9_-]/g, '-');
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean);
  const simple = clean === normalized && clean.length <= maxLength && !reserved && clean === clean.toLowerCase();
  if (simple) return clean;
  const prefixLength = Math.max(1, maxLength - 17);
  const prefix = (clean || 'scope').slice(0, prefixLength);
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return `${prefix}~${hash}`;
}

/** Closed registry for persistence paths that historically bypassed purpose APIs. */
export const STORAGE_PATH_MANIFEST = Object.freeze({
  'extension-development-trust': { kind: 'file', relativePath: 'extensions/development-trust.json', lifecycle: 'persistent' },
  'extension-source': { kind: 'directory', relativePath: 'extensions/global', lifecycle: 'persistent' },
  'declaration-trust': { kind: 'directory', relativePath: 'declaration-trust', lifecycle: 'persistent' },
  'board-todos': { kind: 'file', relativePath: 'board-todos.json', lifecycle: 'persistent' },
  'github-pr': { kind: 'directory', relativePath: 'github-pr', lifecycle: 'persistent' },
  'worker-target-references': { kind: 'file', relativePath: 'worker-target-references.json', lifecycle: 'persistent' },
  'process-monitor-captures': { kind: 'directory', relativePath: 'process-monitor-captures', lifecycle: 'bounded' },
  'storage-maintenance': { kind: 'directory', relativePath: '.storage-maintenance', lifecycle: 'bounded' }
} as const);
export type StoragePathManifestId = keyof typeof STORAGE_PATH_MANIFEST;

/** 旧产品落盘目录名。新分叉禁止读写这些目录下的运行时数据。 */
export const LEGACY_STORAGE_DIR_NAMES = ['metaagent-workbench', 'metaagent'] as const;

/** Match storage roots, not arbitrary project names in a path's ancestry. */
export function isLegacyStoragePath(target: string, dataRoots: readonly string[] = []): boolean {
  const normalize = (value: string): string => {
    const paths = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
    return paths.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  };
  const candidate = normalize(target);
  if (/(?:^|\/)\.metaagent(?:\/|$)/.test(candidate)) return true;
  if (/\/(?:appdata\/(?:local|roaming)|library\/application support|\.config|\.local\/share)\/(?:metaagent|metaagent-workbench)(?:\/|$)/.test(candidate)) return true;
  return dataRoots.some(dataRoot => LEGACY_STORAGE_DIR_NAMES.some(name => {
    const root = `${normalize(dataRoot)}/${name}`;
    return candidate === root || candidate.startsWith(`${root}/`);
  }));
}

/** 平台级应用数据根：worktree 等大体积数据放这里，不塞进 Roaming userData。 */
export function platformDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir = os.homedir()
): string {
  if (platform === 'win32') {
    return env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support');
  }
  return env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
}

export type StorageRootResolverOptions = {
  /** Electron `app.getPath('userData')`，dev sandbox 下可能是仓库内临时目录。 */
  userDataPath: string;
  /** Electron `app.getPath('appData')`，用于推导正式产品根。 */
  appDataPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
};

export class StorageRootResolver {
  private readonly userDataPath: string;
  private readonly appDataPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: string;

  constructor(options: StorageRootResolverOptions) {
    if (!options.userDataPath.trim()) throw new Error('Storage root requires a userData path');
    if (!options.appDataPath.trim()) throw new Error('Storage root requires an appData path');
    this.userDataPath = options.userDataPath;
    this.appDataPath = options.appDataPath;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.homedir = options.homedir ?? os.homedir();
  }

  /** 正式产品根：`<appData>/<PRODUCT_STORAGE_DIR>`，与 productStorage 的 setPath 值一致。 */
  productRoot(): string {
    return path.join(this.appDataPath, PRODUCT_STORAGE_DIR);
  }

  /** 当前进程的 userData 根（dev sandbox 重定向后可能不同于 productRoot）。 */
  userDataRoot(): string {
    return this.userDataPath;
  }

  /**
   * 按 scope + purpose 解析目录。app 级落在 userData 下；workspace/session 级
   * 额外用净化后的 scopeId 隔离，禁止 `..` 或绝对路径逃逸。
   */
  resolve(scope: StorageScope, purpose: StoragePurpose, scopeId?: string): string {
    const leaf = PURPOSE_SEGMENT[purpose];
    if (!leaf) throw new Error(`Unknown storage purpose: ${purpose}`);
    let resolved: string;
    if (scope === 'app') {
      resolved = path.join(this.userDataPath, leaf);
    } else {
      if (!scopeId?.trim()) throw new Error(`Storage scope '${scope}' requires a scopeId`);
      const safeId = safeScopedKey(scopeId);
      resolved = path.join(this.userDataPath, scope, safeId, leaf);
    }
    this.assertWritable(resolved);
    return resolved;
  }

  /** Root-level files retain the existing Muster layout; purposes are not filenames supplied by callers. */
  file(purpose: StorageFilePurpose): string {
    const leaf = FILE_SEGMENT[purpose];
    if (!leaf) throw new Error(`Unknown storage file purpose: ${purpose}`);
    const result = path.join(this.userDataPath, ...leaf.split('/'));
    this.assertWritable(result);
    return result;
  }

  /** Existing JSON registry consumers use only this closed filename catalogue. */
  fileByName(name: string): string {
    const purpose = (Object.keys(FILE_SEGMENT) as StorageFilePurpose[]).find(key => FILE_SEGMENT[key] === name);
    if (!purpose) throw new Error(`Unregistered storage filename: ${name}`);
    return this.file(purpose);
  }

  /** Resolve a registered direct-userData path without reopening ad-hoc joins. */
  manifestPath(id: StoragePathManifestId): string {
    const entry = STORAGE_PATH_MANIFEST[id];
    if (!entry) throw new Error(`Unknown storage manifest entry: ${id}`);
    const result = path.join(this.userDataPath, ...entry.relativePath.split('/'));
    this.assertWritable(result);
    return result;
  }

  /** Preserve a domain's existing trusted ID-to-leaf mapping within its purpose root. */
  scopedPath(scope: Exclude<StorageScope, 'app'>, purpose: StoragePurpose, scopeId: string, keyForId: (id: string) => string): string {
    if (scope !== 'session' && scope !== 'workspace') throw new Error('Invalid storage scope');
    if (typeof scopeId !== 'string' || !scopeId.trim()) throw new Error('Storage scope requires a nonempty identity');
    const key = keyForId(scopeId);
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.~-]{1,255}$/.test(key) || key === '.' || key === '..' || /[. ]$/.test(key)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key)) throw new Error('Invalid scoped storage key');
    const result = path.join(this.resolve('app', purpose), key);
    this.assertWritable(result);
    return result;
  }

  /** 大体积数据根：`<platform data>/<PRODUCT_STORAGE_DIR>/worktrees`。 */
  worktreesRoot(): string {
    const root = path.join(platformDataRoot(this.platform, this.env, this.homedir), PRODUCT_STORAGE_DIR, 'worktrees');
    this.assertWritable(root);
    return root;
  }

  /** 写入前守卫：拒绝任何落到旧产品根目录的路径，避免 clean-break 静默失效。 */
  assertWritable(target: string): void {
    if (isLegacyStoragePath(target, [this.appDataPath, platformDataRoot(this.platform, this.env, this.homedir)])) {
      throw new Error(`Refusing to write into legacy product storage: ${target}`);
    }
  }
}

/** 默认 worktree 根，供 `git/workspaceResolve.ts` 在无配置时使用。 */
export function defaultProductWorktreesRoot(options?: Partial<StorageRootResolverOptions>): string {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const homedir = options?.homedir ?? os.homedir();
  const appDataPath = options?.appDataPath ?? platformDataRoot(platform, env, homedir);
  const userDataPath = options?.userDataPath ?? path.join(appDataPath, PRODUCT_STORAGE_DIR);
  return new StorageRootResolver({ ...options, appDataPath, userDataPath, platform, env, homedir }).worktreesRoot();
}

/** Pure leaf-service adapter. The injected root remains authoritative (including sandbox/test roots). */
export function userDataStorage(userDataPath: string): StorageRootResolver {
  return new StorageRootResolver({ userDataPath, appDataPath: path.dirname(userDataPath) });
}
