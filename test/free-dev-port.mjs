/**
 * 开发端口释放：netstat 解析与杀进程判定。
 * Run: node test/free-dev-port.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseListeningPids, parseLsofPids, shouldKillDevListener } = await import(
  pathToFileURL(path.join(root, 'scripts/free-dev-port.mjs')).href
);

{
  const table = [
    '  TCP    [::1]:5188             [::]:0                 LISTENING       54212',
    '  TCP    127.0.0.1:5188         0.0.0.0:0              LISTENING       54212',
    '  TCP    [::1]:51880            [::]:0                 LISTENING       99',
    '  TCP    127.0.0.1:5188         127.0.0.1:9            TIME_WAIT       1'
  ].join('\n');
  assert.deepEqual(parseListeningPids(table, 5188), [54212]);
  assert.deepEqual(parseListeningPids(table, 51880), [99]);
  console.log('ok: parseListeningPids');
}

{
  // POSIX：lsof -t 输出 PID 一行一个（空串/非数字行/重复都过滤或透传）
  assert.deepEqual(parseLsofPids('54212\n54213\n'), [54212, 54213]);
  assert.deepEqual(parseLsofPids('54212\n\nnot-a-pid\n54212\n'), [54212, 54212]);
  assert.deepEqual(parseLsofPids(''), []);
  console.log('ok: parseLsofPids');
}

{
  assert.equal(shouldKillDevListener(`${root}\\node_modules\\electron-vite\\bin\\electron-vite.js dev`, 12), true);
  assert.equal(shouldKillDevListener('d:\\cursor\\resources\\app\\helpers\\node.exe', 12), false);
  assert.equal(shouldKillDevListener('', 12), true, '命令行拿不到时仍杀占端口的残留');
  assert.equal(shouldKillDevListener('electron-vite.js dev', process.pid), false);
  console.log('ok: shouldKillDevListener');
}

console.log('[ok] free-dev-port');
