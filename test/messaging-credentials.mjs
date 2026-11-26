import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-im-credentials-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { MessagingCredentialStore } = await import(pathToFileURL(compile('main/messaging/credentialStore.ts')).href);
const key = randomBytes(32);
const cipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) {
    const iv = randomBytes(12), aes = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([aes.update(value, 'utf8'), aes.final()]);
    return Buffer.concat([iv, aes.getAuthTag(), body]);
  },
  decryptString(value) {
    const aes = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    aes.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([aes.update(value.subarray(28)), aes.final()]).toString('utf8');
  }
};
function fixture(platform = 'darwin', overrides = {}) {
  const file = path.join(fs.mkdtempSync(path.join(temp, 'case-')), 'credentials.json');
  return { file, store: new MessagingCredentialStore({ file, platform, cipher: { ...cipher, ...overrides } }) };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: encrypted references survive restart and remain account scoped`, async () => {
    const { file, store } = fixture(platform);
    assert.deepEqual(await store.describe('slack:one'), { configured: false });
    assert.equal(fs.existsSync(file), false);
    await store.set('slack:one', 'synthetic-secret-one');
    await store.set('telegram:two', 'synthetic-secret-two');
    assert.equal(fs.readFileSync(file, 'utf8').includes('synthetic-secret'), false);
    const reopened = new MessagingCredentialStore({ file, platform, cipher });
    assert.equal((await reopened.resolve('slack:one')).value, 'synthetic-secret-one');
    assert.deepEqual(await reopened.describe('slack:one'), { configured: true, source: 'muster-secure-storage' });
    await reopened.unset('slack:one');
    assert.equal(await reopened.resolve('slack:one'), undefined);
    assert.equal((await reopened.resolve('telegram:two')).value, 'synthetic-secret-two');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
}

test('unavailable keychains and Linux plaintext backends fail without writing a secret', async () => {
  for (const [platform, overrides] of [
    ['win32', { isEncryptionAvailable: () => false }],
    ['darwin', { isEncryptionAvailable: () => false }],
    ['linux', { getSelectedStorageBackend: () => 'basic_text' }],
    ['linux', { getSelectedStorageBackend: () => 'unknown' }],
    ['linux', { getSelectedStorageBackend: undefined }]
  ]) {
    const { file, store } = fixture(platform, overrides);
    await assert.rejects(store.set('bot:token', 'synthetic-secret'));
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await store.describe('bot:token'), { configured: false });
  }
});

test('corrupt or future-version stores are preserved rather than overwritten', async () => {
  for (const text of ['{broken', '{"version":2,"entries":{}}', '{"version":1,"entries":{"bad/ref":"YQ=="}}']) {
    const { file, store } = fixture();
    fs.writeFileSync(file, text);
    await assert.rejects(store.set('bot:token', 'new-secret'));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('failed encryption and atomic publication preserve the last committed reference', async () => {
  const { file, store } = fixture();
  await store.set('bot:token', 'old-secret');
  const before = fs.readFileSync(file, 'utf8');
  const failing = new MessagingCredentialStore({ file, platform: 'darwin', cipher: { ...cipher, encryptString: () => Buffer.alloc(0) } });
  await assert.rejects(failing.set('bot:token', 'new-secret'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  await assert.rejects(store.set('bot:token', 'uncommitted-secret'));
  assert.equal((await store.resolve('bot:token')).value, 'old-secret');
});

test('invalid refs, oversized secrets and unreadable ciphertext fail explicitly', async () => {
  const { file, store } = fixture();
  await assert.rejects(store.set('../escape', 'secret'));
  await assert.rejects(store.set('token', 'x'.repeat(1024 * 1024 + 1)));
  await store.set('token', 'secret');
  const broken = new MessagingCredentialStore({ file, platform: 'darwin', cipher: { ...cipher, decryptString: () => { throw new Error('sensitive-data'); } } });
  await assert.rejects(broken.resolve('token'), error => !error.message.includes('sensitive-data') && error.message.includes('解密'));
  assert.equal((await broken.describe('token')).configured, true);
});
