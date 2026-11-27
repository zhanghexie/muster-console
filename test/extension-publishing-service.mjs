import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createExtensionPublishingService } from '../scripts/extension-publishing-service.mjs';
import { uploadExtensionSubmission } from '../scripts/upload-extension-submission.mjs';
import { reviewExtensionSubmission } from '../scripts/review-extension-submission.mjs';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-publishing-test-'));
let server;
try {
  const remote = path.join(temp, 'author.git');
  const reviewersFile = path.join(temp, 'reviewers.json');
  const artifact = path.join(temp, 'xiangqi-release.json');
  const repository = 'https://github.com/author/xiangqi';
  await fs.writeFile(reviewersFile, '[2]');
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  const packed = JSON.parse(execFileSync(process.execPath, ['scripts/pack-extension-release.mjs', 'resources/extensions/xiangqi', artifact], { encoding: 'utf8' }));
  assert.equal(packed.icon, 'builtin-extension:games');
  const fixture = await createExtensionPublishingService({ directory: path.join(temp, 'private'), origin: 'http://127.0.0.1:0', reviewersFile,
    clientId: 'fixture-client', clientSecret: 'fixture-secret', fetchImpl: async (url, options) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        assert.equal(options.body.get('code'), 'fixture-code');
        assert.equal(typeof options.body.get('code_verifier'), 'string');
        return Response.json({ access_token: 'fixture-user-token' });
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: 1, login: 'author' });
      assert.equal(url, 'https://api.github.com/repos/author/xiangqi');
      assert.equal(options.headers.Authorization, 'Bearer fixture-user-token');
      return Response.json({ id: 3, owner: { id: 1 }, visibility: 'public', default_branch: 'main' });
    }, upload: args => uploadExtensionSubmission({ ...args, token: undefined, transport: remote }),
    review: args => reviewExtensionSubmission({ ...args,
      readTags: async () => execFileSync('git', ['ls-remote', '--tags', remote], { encoding: 'utf8' }),
      fetchImpl: async url => new Response(execFileSync('git', ['--git-dir', remote, 'show', `${url.searchParams.get('ref')}:releases/${args.version}.json`])),
    }) });
  server = fixture.server;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, token, data) => fetch(origin + route, { method: data === undefined ? 'GET' : 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {}, body: data === undefined ? undefined : JSON.stringify(data) });
  const start = await (await request('/login/start', null, {})).json();
  const authorization = new URL(start.url);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(await (await request(`/login/callback?state=${authorization.searchParams.get('state')}&code=fixture-code`)).text(), /GitHub connected/);
  const { token: author } = await (await request('/login/finish', null, { poll: start.poll })).json();
  assert.equal((await request('/login/finish', null, { poll: start.poll })).status, 403);
  const reviewer = fixture.issueSession({ id: 2, login: 'reviewer' });
  assert.equal((await request('/review', author)).status, 403);
  const input = { repository, version: '1.0.0', artifact: await fs.readFile(artifact, 'utf8') };
  const submitted = await request('/submit', author, input);
  assert.equal(submitted.status, 200, await submitted.clone().text());
  const { id, commit } = await submitted.json();
  const duplicate = await (await request('/submit', author, input)).json();
  assert.equal(duplicate.id, id);
  assert.equal(duplicate.commit, commit);
  const getReview = async () => {
    for (let retry = 0; retry < 40; retry++) {
      const response = await request(`/review/${id}`, reviewer);
      if (response.ok) return response.json();
      await delay(75);
    }
    throw new Error(`Candidate was not ready: ${await (await request('/mine', author)).text()}`);
  };
  const { report } = await getReview();
  const sha256 = report.release.sha256;
  assert.deepEqual((await (await request('/catalog.json')).json()).releases, []);
  assert.equal((await request(`/packages/${id}.json`)).status, 404);
  assert.equal((await request(`/review/${id}/package`, author)).status, 403);
  assert.equal((await request(`/review/${id}/approve`, reviewer, { sha256 })).status, 409);
  assert.equal((await request(`/review/${id}/trial`, reviewer, { sha256: 'wrong' })).status, 409);
  assert.equal(await (await request(`/review/${id}/package`, reviewer)).text(), input.artifact);
  assert.equal((await request(`/review/${id}/trial`, reviewer, { sha256 })).status, 200);
  assert.equal((await getReview()).trialed, true);
  await fs.writeFile(reviewersFile, '[]');
  assert.equal((await request(`/review/${id}/approve`, reviewer, { sha256 })).status, 403);
  await fs.writeFile(reviewersFile, '[2]');
  assert.equal((await request(`/review/${id}/approve`, reviewer, { sha256 })).status, 200);
  const catalog = await (await request('/catalog.json')).json();
  assert.equal(catalog.releases[0].packageUrl, `${origin}/packages/${id}.json`);
  assert.equal(catalog.releases[0].icon, packed.icon);
  assert.equal(await (await fetch(catalog.releases[0].packageUrl)).text(), input.artifact);
  const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), path.join(temp, 'compiled'));
  const { DEFAULT_EXTENSION_CENTER_URL, ExtensionCenterService } = await import(pathToFileURL(compile('main/extensions/extensionCenter.ts')));
  const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')));
  const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')));
  const userData = path.join(temp, 'consumer-profile');
  const layout = new ExtensionSourceLayout({ userData });
  const consumerCatalog = new ExtensionPackageCatalog({ layout });
  const center = new ExtensionCenterService(userData, layout.globalRoot, consumerCatalog, { catalogUrl: DEFAULT_EXTENSION_CENTER_URL,
    token: 'official-only-token', communityCatalogUrl: `${origin}/catalog.json`, fetchImpl: async (url, init) => {
      if (url === DEFAULT_EXTENSION_CENTER_URL) return Response.json({ schemaVersion: 1, releases: [] });
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      return fetch(url, init);
    } });
  assert.equal((await center.install('author/xiangqi')).installed, true);
  assert.equal((await layout.discover({ scope: 'global', extensionId: 'xiangqi' })).fingerprint, report.release.fingerprint);
  assert.equal(consumerCatalog.get('global', 'xiangqi').officialRelease, undefined);
  center.setCommunityCatalogUrl();
  assert.equal((await center.list()).some(release => release.packageKey === 'author/xiangqi'), false);
  center.setCommunityCatalogUrl(`${origin}/catalog.json`);
  assert.equal((await center.list()).some(release => release.packageKey === 'author/xiangqi'), true);
  consumerCatalog.close();
  console.log('GitHub sign-in contract, immutable Git upload, isolated reviewer authorization and approved publication passed.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
