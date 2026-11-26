import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPOSITORY = 'https://github.com/zhanghexie/muster-console';
const MAX_BODY = 64 * 1024;
const MARKER = /<!-- muster-feedback:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) -->/gi;

class RelayError extends Error {
  constructor(status, code, uncertain = false) { super(code); this.status = status; this.code = code; this.uncertain = uncertain; }
}

export function normalizeTitle(title) {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = s => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const xs = grams(x), ys = grams(y);
  const intersection = [...xs].filter(v => ys.has(v)).length;
  return xs.size + ys.size ? 2 * intersection / (xs.size + ys.size) : 0;
}

export function readConfig(env = process.env) {
  const provider = env.FEEDBACK_PROVIDER || 'github';
  if (provider !== 'gitlab' && provider !== 'github') throw new Error('FEEDBACK_PROVIDER must be gitlab or github');
  let repository;
  try { repository = new URL(env.FEEDBACK_REPOSITORY || DEFAULT_REPOSITORY); } catch { throw new Error('FEEDBACK_REPOSITORY is invalid'); }
  const parts = repository.pathname.split('/').filter(Boolean);
  if (repository.protocol !== 'https:' || repository.username || repository.password || repository.search || repository.hash || parts.length < 2 ||
      (provider === 'github' && (repository.hostname !== 'github.com' || parts.length !== 2)) ||
      parts.some(p => p === '.' || p === '..' || !/^[\p{L}\p{N}_.-]+$/u.test(p))) throw new Error('FEEDBACK_REPOSITORY must be an HTTPS repository URL');
  parts[parts.length - 1] = parts.at(-1).replace(/\.git$/i, '');
  if (!parts.at(-1)) throw new Error('FEEDBACK_REPOSITORY is invalid');
  const token = env.FEEDBACK_ISSUE_TOKEN;
  if (!token || /[\r\n]/.test(token)) throw new Error('FEEDBACK_ISSUE_TOKEN is required');
  const port = Number(env.FEEDBACK_PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FEEDBACK_PORT is invalid');
  return { target: { provider, repository: `${repository.origin}/${parts.join('/')}` }, token,
    host: env.FEEDBACK_HOST || '127.0.0.1', port };
}

function baseUrl(target) {
  const url = new URL(target.repository), parts = url.pathname.split('/').filter(Boolean);
  return target.provider === 'github'
    ? `https://api.github.com/repos/${parts.map(encodeURIComponent).join('/')}/issues`
    : `${url.origin}/api/v4/projects/${encodeURIComponent(parts.join('/'))}/issues`;
}

function parseIssue(data, target) {
  if (!data || typeof data !== 'object') throw new RelayError(502, 'upstream_response');
  const number = target.provider === 'github' ? data.number : data.iid;
  const url = target.provider === 'github' ? data.html_url : data.web_url;
  if (!Number.isSafeInteger(number) || number < 1 || typeof data.title !== 'string' || data.title.length > 512 || typeof url !== 'string') throw new RelayError(502, 'upstream_response');
  const base = new URL(target.repository);
  let link;
  try { link = new URL(url); } catch { throw new RelayError(502, 'upstream_response'); }
  const expected = `${base.pathname}${target.provider === 'github' ? '/issues/' : '/-/issues/'}${number}`;
  if (link.protocol !== 'https:' || link.origin !== base.origin || link.pathname !== expected || link.search || link.hash || link.username || link.password) throw new RelayError(502, 'upstream_response');
  return { id: String(number), title: data.title, state: String(data.state ?? ''), url, body: String((target.provider === 'github' ? data.body : data.description) ?? '') };
}

/** GitLab/GitHub tokens stay only in this process; upstream details never go to clients. */
export function createRepository(config, fetcher = fetch) {
  const { target, token } = config;
  const headers = target.provider === 'github'
    ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    : { Accept: 'application/json', 'PRIVATE-TOKEN': token };
  async function request(url, init = {}, create = false) {
    let response;
    try { response = await fetcher(url, { ...init, headers: { ...headers, ...init.headers }, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new RelayError(502, 'upstream_unavailable', create); }
    if (!response.ok) throw new RelayError(502, 'upstream_rejected', create && (response.status >= 500 || response.status === 408));
    try {
      const text = await response.text();
      if (text.length > 12_000_000) throw new Error('too large');
      return JSON.parse(text);
    } catch { throw new RelayError(502, 'upstream_response', create); }
  }
  return {
    async list() {
      const result = [];
      for (let page = 1; page <= 50; page++) {
        const rows = await request(`${baseUrl(target)}?state=all&per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new RelayError(502, 'upstream_response');
        for (const row of rows) {
          if (target.provider === 'github' && row && typeof row === 'object' && 'pull_request' in row) continue;
          result.push(parseIssue(row, target));
        }
        if (rows.length < 100) return result;
      }
      throw new RelayError(503, 'too_many_issues');
    },
    async create(title, body) {
      const data = await request(baseUrl(target), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.provider === 'github' ? { title, body } : { title, description: body }) }, true);
      try { return parseIssue(data, target); } catch { throw new RelayError(502, 'upstream_response', true); }
    }
  };
}

function validateTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || !normalizeTitle(value)) throw new RelayError(400, 'invalid_title');
  return value;
}
function safeIssue(item, marker) {
  return { id: item.id, title: item.title, state: item.state, url: item.url,
    body: marker && item.body.includes(`<!-- muster-feedback:${marker} -->`) ? `<!-- muster-feedback:${marker} -->` : '' };
}
function snapshot(issues) {
  return JSON.stringify(issues.map(({ id, title, state, url }) => [id, title, state, url]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
async function matches(repo, title, marker) {
  const issues = (await repo.list()).filter(item => titleSimilarity(title, item.title) >= 0.62 ||
    (marker && item.body.includes(`<!-- muster-feedback:${marker} -->`)));
  if (issues.length > 500) throw new RelayError(503, 'too_many_matches');
  return issues.map(item => safeIssue(item, marker));
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new RelayError(415, 'content_type');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new RelayError(413, 'too_large'); chunks.push(chunk); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new RelayError(400, 'invalid_json'); }
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

export function createFeedbackRelay(config, repo = createRepository(config)) {
  let queue = Promise.resolve();
  const requests = new Map();
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') { send(res, 200, { ok: true }); return; }
      if (req.method !== 'POST' || !['/v1/matches', '/v1/issues'].includes(req.url)) throw new RelayError(404, 'not_found');
      const now = Date.now(), client = req.socket.remoteAddress ?? 'unknown';
      for (const [key, value] of requests) if (value.until <= now) requests.delete(key);
      if (requests.size >= 10_000 && !requests.has(client)) throw new RelayError(429, 'rate_limited');
      const limit = requests.get(client) ?? { count: 0, until: now + 60_000 };
      if (++limit.count > 120) throw new RelayError(429, 'rate_limited');
      requests.set(client, limit);
      const data = await readJson(req), title = validateTitle(data.title);
      if (req.url === '/v1/matches') {
        if (data.marker !== undefined && (typeof data.marker !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.marker))) throw new RelayError(400, 'invalid_marker');
        send(res, 200, { target: config.target, issues: await matches(repo, title, data.marker) });
        return;
      }
      if (!data.target || data.target.provider !== config.target.provider || data.target.repository !== config.target.repository || !Array.isArray(data.seen) || data.seen.length > 500 ||
          data.seen.some(item => !item || typeof item !== 'object' || ['id', 'title', 'state', 'url'].some(key => typeof item[key] !== 'string'))) throw new RelayError(409, 'matches_changed');
      if (typeof data.body !== 'string' || data.body.length > 45_000) throw new RelayError(400, 'invalid_body');
      const markers = [...data.body.matchAll(MARKER)];
      if (markers.length !== 1 || !data.body.endsWith(markers[0][0])) throw new RelayError(400, 'invalid_marker');
      const prior = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await prior;
      try {
        const current = await matches(repo, title);
        if (snapshot(current) !== snapshot(data.seen) || current.some(item => normalizeTitle(item.title) === normalizeTitle(title))) throw new RelayError(409, 'matches_changed');
        const issue = await repo.create(title, data.body);
        send(res, 201, { issue: safeIssue(issue) });
      } finally { release(); }
    } catch (error) {
      const result = error instanceof RelayError ? error : new RelayError(500, 'internal_error');
      if (!res.headersSent) send(res, result.status, { code: result.code, uncertain: result.uncertain });
      else res.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    createFeedbackRelay(config).listen(config.port, config.host, () => console.log(`Feedback relay listening on ${config.host}:${config.port}`));
  } catch (error) { console.error(`Feedback relay cannot start: ${error.message}`); process.exitCode = 1; }
}
