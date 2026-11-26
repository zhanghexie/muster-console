import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  StorageRootResolver,
  defaultProductWorktreesRoot,
  isLegacyStoragePath,
  platformDataRoot,
  safeScopedKey
} from '../../src/main/runtimeKernel/storageRootResolver';
import { PRODUCT_STORAGE_DIR } from '../../src/shared/productIdentity';
import { defaultWorktreeStorageRoot } from '../../src/main/git/workspaceResolve';

const options = { userDataPath: path.join('/data', 'userData'), appDataPath: path.join('/data', 'appData') };

describe('StorageRootResolver', () => {
  it('uses stable collision-resistant keys for workspace, session, scheduler and mailbox identities', () => {
    expect(safeScopedKey('simple-id')).toBe('simple-id');
    const slash = safeScopedKey('a/b');
    expect(slash).toMatch(/^a-b~[a-f0-9]{16}$/);
    expect(slash).toBe(safeScopedKey('a/b'));
    expect(slash).not.toBe(safeScopedKey('a?b'));
    expect(safeScopedKey('Workspace')).not.toBe(safeScopedKey('workspace'));
    expect(safeScopedKey('e\u0301')).toBe(safeScopedKey('é'));
    expect(safeScopedKey('CON')).toMatch(/^CON~[a-f0-9]{16}$/);
    expect(safeScopedKey('a'.repeat(200))).toMatch(/^a{47}~[a-f0-9]{16}$/);
  });

  it('derives the product root from the shared identity contract', () => {
    const resolver = new StorageRootResolver(options);
    expect(resolver.productRoot()).toBe(path.join(options.appDataPath, PRODUCT_STORAGE_DIR));
    expect(resolver.userDataRoot()).toBe(options.userDataPath);
  });

  it('resolves app, workspace and session scopes by purpose', () => {
    const resolver = new StorageRootResolver(options);
    expect(resolver.resolve('app', 'sessions')).toBe(path.join(options.userDataPath, 'sessions'));
    expect(resolver.resolve('app', 'agent-sessions')).toBe(path.join(options.userDataPath, 'agent-sessions'));
    expect(resolver.resolve('workspace', 'memory', 'ws-1')).toBe(path.join(options.userDataPath, 'workspace', 'ws-1', 'memory'));
    expect(resolver.resolve('session', 'evidence', 's 2')).toMatch(/s-2~[a-f0-9]{16}/);
    const workspaceSlash = resolver.resolve('workspace', 'memory', 'a/b');
    const workspaceQuestion = resolver.resolve('workspace', 'memory', 'a?b');
    expect(workspaceSlash).not.toBe(workspaceQuestion);
    expect(path.basename(path.dirname(workspaceSlash))).toMatch(/^a-b~[a-f0-9]{16}$/);
    expect(resolver.resolve('session', 'evidence', 'a/b')).not.toBe(resolver.resolve('session', 'evidence', 'a?b'));
    expect(() => resolver.resolve('workspace', 'cache')).toThrow('requires a scopeId');
    const escaped = resolver.resolve('session', 'logs', '../../escape');
    expect(escaped.startsWith(options.userDataPath)).toBe(true);
    expect(escaped).not.toContain('..');
    expect(escaped).toMatch(/------escape~[a-f0-9]{16}/);
  });

  it('preserves current app files and avoids scope collisions', () => {
    const resolver = new StorageRootResolver(options);
    expect(resolver.file('config')).toBe(path.join(options.userDataPath, 'config.json'));
    expect(resolver.file('runtime-awareness')).toBe(path.join(options.userDataPath, 'runtime-awareness.json'));
    expect(resolver.file('desktop-continuation-sources')).toBe(path.join(options.userDataPath, 'desktop', 'continuation-sources.sqlite'));
    expect(resolver.resolve('app', 'browser-downloads')).toBe(path.join(options.userDataPath, 'browser-downloads'));
    expect(resolver.resolve('session', 'logs', 'id ')).not.toBe(resolver.resolve('session', 'logs', 'id'));
    expect(resolver.resolve('session', 'logs', 'a/b')).not.toBe(resolver.resolve('session', 'logs', 'a?b'));
    expect(resolver.resolve('session', 'logs', 'a'.repeat(70))).not.toBe(resolver.resolve('session', 'logs', 'a'.repeat(69)+'b'));
    const transformed = path.basename(path.dirname(resolver.resolve('session', 'logs', 'a/b')));
    expect(resolver.resolve('session', 'logs', transformed)).not.toBe(resolver.resolve('session', 'logs', 'a/b'));
    for (const id of ['CON', 'nul', 'PRN', 'AUX', 'COM1', 'LPT9']) {
      const scope = path.basename(path.dirname(resolver.resolve('session', 'logs', id)));
      expect(scope).toMatch(/~[a-f0-9]{16}$/);
      expect(scope.toLowerCase()).not.toBe(id.toLowerCase());
    }
    expect(resolver.resolve('session', 'logs', 'simple-id')).toBe(path.join(options.userDataPath, 'session', 'simple-id', 'logs'));
  });

  it('resolves direct userData paths through the closed storage manifest', () => {
    const resolver = new StorageRootResolver(options);
    expect(resolver.manifestPath('extension-development-trust')).toBe(path.join(options.userDataPath, 'extensions', 'development-trust.json'));
  expect(resolver.manifestPath('extension-source')).toBe(path.join(options.userDataPath, 'extensions', 'global'));
    expect(resolver.manifestPath('board-todos')).toBe(path.join(options.userDataPath, 'board-todos.json'));
    expect(resolver.manifestPath('worker-target-references')).toBe(path.join(options.userDataPath, 'worker-target-references.json'));
    expect(resolver.manifestPath('process-monitor-captures')).toBe(path.join(options.userDataPath, 'process-monitor-captures'));
    expect(() => resolver.manifestPath('missing' as never)).toThrow('Unknown storage manifest entry');
  });

  it('constrains existing workspace/session leaf mappings without moving their layout', () => {
    const resolver = new StorageRootResolver(options);
    expect(resolver.scopedPath('workspace', 'agent-messages', 'workspace:1', () => 'existing-hash.json')).toBe(path.join(options.userDataPath, 'agent-messages', 'existing-hash.json'));
    expect(resolver.scopedPath('session', 'agent-sessions', 'session-1', id => id + '.json')).toBe(path.join(options.userDataPath, 'agent-sessions', 'session-1.json'));
    expect(() => resolver.scopedPath('session', 'evidence', '', () => 'unused')).toThrow('nonempty');
    for (const key of ['../escape', 'nested/file', 'nested\\file', '.', '..', 'CON.json', 'nul.ndjson', 'COM1', 'trailing.', 'trailing ']) {
      expect(() => resolver.scopedPath('session', 'evidence', 'valid-id', () => key)).toThrow('Invalid scoped storage key');
    }
  });

  it('refuses legacy product directories for writes', () => {
    const resolver = new StorageRootResolver(options);
    expect(isLegacyStoragePath('C:/Users/x/AppData/Local/MetaAgent/worktrees')).toBe(true);
    expect(isLegacyStoragePath('/home/x/.config/metaagent-workbench/config.json')).toBe(true);
    expect(isLegacyStoragePath(path.join('/data', 'appData', PRODUCT_STORAGE_DIR, 'sessions'))).toBe(false);
    expect(() => resolver.assertWritable('C:/Users/x/AppData/Local/MetaAgent/worktrees')).toThrow('legacy product storage');
    expect(() => resolver.assertWritable(resolver.resolve('app', 'logs'))).not.toThrow();
  });

  it('covers win32, darwin and linux data roots', () => {
    expect(platformDataRoot('win32', { LOCALAPPDATA: 'C:/Local' }, '/home/x')).toBe('C:/Local');
    expect(platformDataRoot('win32', {}, '/home/x')).toBe(path.join('/home/x', 'AppData', 'Local'));
    expect(platformDataRoot('darwin', {}, '/home/x')).toBe(path.join('/home/x', 'Library', 'Application Support'));
    expect(platformDataRoot('linux', { XDG_DATA_HOME: '/xdg' }, '/home/x')).toBe('/xdg');
    expect(platformDataRoot('linux', {}, '/home/x')).toBe(path.join('/home/x', '.local', 'share'));
  });

  it('allows a renamed application inside an old-named source checkout on all platforms', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const base = platform === 'win32' ? 'E:/Projects/metaagent-workbench/fixture' : '/projects/metaagent-workbench/fixture';
      const resolver = new StorageRootResolver({ platform, userDataPath: `${base}/userData`, appDataPath: `${base}/appdata`,
        homedir: `${base}/home`, env: { LOCALAPPDATA: `${base}/localappdata`, XDG_DATA_HOME: `${base}/xdg` } });
      expect(() => resolver.worktreesRoot()).not.toThrow();
      expect(() => resolver.resolve('app', 'sessions')).not.toThrow();
      expect(() => resolver.assertWritable(`${base}/appdata/MetaAgent/cache`)).toThrow('legacy product storage');
      expect(() => resolver.assertWritable(`${base}/.metaAgent/local`)).toThrow('legacy product storage');
    }
    expect(isLegacyStoragePath('/Users/x/Library/Application Support/metaagent-workbench/sessions')).toBe(true);
    expect(isLegacyStoragePath('/home/x/.local/share/MetaAgent/worktrees')).toBe(true);
  });

  it('keeps worktree roots inside the new product namespace on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const root = defaultProductWorktreesRoot({ platform, env: {}, homedir: '/home/x' });
      expect(root).toContain(PRODUCT_STORAGE_DIR);
      expect(root.toLowerCase()).not.toContain('metaagent');
      expect(root.endsWith(path.join(PRODUCT_STORAGE_DIR, 'worktrees'))).toBe(true);
    }
  });

  it('regression: the default worktree root no longer writes into the old MetaAgent directory', () => {
    const root = defaultWorktreeStorageRoot();
    expect(root).toContain(PRODUCT_STORAGE_DIR);
    expect(root.toLowerCase()).not.toContain('metaagent');
    expect(root.endsWith(path.join(PRODUCT_STORAGE_DIR, 'worktrees'))).toBe(true);
  });
});
