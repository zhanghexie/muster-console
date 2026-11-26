import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PAGES_ASSET_LIMIT } from './build-extension-center-mirror.mjs';
import { compareVersions } from './extension-version-tags.mjs';
import { inspectSubmissionPackage, reviewExtensionSubmission } from './review-extension-submission.mjs';
import { extensionRepository, uploadExtensionSubmission } from './upload-extension-submission.mjs';

const secret = () => randomBytes(32).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hour = 60 * 60 * 1000;
const gitHub = 'https://api.github.com';
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > PAGES_ASSET_LIMIT + 64 * 1024) throw new RequestError(413, 'Extension package is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid publishing request'); }
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new RequestError(response.status === 404 || response.status === 403 ? 403 : 502, 'GitHub could not verify access');
  return response.json();
}

/** The state directory belongs to the publishing operator. Only approved packages have a public route. */
export async function createExtensionPublishingService({ directory, origin, reviewersFile, clientId, clientSecret, appSlug,
  fetchImpl = fetch, upload = uploadExtensionSubmission, review = reviewExtensionSubmission }) {
  const base = new URL(origin);
  if (base.href !== `${base.origin}/` || (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1'))) {
    throw new Error('Publishing origin must be an HTTPS origin or a loopback HTTP origin');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'submissions.json');
  const rows = await fs.readFile(stateFile, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const sessions = new Map(), logins = new Map(), states = new Map();
  let tail = Promise.resolve();
  const serialize = action => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
  async function save(next) {
    const temp = `${stateFile}.${randomUUID()}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, stateFile);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async function update(row, patch) {
    await save(rows.map(item => item === row ? { ...row, ...patch } : item));
    Object.assign(row, patch);
  }
  const folder = row => path.join(directory, row.id);
  const reviewFolder = row => path.join(folder(row), 'review');
  const summary = row => ({ id: row.id, extensionId: row.extensionId, name: row.name, version: row.version, repository: row.repository,
    commit: row.commit, sourceFingerprint: row.sourceFingerprint, status: row.status, ...(row.reason ? { reason: row.reason } : {}) });
  const isReviewer = async actor => Boolean(actor && JSON.parse(await fs.readFile(reviewersFile, 'utf8')).includes(actor.id));
  const activeSession = request => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    const session = token && sessions.get(token);
    return session && session.expires > Date.now() ? session : undefined;
  };
  const issueSession = actor => {
    const token = secret();
    sessions.set(token, { ...actor, expires: Date.now() + 8 * hour });
    return token;
  };

  async function check(row) {
    try {
      await fs.mkdir(folder(row), { recursive: true, mode: 0o700 });
      let checked;
      for (let attempt = 0; ; attempt++) {
        await fs.rm(reviewFolder(row), { recursive: true, force: true });
        try { checked = await review({ repository: row.repository, version: row.version, commit: row.commit, output: reviewFolder(row) }); break; }
        catch (error) {
          if (attempt === 3 || !/HTTP (404|502|503)|Release tag does not point/.test(error.message)) throw error;
          await delay(1500);
        }
      }
      if (checked.release.sha256 !== row.sha256 || checked.release.extensionId !== row.extensionId) throw new Error('GitHub package does not match the submitted bytes');
      await serialize(() => update(row, { release: checked.release, status: 'ready' }));
    } catch (error) {
      await serialize(() => update(row, { status: 'changes', reason: error.code ? 'Candidate review storage is unavailable' : error.message }));
    }
  }
  const resume = row => void check(row).catch(error => console.error('Extension review state could not be saved:', error.message));

  async function submit(actor, input) {
    const repository = extensionRepository(input?.repository);
    const info = await githubJson(`${gitHub}/repos${repository.pathname}`, actor.githubToken, fetchImpl);
    if (info.private || info.visibility !== 'public' || info.archived || info.owner?.id !== actor.id) throw new RequestError(403, 'Use a public repository owned by your GitHub account');
    if (!/^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/.test(input?.version) || typeof input.artifact !== 'string') throw new RequestError(400, 'Invalid version or package');
    const bytes = Buffer.from(input.artifact, 'utf8');
    const { manifest, snapshot } = await inspectSubmissionPackage(bytes, input.version, { checkSyntax: false });
    const digest = sha256(bytes);
    return serialize(async () => {
      const same = rows.filter(row => row.extensionId === manifest.id);
      if (same.some(row => row.repositoryId !== info.id || row.author !== actor.id)) throw new RequestError(409, 'This extension ID already belongs to another publisher or repository');
      const identical = same.find(row => row.sha256 === digest);
      if (identical) return summary(identical);
      const previous = same.sort((a, b) => compareVersions(b.version, a.version))[0];
      if (previous && compareVersions(input.version, previous.version) <= 0) throw new RequestError(409, 'Submit a new version for changed contents');
      const { commit } = await upload({ repositoryUrl: repository.href, branch: info.default_branch, token: actor.githubToken,
        previous, manifest, snapshot, bytes });
      const row = { id: randomUUID(), repositoryId: info.id, repository: repository.href, author: actor.id, extensionId: manifest.id,
        sourceFingerprint: /^package-extension:[0-9a-f]{64}$/.test(input.sourceFingerprint) ? input.sourceFingerprint : undefined,
        name: manifest.name, version: input.version, sha256: digest, commit, status: 'checking' };
      await save([...rows, row]);
      rows.push(row);
      resume(row);
      return summary(row);
    });
  }

  const packageBytes = async row => {
    const bytes = await fs.readFile(path.join(reviewFolder(row), 'candidate.json'));
    if (sha256(bytes) !== row.sha256) throw new RequestError(409, 'Candidate bytes changed');
    return bytes;
  };
  const json = (response, value) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
  };
  async function route(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(request.url, base);
    const target = url.pathname;
    const method = request.method;
    const callback = `${base.origin}/login/callback`;
    if (method === 'POST' && target === '/login/start') {
      if (!clientId || !clientSecret) throw new RequestError(503, 'GitHub App sign-in is not configured');
      for (const [key, value] of logins) if (value.expires <= Date.now()) { logins.delete(key); states.delete(value.state); }
      for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
      if (logins.size >= 512) throw new RequestError(429, 'Try signing in again in a few minutes');
      const state = secret(), poll = secret(), verifier = secret();
      logins.set(poll, { state, verifier, expires: Date.now() + 10 * 60 * 1000 }); states.set(state, poll);
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, state,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      return json(response, { url: authorize.href, poll });
    }
    if (method === 'GET' && target === '/login/callback') {
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      const login = logins.get(states.get(state));
      states.delete(state);
      if (!login || login.expires <= Date.now()) throw new RequestError(403, 'Sign-in expired. Return to Muster and try again.');
      try {
        if (!code) throw new Error('GitHub sign-in was cancelled');
        const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', { method: 'POST',
          headers: { Accept: 'application/json' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
            redirect_uri: callback, code, code_verifier: login.verifier }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
        const { access_token: githubToken } = await tokenResponse.json();
        if (!tokenResponse.ok || !githubToken) throw new Error('GitHub sign-in could not be completed');
        const { id, login: account } = await githubJson(`${gitHub}/user`, githubToken, fetchImpl);
        login.session = issueSession({ id, login: account, githubToken });
      } catch (error) { login.error = error.message; }
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return response.end(login.error ?? 'GitHub connected. Return to Muster.');
    }
    if (method === 'POST' && target === '/login/finish') {
      const { poll } = await readBody(request);
      const login = logins.get(poll);
      if (!login || login.expires <= Date.now()) throw new RequestError(403, 'Sign-in expired');
      if (login.session || login.error) logins.delete(poll);
      if (login.error) throw new RequestError(403, login.error);
      return json(response, { token: login.session });
    }

    if (method === 'GET' && target === '/catalog.json') {
      const latest = new Map();
      for (const row of rows.filter(row => row.status === 'published')) {
        const previous = latest.get(row.extensionId);
        if (!previous || compareVersions(row.version, previous.version) > 0) latest.set(row.extensionId, row);
      }
      return json(response, { schemaVersion: 1, releases: [...latest.values()].map(row => ({ ...row.release,
        packageUrl: `${base.origin}/packages/${row.id}.json`, previousFingerprints: rows.filter(other => other.extensionId === row.extensionId &&
          other.status === 'published' && compareVersions(other.version, row.version) < 0).map(other => other.release.fingerprint).slice(-100) })) });
    }
    const publicPackage = /^\/packages\/([a-f0-9-]{36})\.json$/.exec(target);
    if (method === 'GET' && publicPackage) {
      const row = rows.find(row => row.id === publicPackage[1] && row.status === 'published');
      if (!row) throw new RequestError(404, 'Package unavailable');
      response.setHeader('Content-Type', 'application/json');
      return response.end(await packageBytes(row));
    }
    const actor = activeSession(request);
    if (method === 'GET' && target === '/session') return json(response, { login: actor?.login, reviewer: await isReviewer(actor),
      ...(appSlug ? { installUrl: `https://github.com/apps/${appSlug}/installations/new` } : {}) });
    if (!actor) throw new RequestError(401, 'Sign in to GitHub first');
    if (method === 'GET' && target === '/mine') return json(response, rows.filter(row => row.author === actor.id).map(summary));
    if (method === 'POST' && target === '/submit') return json(response, await submit(actor, await readBody(request)));
    if (!await isReviewer(actor)) throw new RequestError(403, 'Extension reviewer access required');
    if (method === 'GET' && target === '/review') return json(response, rows.filter(row => row.status === 'ready').map(summary));
    const match = /^\/review\/([a-f0-9-]{36})(?:\/(package|trial|approve|return))?$/.exec(target);
    const row = match && rows.find(row => row.id === match[1]);
    if (!row || row.status !== 'ready') throw new RequestError(404, 'Candidate is unavailable');
    const action = match[2];
    if (method === 'GET' && !action) {
      const report = JSON.parse(await fs.readFile(path.join(reviewFolder(row), 'review.json'), 'utf8'));
      const previous = rows.filter(item => item.extensionId === row.extensionId && item.status === 'published' && compareVersions(item.version, row.version) < 0)
        .sort((a, b) => compareVersions(b.version, a.version))[0];
      const preceding = previous && JSON.parse(await fs.readFile(path.join(reviewFolder(previous), 'review.json'), 'utf8'));
      return json(response, { ...summary(row), report, trialed: row.trial?.reviewer === actor.id && row.trial.sha256 === row.sha256,
        ...(previous ? { previous: { version: previous.version, commit: previous.commit, permissions: preceding.permissions } } : {}) });
    }
    if (method === 'GET' && action === 'package') {
      response.setHeader('Content-Type', 'application/json');
      return response.end(await packageBytes(row));
    }
    if (method !== 'POST') throw new RequestError(404, 'Unknown publishing route');
    const input = await readBody(request);
    return serialize(async () => {
      if (!await isReviewer(actor)) throw new RequestError(403, 'Extension reviewer access required');
      if (row.status !== 'ready' || input.sha256 !== row.sha256) throw new RequestError(409, 'Candidate changed');
      if (action === 'trial') await update(row, { trial: { reviewer: actor.id, sha256: row.sha256, at: new Date().toISOString() } });
      else if (action === 'approve') {
        if (row.trial?.reviewer !== actor.id || row.trial.sha256 !== row.sha256) throw new RequestError(409, 'Install the exact candidate before approving');
        if (rows.some(other => other.extensionId === row.extensionId && other.status === 'published' && compareVersions(other.version, row.version) >= 0)) {
          throw new RequestError(409, 'A newer version is already published');
        }
        await packageBytes(row);
        await update(row, { status: 'published', approved: { reviewer: actor.id, at: new Date().toISOString(), sha256: row.sha256 } });
      } else if (action === 'return') {
        if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new RequestError(400, 'Enter a reason for returning the candidate');
        await update(row, { status: 'changes', reason: input.reason.trim() });
      } else throw new RequestError(404, 'Unknown publishing route');
      return json(response, summary(row));
    });
  }

  const server = createServer((request, response) => void route(request, response).catch(error => {
    if (response.headersSent) { response.destroy(); return; }
    response.statusCode = error.status ?? 400;
    json(response, { error: error.code ? 'Publishing storage is unavailable' : error.message });
  }));
  if (base.port === '0') server.once('listening', () => { base.port = String(server.address().port); });
  server.once('listening', () => {
    for (const row of rows) if (row.status === 'checking') resume(row);
  });
  return { server, issueSession };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { MUSTER_PUBLISH_ORIGIN: origin, MUSTER_PUBLISH_DATA: directory, MUSTER_PUBLISH_REVIEWERS_FILE: reviewersFile,
    MUSTER_PUBLISH_GITHUB_CLIENT_ID: clientId, MUSTER_PUBLISH_GITHUB_CLIENT_SECRET: clientSecret, MUSTER_PUBLISH_GITHUB_APP: appSlug,
    MUSTER_PUBLISH_PORT: port = '8791' } = process.env;
  if (!origin || !directory || !reviewersFile || !clientId || !clientSecret) throw new Error('Configure the publishing origin, storage, reviewer IDs and GitHub App');
  const { server } = await createExtensionPublishingService({ directory, origin, reviewersFile, clientId, clientSecret, appSlug });
  if (process.send) {
    if (!process.connected) process.exit(0);
    process.once('disconnect', () => {
      server.close(error => { if (error) process.exitCode = 1; });
    });
    server.once('error', error => {
      process.exitCode = 1;
      if (process.connected) process.send({ type: 'extension-publishing-error', code: error.code }, () => {
        if (process.connected) process.disconnect();
      });
    });
  }
  server.listen(Number(port), '127.0.0.1', () => {
    if (process.connected) process.send?.({ type: 'extension-publishing-ready' });
    else if (!process.send) console.log(`Extension publishing service listening on loopback port ${port}`);
  });
}
