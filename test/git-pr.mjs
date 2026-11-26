/** Native GitHub App device authorization and REST/GraphQL, without a real account. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-pr-api-'));
const compile = createSharedCompiler(root, tmp);
const load = file => import(pathToFileURL(compile(file)).href);

try {
  const { GitHubAppAuth } = await load('main/git/githubAppAuth.ts');
  const { configuredGitHubApp, defaultGitHubApp, resolveGitHubApp } = await load('main/git/githubAppConfig.ts');
  const { GitHubPrStorage } = await load('main/git/githubPrStorage.ts');
  const { GitHubPrClient } = await load('main/git/githubPrClient.ts');
  const { repositoryFromGitRemote } = await load('main/git/githubRepository.ts');
  const ok = (body, headers) => new Response(JSON.stringify(body), { headers });
  const version = { repository: 'team/project', number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
  for (const url of ['git@github.com:team/project.git', 'https://github.com/team/project.git', 'ssh://git@ssh.github.com:443/team/project.git']) {
    assert.equal(repositoryFromGitRemote(url), version.repository);
  }
  for (const url of ['git@elsewhere:team/project.git', 'https://github.com.example.com/team/project', '/private/project.git', 'https://github.com/team/project/other']) {
    assert.equal(repositoryFromGitRemote(url), null);
  }
  const app = configuredGitHubApp('Iv1.1234567890abcdef', 'muster-review');
  assert.deepEqual(app, { clientId: 'Iv1.1234567890abcdef', slug: 'muster-review' });
  const officialApp = { clientId: 'Iv23li38wcr7NdVRUeV3', slug: 'muster-console' };
  assert.deepEqual(defaultGitHubApp(), officialApp);
  assert.deepEqual(defaultGitHubApp(undefined, undefined, '', ''), officialApp, 'empty CI variables must preserve the official App');
  assert.deepEqual(defaultGitHubApp(undefined, undefined, app.clientId, app.slug), app);
  assert.equal(defaultGitHubApp('', ''), null, 'a runtime opt-out remains available for self-hosted builds');
  assert.equal(defaultGitHubApp(app.clientId, undefined, officialApp.clientId, officialApp.slug), null, 'do not mix separate App identities');
  assert.ok(configuredGitHubApp('Iv23sampleIdentifier', 'muster-review'));
  const publicApp = { clientId: 'Iv1.aaaaaaaaaaaaaaaa', slug: 'public-app' };
  const publicLookup = async (url, init) => {
    assert.equal(url, 'https://api.github.com/apps/public-app');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.credentials, 'omit');
    return ok({ client_id: publicApp.clientId, slug: publicApp.slug });
  };
  assert.deepEqual(await resolveGitHubApp({ app: 'https://github.com/apps/public-app/' }, publicLookup), publicApp);
  assert.deepEqual(await resolveGitHubApp({ app: 'PUBLIC-APP' }, publicLookup), publicApp);
  assert.deepEqual(await resolveGitHubApp({ app: 'https://github.com/organizations/team/settings/apps/public-app',
    clientId: publicApp.clientId }, () => { throw new Error('Private configuration does not need public discovery'); }), publicApp);
  for (const input of [{ app: 'https://github.com.evil.invalid/apps/public-app' },
    { app: 'https://user@github.com/apps/public-app' }, { app: 'https://github.com/settings/apps/new' },
    { app: 'public-app', clientId: 'ghp_not_a_client_id' }]) {
    await assert.rejects(resolveGitHubApp(input, () => { throw new Error('Invalid input must fail locally'); }), error => error.kind === 'configuration');
  }
  await assert.rejects(resolveGitHubApp({ app: 'private-app' }, async () => new Response(null, { status: 404 })), error => error.kind === 'appLookup');
  let now = 100;
  let saved;
  let pollCount = 0;
  let refreshCount = 0;
  const auth = new GitHubAppAuth({ app, readApp: () => null, saveApp: () => {}, read: () => saved ?? null, save: value => { saved = value; },
    assertStorage() {}, now: () => now, fetcher: async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (url.endsWith('/login/device/code')) {
        return ok({ device_code: 'host-only-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device',
          expires_in: 900, interval: 5 });
      }
      if (url.endsWith('/user')) {
        assert.equal(init.headers.Authorization, 'Bearer access-one');
        return ok({ login: 'developer' });
      }
      if (init.body.get('grant_type') === 'refresh_token') {
        refreshCount++;
        assert.equal(init.body.get('refresh_token'), 'refresh-one');
        return ok({ access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 3600 });
      }
      assert.equal(init.body.get('device_code'), 'host-only-code');
      assert.equal(init.body.has('client_secret'), false);
      if (++pollCount === 1) return ok({ error: 'authorization_pending' });
      if (pollCount === 2) return ok({ error: 'slow_down', interval: 13 });
      return ok({ access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 3600 });
    } });
  assert.deepEqual(await auth.connection(), { state: 'signedOut' });
  const pending = await auth.authorize();
  assert.equal(pending.state, 'pending');
  assert.equal(pending.userCode, 'ABCD-1234');
  assert.equal(JSON.stringify(pending).includes('host-only-code'), false);
  await auth.connection();
  assert.equal(pollCount, 0);
  now += 5000;
  await Promise.all([auth.connection(), auth.connection()]);
  assert.equal(pollCount, 1);
  now += 5000;
  await auth.connection();
  now += 12999;
  await auth.connection();
  assert.equal(pollCount, 2);
  now += 1;
  assert.deepEqual(await auth.connection(), { state: 'connected', login: 'developer' });
  assert.equal(saved.access, 'access-one');
  now += 3_595_000;
  const refreshed = await Promise.all([auth.credentials(), auth.credentials()]);
  assert.equal(refreshCount, 1);
  assert.ok(refreshed.every(entry => entry.token === 'access-two'));
  auth.disconnect();
  assert.equal(saved, null);
  assert.deepEqual(await auth.connection(), { state: 'signedOut' });

  const cipher = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: text => Buffer.from([...text].reverse().join('')), decryptString: bytes => [...bytes.toString()].reverse().join('') };
  for (const platform of ['win32', 'darwin', 'linux']) {
    const folder = path.join(tmp, platform);
    const state = new GitHubPrStorage(folder, cipher, platform);
    state.saveSession({ clientId: app.clientId, login: 'developer', access: 'test-credential', refresh: '', expiresAt: null });
    assert.equal(state.session().access, 'test-credential');
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, platform, 'session'), 'utf8'), /test-credential/);
    state.saveAppConfig(app, false);
    state.saveSession(null);
    assert.equal(state.session(), null);
    assert.deepEqual(new GitHubPrStorage(folder, cipher, platform).appConfig(), app);
  }
  const plain = new GitHubPrStorage(path.join(tmp, 'plain'), { ...cipher, getSelectedStorageBackend: () => 'basic_text' }, 'linux');
  assert.throws(() => plain.assertStorage(), /Secret Service/);
  assert.equal(fs.existsSync(path.join(tmp, 'plain')), false);

  const settingsRoot = path.join(tmp, 'settings');
  fs.mkdirSync(settingsRoot);
  const original = { clientId: app.clientId, login: 'developer', access: 'prior-credential', refresh: '', expiresAt: null };
  fs.writeFileSync(path.join(settingsRoot, 'session'), cipher.encryptString(JSON.stringify(original)).toString('base64'));
  const optionsFor = (storage, saveApp = (value, clearSession) => storage.saveAppConfig(value, clearSession)) => ({
    app, fetcher: publicLookup, readApp: () => storage.appConfig(), saveApp,
    read: () => storage.session(), save: value => storage.saveSession(value), assertStorage: () => storage.assertStorage()
  });
  const storage = new GitHubPrStorage(settingsRoot, cipher, 'darwin');
  const account = new GitHubAppAuth(optionsFor(storage));
  assert.deepEqual(account.appSetup(), { active: app, source: 'default', hasDefault: true });
  assert.deepEqual(await account.connection(), { state: 'connected', login: 'developer' });
  const failedWrite = new GitHubAppAuth(optionsFor(storage, () => { throw new Error('fixture write failure'); }));
  await assert.rejects(failedWrite.configureApp({ app: 'public-app' }), /fixture write failure/);
  assert.equal((await failedWrite.credentials()).token, original.access);
  const previousGeneration = (await account.credentials()).generation;
  assert.deepEqual(await account.configureApp({ app: 'https://github.com/apps/public-app' }), { state: 'signedOut' });
  assert.throws(() => account.assertCurrent(previousGeneration), /连接已变化/);
  assert.equal(storage.session(), null);
  const restarted = new GitHubPrStorage(settingsRoot, cipher, 'darwin');
  const reloaded = new GitHubAppAuth(optionsFor(restarted));
  assert.deepEqual(reloaded.appSetup(), { active: publicApp, source: 'custom', hasDefault: true });
  assert.deepEqual(await reloaded.configureApp(null), { state: 'signedOut' });
  assert.deepEqual(reloaded.appSetup(), { active: app, source: 'default', hasDefault: true });

  let currentHead = version.headSha;
  let calls = 0;
  const client = new GitHubPrClient(async (url, init) => {
    calls++;
    assert.equal(new URL(url).host, 'api.github.com');
    assert.equal(init.headers.Authorization, 'Bearer mock-credential');
    if (url.endsWith('/graphql')) {
      const { variables } = JSON.parse(init.body);
      assert.equal(variables.query, 'repo:team/project is:pr is:open review-requested:developer sort:updated-desc');
      return ok({ data: { search: { nodes: [{ repository: { nameWithOwner: version.repository },
        number: 7, state: 'OPEN', title: 'Test', baseRefName: 'main', headRefName: 'topic', reviewDecision: 'CHANGES_REQUESTED',
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }], pageInfo: { hasNextPage: true, endCursor: 'cursor' } } } });
    }
    if (url.includes('/files?')) return ok([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-x\n+y' }], { link: '<https://api.github.com/next>; rel="next"' });
    return ok({ state: 'open', head: { sha: currentHead }, base: { sha: version.baseSha } });
  }, 'mock-credential', 'developer');
  const { prs, cursor } = await client.list(version.repository, 'reviewRequested');
  assert.equal(prs[0].checks, 'failure');
  assert.equal(prs[0].reviewDecision, 'CHANGES_REQUESTED');
  assert.equal(cursor, 'cursor');
  assert.equal((await client.files(version, 2)).filesHaveMore, true);
  const before = calls;
  currentHead = 'c'.repeat(40);
  await assert.rejects(client.files(version, 2), error => error.kind === 'changed');
  assert.equal(calls, before + 1);
  console.log('git-pr: device flow, rotation, cross-platform secure storage, PR search and pinned file reads passed');
} finally {
  fs.rmSync(tmp, { force: true, recursive: true });
}
