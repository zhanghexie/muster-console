/** Renderer CSP must cover the resources used by the desktop and web surfaces. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve('src/renderer/index.html'), 'utf8');
const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i);
assert.ok(match, 'renderer index must declare one Content-Security-Policy meta tag');

const policy = new Map(
  match[1].split(';').map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, new Set(sources)];
  })
);

const requireSources = (directive, sources) => {
  const actual = policy.get(directive);
  assert.ok(actual, `CSP must declare ${directive}`);
  for (const source of sources) {
    assert.ok(actual.has(source), `${directive} must allow ${source}`);
  }
};

requireSources('script-src', ["'self'", "'unsafe-inline'", 'http://localhost:5188', 'muster-root:']);
requireSources('style-src', [
  "'self'",
  "'unsafe-inline'",
  'https://cdn-font.hyperos.mi.com',
  'https://cdn.jsdelivr.net',
  'muster-root:'
]);
requireSources('img-src', ["'self'", 'data:', 'blob:', 'http:', 'https:', 'muster-ws:', 'muster-root:', 'muster-ext:']);
requireSources('font-src', [
  "'self'",
  'data:',
  'https://www.oppo.com',
  'https://cdn-font.hyperos.mi.com',
  'https://cdn.jsdelivr.net',
  'muster-root:'
]);
requireSources('connect-src', ["'self'", 'http://localhost:5188', 'ws://localhost:5188', 'muster-ws:', 'muster-root:', 'muster-ext:']);
requireSources('frame-src', ["'self'", 'muster-app:', 'muster-root:', 'muster-ws:', 'muster-ext:']);
requireSources('media-src', ["'self'", 'blob:', 'muster-ws:', 'muster-root:', 'muster-ext:']);
requireSources('object-src', ["'none'"]);
requireSources('base-uri', ["'self'", 'muster-root:']);

assert.ok(!match[1].includes('*'), 'renderer CSP must not use wildcard sources');
console.log('renderer-csp: resource/protocol/font source contract passed');
