import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FeedbackCredentialStore } from '../../../src/main/feedback/credentialStore';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('ma-feedback-credential-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
} });
const target = { provider: 'gitlab' as const, repository: 'https://gitlab.example.test/a/b' };
const xor = (data: Buffer): Buffer => Buffer.from(data.map(value => value ^ 0xaa));
const cipher = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => xor(Buffer.from(value)), decryptString: (value: Buffer) => xor(value).toString() };
function fixture(overrides: Partial<ConstructorParameters<typeof FeedbackCredentialStore>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-feedback-credential-')); roots.push(root);
  const file = path.join(root, 'feedback', 'credential.json');
  const legacy = vi.fn(async () => null as string | null), validate = vi.fn(async () => {}), changed = vi.fn();
  const options = { file, target, cipher, platform: 'win32' as const, legacy, validate, changed, ...overrides };
  return { file, legacy, validate, changed, options, store: new FeedbackCredentialStore(options) };
}

it('blocks sending when unconfigured, validates and encrypts saved tokens, and never reimports after clearing', async () => {
  const f = fixture();
  expect(await f.store.status()).toEqual({ configured: false });
  expect(await f.store.get()).toBeNull();
  expect(await f.store.save('private-test-token')).toEqual({ configured: true });
  expect(f.validate).toHaveBeenCalledWith(target, 'private-test-token');
  expect(fs.readFileSync(f.file, 'utf8')).not.toContain('private-test-token');
  expect(await new FeedbackCredentialStore(f.options).get()).toBe('private-test-token');
  expect(await f.store.clear()).toEqual({ configured: false });
  f.legacy.mockResolvedValue('old-token');
  expect(await new FeedbackCredentialStore(f.options).get()).toBeNull();
  expect(f.changed).toHaveBeenCalledTimes(2);
});

it('imports an existing local credential once and does not reuse it for a changed repository', async () => {
  const f = fixture({ legacy: async () => 'legacy-test-token' });
  expect(await f.store.status()).toEqual({ configured: true });
  expect(await f.store.get()).toBe('legacy-test-token');
  expect(fs.readFileSync(f.file, 'utf8')).not.toContain('legacy-test-token');
  const migrated = new FeedbackCredentialStore({ ...f.options, target: { provider: 'github', repository: 'https://github.com/org/repo' } });
  expect(await migrated.get()).toBeNull();
});

it.each(['win32', 'darwin', 'linux'] as const)('rejects unavailable secure storage on %s without replacing the existing value', async platform => {
  const badCipher = { ...cipher, isEncryptionAvailable: () => platform === 'linux', getSelectedStorageBackend: () => 'basic_text' };
  const f = fixture({ platform, cipher: badCipher });
  await expect(f.store.save('token')).rejects.toThrow('系统安全存储不可用');
  expect(f.validate).not.toHaveBeenCalled();
  expect(await f.store.status()).toEqual({ configured: false });
});

it('keeps the previous token when validation fails and rejects damaged data', async () => {
  const f = fixture();
  await f.store.save('old-token');
  f.validate.mockRejectedValueOnce(new Error('invalid'));
  await expect(f.store.save('bad-token')).rejects.toThrow('invalid');
  expect(await f.store.get()).toBe('old-token');
  fs.writeFileSync(f.file, '{bad json');
  await expect(new FeedbackCredentialStore(f.options).status()).rejects.toThrow('文件损坏');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('{bad json');
});

it('applies a later clear after an in-flight save finishes', async () => {
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const started = vi.fn();
  const f = fixture({ validate: async () => { started(); await wait; } });
  const save = f.store.save('new-token');
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
  const clear = f.store.clear();
  finish();
  await save; await clear;
  expect(await f.store.get()).toBeNull();
});
