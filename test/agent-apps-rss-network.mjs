import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-network-'));
const originalGet = https.get;
const xml = '<rss><channel><item><title>OpenAI news</title><guid>one</guid></item></channel></rss>';
const url = 'https://openai.com/news/rss.xml';
const configured = [], nativeRequests = [];
globalThis.__rssElectronSession = {
  defaultSession: { resolveProxy: async () => 'PROXY 127.0.0.1:7890; DIRECT' },
  fromPartition: (partition, options) => ({
    setProxy: async config => configured.push({ partition, options, config }),
    fetch: async (target, init) => { nativeRequests.push({ target, init }); return new Response(xml); }
  })
};
try {
  const outfile = path.join(folder, 'fixture.cjs');
  buildSync({ stdin: { contents: `
    export { fetchFeed, isPublicAddress, parseFeed, parseFeedBatch } from './src/main/agentApps/connectors';
    export { selectFeedProxy, createSystemFeedProxy, hasFakeIpTunnel } from './src/main/agentApps/feedProxy';
  `, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['electron'] });
  // Electron is a runtime-only dependency; require the fixture with a controlled module boundary.
  const Module = createRequire(import.meta.url)('node:module'), oldLoad = Module._load;
  let exports;
  try {
    Module._load = function (id, ...args) { return id === 'electron' ? { session: globalThis.__rssElectronSession } : oldLoad.call(this, id, ...args); };
    exports = createRequire(import.meta.url)(path.join(folder, 'fixture.cjs'));
  } finally { Module._load = oldLoad; }
  const { fetchFeed, isPublicAddress, parseFeed, parseFeedBatch, selectFeedProxy, createSystemFeedProxy, hasFakeIpTunnel } = exports;
  const untitledFeed = parseFeedBatch('<rss><channel><item><guid>one</guid></item><item><guid>two</guid><title>无标题</title></item></channel></rss>', url);
  assert.deepEqual(untitledFeed.placeholderFields, [{ title: 'rss-no-title' }, null]);
  assert.equal(untitledFeed.records[0].title, untitledFeed.records[1].title, 'an actual title matching the fallback remains unmarked');
  for (const address of ['198.18.1.101', '198.19.1.101', '127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false);
  assert.equal(selectFeedProxy('DIRECT; PROXY ignored:8080'), null);
  assert.equal(selectFeedProxy('PROXY 127.0.0.1:7890; DIRECT'), 'http://127.0.0.1:7890');
  assert.equal(selectFeedProxy('HTTPS proxy.example.com:8443'), 'https://proxy.example.com:8443');
  assert.equal(selectFeedProxy('SOCKS5 [::1]:1080'), 'socks5://[::1]:1080');
  assert.throws(() => selectFeedProxy('QUIC proxy.example.com:443'), /unsupported/);
  assert.throws(() => selectFeedProxy('PROXY user:pass@proxy.example.com:8080'), /invalid/);
  for (const name of ['Mihomo', 'utun8', 'tun0']) assert.equal(hasFakeIpTunnel({ [name]: [{ family: 'IPv4', address: '198.18.0.1', internal: false }] }), true, name);
  assert.equal(hasFakeIpTunnel({ lan: [{ family: 'IPv4', address: '192.168.1.2', internal: false }] }), false);
  assert.equal(hasFakeIpTunnel({ loop: [{ family: 'IPv4', address: '198.18.0.1', internal: true }] }), false);
  let proxyCalls = 0;
  const proxy = {
    resolve: async () => 'http://127.0.0.1:7890', hasFakeIpTunnel: () => false,
    fetch: async (target, selected, init) => { proxyCalls++; assert.equal(target, url); assert.equal(selected, 'http://127.0.0.1:7890'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); return new Response(xml); }
  };
  const lookup = async () => [{ address: '198.18.1.101', family: 4 }];
  assert.equal(parseFeed(await fetchFeed(url, undefined, 0, { lookup, proxy }), url)[0].title, 'OpenAI news');
  assert.equal(proxyCalls, 1, 'fake-IP uses the original domain through the selected proxy');
  await assert.rejects(fetchFeed(url, undefined, 0, { lookup }), /fake-IP/);
  await assert.rejects(fetchFeed(url, undefined, 0, { lookup, proxy: { ...proxy, resolve: async () => null } }), /fake-IP/);
  // TUN-only installations report DIRECT. Use a pinned synthetic address only with OS evidence and HTTPS.
  const directRequests = [];
  https.get = (target, options, callback) => {
    directRequests.push({ target: target.href, options });
    const request = new EventEmitter(); request.destroy = error => { if (error) request.emit('error', error); };
    queueMicrotask(() => { const response = new PassThrough(); response.statusCode = 200; response.headers = {}; callback(response); response.end(xml); });
    return request;
  };
  const tun = { ...proxy, resolve: async () => null, hasFakeIpTunnel: () => true };
  assert.equal(await fetchFeed(url, undefined, 0, { lookup, proxy: tun }), xml);
  assert.equal(directRequests[0].target, url);
  assert.equal(directRequests[0].options.headers['User-Agent'], 'Muster-RSS/1');
  assert.notEqual(directRequests[0].options.rejectUnauthorized, false);
  directRequests[0].options.lookup('openai.com', { all: true }, (error, rows) => { assert.equal(error, null); assert.deepEqual(rows, [{ address: '198.18.1.101', family: 4 }]); });
  await assert.rejects(fetchFeed(url.replace('https:', 'http:'), undefined, 0, { lookup, proxy: tun }), /HTTPS/);
  for (const target of ['https://198.18.1.101/feed', 'http://127.0.0.1/feed', 'https://[::1]/feed', 'https://metadata.internal/feed', 'https://box.local./feed', 'https://router.home.arpa./feed', 'file:///etc/passwd', 'https://user:secret@openai.com/feed']) {
    await assert.rejects(fetchFeed(target, undefined, 0, { lookup, proxy: tun }), /public/);
  }
  for (const privateAddress of ['10.0.0.1', '169.254.169.254', '::ffff:7f00:1']) {
    await assert.rejects(fetchFeed(url, undefined, 0, { proxy, lookup: async () => [{ address: '198.18.1.101', family: 4 }, { address: privateAddress, family: 4 }] }), /non-public/);
  }
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  await fetchFeed(url, undefined, 0, { lookup: publicLookup });
  directRequests.at(-1).options.lookup('openai.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  let redirects = 0;
  const redirectProxy = { ...proxy, fetch: async () => { redirects++; return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }); } };
  await assert.rejects(fetchFeed(url, undefined, 0, { lookup, proxy: redirectProxy }), /non-public/);
  assert.equal(redirects, 1, 'a proxy redirect cannot reach metadata/private destinations');
  const visited = [];
  const publicRedirect = { ...proxy, fetch: async target => { visited.push(target); return visited.length === 1 ? new Response('', { status: 301, headers: { location: 'https://feeds.example.com/news' } }) : new Response(xml); } };
  const names = [];
  assert.equal(await fetchFeed(url, undefined, 0, { lookup: async host => { names.push(host); return lookup(); }, proxy: publicRedirect }), xml);
  assert.deepEqual(names, ['openai.com', 'feeds.example.com']);
  await assert.rejects(fetchFeed(url, undefined, 0, { lookup, proxy: { ...proxy, fetch: async () => new Response('', { status: 302, headers: { location: url } }) } }), /public HTTP/);
  await assert.rejects(fetchFeed(url, undefined, 0, { lookup, proxy: { ...proxy, fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) } }), /2 MB/);
  await assert.rejects(fetchFeed(url, undefined, 0, { lookup, proxy: { ...proxy, fetch: async () => new Response('', { status: 407 }) } }), /HTTP 407/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchFeed(url, controller.signal, 0, { lookup, proxy }), /abort/i);
  const pendingController = new AbortController();
  const pendingDns = fetchFeed(url, pendingController.signal, 0, { lookup: () => new Promise(() => {}) });
  pendingController.abort();
  await assert.rejects(pendingDns, /abort/i, 'cancellation also bounds a stuck DNS lookup');
  const adapter = createSystemFeedProxy(), selected = await adapter.resolve(url);
  await Promise.all([adapter.fetch(url, selected, {}), adapter.fetch(url, selected, {})]);
  assert.equal(configured.length, 1, 'concurrent requests share one fixed-proxy session');
  assert.equal(configured[0].partition.startsWith('persist:'), false);
  assert.deepEqual(configured[0].config, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '<-loopback>' });
  assert.equal(nativeRequests[0].init.credentials, 'omit'); assert.equal(nativeRequests[0].init.redirect, 'manual');
  assert.equal(nativeRequests[0].init.bypassCustomProtocolHandlers, true);
  console.log('agent apps RSS: proxy/TUN, pinned DNS, redirects, private destinations, limits and isolation passed');
} finally {
  https.get = originalGet;
  delete globalThis.__rssElectronSession;
  const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
