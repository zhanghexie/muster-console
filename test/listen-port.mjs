/**
 * P14：端口偏好解析 + 并发绑定不冲突。
 * 运行: node test/listen-port.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-port-'));
const compile = createSharedCompiler(root, tmp);
const { resolvePreferredPort, DEFAULT_WEB_ACCESS_PORT } = await import(
  pathToFileURL(compile('shared/listenPort.ts')).href
);

assert.equal(DEFAULT_WEB_ACCESS_PORT, 7950);
assert.equal(resolvePreferredPort({ defaultPort: 7950 }), 7950);
assert.equal(resolvePreferredPort({ envPort: '0', persisted: 1234, defaultPort: 7950 }), 0);
assert.equal(resolvePreferredPort({ persisted: 18000, defaultPort: 7950 }), 18000);
assert.equal(resolvePreferredPort({ envPort: 'nope', persisted: 9, defaultPort: 7950 }), 9);

const { listenPreferred } = await import(pathToFileURL(compile('main/net/bindListen.ts')).href);

const a = http.createServer();
const first = await listenPreferred(a, 0, '127.0.0.1');
assert.ok(first.port > 0);

const b = http.createServer();
const second = await listenPreferred(b, first.port, '127.0.0.1');
assert.equal(second.fallback, true);
assert.notEqual(second.port, first.port);

const c = http.createServer();
const again = await listenPreferred(c, second.port, '127.0.0.1');
assert.equal(again.fallback, true);
assert.notEqual(again.port, second.port);

a.close();
b.close();
c.close();
console.log('listen-port: ok');
