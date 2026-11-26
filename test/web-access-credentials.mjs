/**
 * R2 回归（审计 2026-10-02）：web-access.json 凭证存储模块。
 * 读取三态（缺失/损坏/读取失败）、原子写成功判据、字段保留与清除语义、
 * 写失败不留半截文件。还原 credentials.ts 的判据/原子性即红。
 * Run: node test/web-access-credentials.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-access-credentials-'));

const compileShared = createSharedCompiler(root, tmp);
const out = compileShared('main/webAccess/credentials.ts');
const m = await import(pathToFileURL(out).href);

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const file = () => path.join(fs.mkdtempSync(path.join(tmp, 'case-')), 'web-access.json');

// ── readWebAccessInfo：三态 ──
{
  const f = file();
  assert.equal(m.readWebAccessInfo(f).kind, 'missing');
  ok('读取：文件不存在 → missing');
}
{
  const f = file();
  fs.writeFileSync(f, '{ not json');
  assert.equal(m.readWebAccessInfo(f).kind, 'corrupt');
  fs.writeFileSync(f, JSON.stringify({ token: 'short' })); // 形态非法
  assert.equal(m.readWebAccessInfo(f).kind, 'corrupt');
  fs.writeFileSync(f, JSON.stringify([1, 2])); // 数组不是对象
  assert.equal(m.readWebAccessInfo(f).kind, 'corrupt');
  ok('读取：JSON 坏 / token 形态非法 / 内容非对象 → corrupt');
}
{
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ token: 'A'.repeat(32) }));
  fs.chmodSync(f, 0o000); // Windows 上 chmod 对 owner 只读语义弱，双保险：注入 readFileSync 抛错
  const realRead = fs.readFileSync;
  const injected = new Error('injected EACCES');
  injected.code = 'EACCES';
  fs.readFileSync = function (p, ...args) {
    if (String(p) === f) throw injected;
    return realRead.call(this, p, ...args);
  };
  try {
    const r = m.readWebAccessInfo(f);
    assert.equal(r.kind, 'read-error');
    assert.ok(r.detail.includes('EACCES'));
  } finally {
    fs.readFileSync = realRead;
    fs.chmodSync(f, 0o666);
  }
  ok('读取：EACCES 等 IO 错误 → read-error（与缺失/损坏分开）');
}
{
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ token: 'A'.repeat(32), rotatedAt: 't1', hookToken: 'B'.repeat(32), futureField: { x: 1 } })
  );
  const r = m.readWebAccessInfo(f);
  assert.equal(r.kind, 'ok');
  assert.equal(r.info.token, 'A'.repeat(32));
  assert.equal(r.raw.futureField.x, 1); // 未知字段进 raw，轮换时保留
  ok('读取：合法文件 → ok，未知字段保留在 raw');
}

// ── saveWebAccessInfo：成功判据 + 原子性 ──
{
  const f = file();
  const res = m.saveWebAccessInfo(f, { token: 'C'.repeat(32), rotatedAt: 't2', hookToken: 'D'.repeat(32) });
  assert.equal(res.ok, true);
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(disk.token, 'C'.repeat(32));
  const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []); // 原子写不留临时文件
  ok('写入：成功返回 ok，盘面即目标内容，无 .tmp 残留');
}
{
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ token: 'OLD'.repeat(11), futureField: 7 }));
  const res = m.saveWebAccessInfo(
    f,
    { token: 'N'.repeat(32), rotatedAt: 't3', hookToken: 'H'.repeat(32), pushSubscription: { endpoint: 'e' } },
    JSON.parse(fs.readFileSync(f, 'utf8'))
  );
  assert.equal(res.ok, true);
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(disk.futureField, 7); // 未识别字段不丢
  assert.deepEqual(disk.pushSubscription, { endpoint: 'e' });
  ok('写入：轮换保留未知字段与 pushSubscription');
}
{
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ token: 'A'.repeat(32), hookSecret: 's1' }));
  const res = m.saveWebAccessInfo(
    f,
    { token: 'B'.repeat(32), rotatedAt: 't4', hookSecret: '' }, // 空串 = 清除
    JSON.parse(fs.readFileSync(f, 'utf8'))
  );
  assert.equal(res.ok, true);
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(!('hookSecret' in disk));
  ok('写入：hookSecret 空串 = 清除字段（不残留旧密钥）');
}
{
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ token: 'OLD'.repeat(11) }));
  const realOpen = fs.openSync;
  const injected = new Error('injected EACCES');
  injected.code = 'EACCES';
  fs.openSync = function (p, ...args) {
    if (String(p).startsWith(f)) throw injected; // 连临时文件也建不了（目录只读等）
    return realOpen.call(this, p, ...args);
  };
  let res;
  try {
    res = m.saveWebAccessInfo(f, { token: 'N'.repeat(32), rotatedAt: 't5' });
  } finally {
    fs.openSync = realOpen;
  }
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('EACCES'));
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).token, 'OLD'.repeat(11)); // 旧盘面原样
  ok('写入：open 失败（EACCES）→ ok:false 带原因，旧文件不动');
}
{
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ token: 'OLD'.repeat(11) }));
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to, ...args) {
    if (String(to) === f) throw Object.assign(new Error('injected EPERM rename'), { code: 'EPERM' });
    return realRename.call(this, from, to, ...args);
  };
  let res;
  try {
    res = m.saveWebAccessInfo(f, { token: 'N'.repeat(32), rotatedAt: 't6' });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('rename') || res.error.includes('EPERM'));
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).token, 'OLD'.repeat(11));
  const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []); // rename 失败也清临时文件
  ok('写入：rename 失败 → ok:false，旧文件不动且临时文件被清理');
}

console.log(`web-access-credentials: ${passed} 组断言全绿`);
