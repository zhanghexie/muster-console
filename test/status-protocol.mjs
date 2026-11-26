/**
 * P2 状态协议扩展：新字段向后兼容 + agent-hook 脚本行为 + hooks 安装/卸载合并纪律。
 * Run: node test/status-protocol.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-protocol-'));
// statusBody.ts 现 import shared/i18n（i18next）：用带目录解析与 i18next shim 的 shared-compile
const compile = createSharedCompiler(root, tmp);

// ---------- 1) parseStatusBody：新旧 body 兼容 ----------
{
  const out = compile('main/protocol/statusBody.ts');
  const { parseStatusBody } = await import(pathToFileURL(out).href);

  // 旧 body：仅 label —— 必须照常过
  const old1 = parseStatusBody({ label: '进行中' });
  assert.equal(parseStatusBody({ label: '自由描述新进展' }).label, '自由描述新进展');
  assert.equal(parseStatusBody({ note: '🔧'.repeat(10) }).label, '🔧'.repeat(10));
  for (const field of ['note', 'label']) {
    assert.throws(() => parseStatusBody({ phase: 'done', [field]: '一二三四五六七八九十一' }), /10/);
  }
  assert.equal(old1.label, '进行中');
  assert.equal(old1.kind, undefined);
  assert.equal(old1.activity, undefined);
  const old2 = parseStatusBody({ label: '进行中', kind: 'active' });
  assert.equal(old2.label, '进行中');
  assert.equal(old2.kind, 'active');
  const old3 = parseStatusBody({ label: '查缺陷', kind: 'waiting', summary: '等用户确认' });
  assert.equal(old3.label, '查缺陷');
  assert.equal(old3.kind, 'waiting');
  assert.equal(old3.summary, '等用户确认');
  // 旧 body 未知 kind：回落（kind 缺省），不报错
  assert.equal(parseStatusBody({ label: 'x', kind: 'bogus' }).kind, undefined);

  // 新 body：仅 activity/event（hooks 上报，无 label）
  const hook1 = parseStatusBody({ activity: 'active', event: 'user-prompt-submit' });
  assert.equal(hook1.activity, 'active');
  assert.equal(hook1.event, 'user-prompt-submit');
  assert.equal(hook1.label, undefined);
  const hook2 = parseStatusBody({ activity: 'blocked', event: 'permission-request' });
  assert.equal(hook2.activity, 'blocked');
  assert.equal(hook2.event, 'permission-request');
  // label + activity 同报
  const both = parseStatusBody({ label: '等待确认', activity: 'waiting_input' });
  assert.equal(both.label, '等待确认');
  assert.equal(both.activity, 'waiting_input');

  assert.throws(() => parseStatusBody({}));
  assert.throws(() => parseStatusBody({ label: '' }));
  assert.throws(() => parseStatusBody({ activity: 'bogus' }), /activity 或 phase/);
  assert.throws(() => parseStatusBody({ event: 'x' }), /activity 或 phase/);

  // phase 三档；只 label 不带 phase；kind=done 兼容折成 phase
  const p1 = parseStatusBody({ phase: 'done' });
  assert.equal(p1.phase, 'done');
  assert.equal(p1.label, undefined);
  const p2 = parseStatusBody({ phase: 'needs_you' });
  assert.equal(p2.phase, 'needs_you');
  assert.throws(() => parseStatusBody({ phase: 'idle' }), /空闲由宿主判断/);
  assert.throws(() => parseStatusBody({ phase: 'idle', kind: 'done', label: '结束' }), /空闲由宿主判断/);
  assert.equal(parseStatusBody({ activity: 'idle', event: 'stop' }).activity, 'idle');
  const labelOnly = parseStatusBody({ label: '等 API key' });
  assert.equal(labelOnly.label, '等 API key');
  assert.equal(labelOnly.phase, undefined, '只 label 不改列');
  const compat = parseStatusBody({ kind: 'done' });
  assert.equal(compat.phase, 'done', '旧 kind=done 折成 phase');
  const compatBoth = parseStatusBody({ label: '已完成', kind: 'done' });
  assert.equal(compatBoth.phase, 'done');
  assert.equal(compatBoth.label, '已完成');
  assert.equal(parseStatusBody({ phase: 'bogus', label: 'x' }).phase, undefined, '非法 phase 忽略');
  assert.throws(() => parseStatusBody({ phase: 'working' }), /activity 或 phase/);

  // note 别名：sessions.setStatus 工具侧参数名，与 label 同义
  const alias = parseStatusBody({ note: '等构建' });
  assert.equal(alias.label, '等构建', 'note 折算为 label');
  assert.equal(alias.labelFromNote, true, 'note 来源要标记（着色按工具同义 active，而非旧 label 的 info）');
  assert.equal(alias.phase, undefined);
  const aliasBoth = parseStatusBody({ note: '排查中', phase: 'needs_you' });
  assert.equal(aliasBoth.label, '排查中');
  assert.equal(aliasBoth.phase, 'needs_you');
  const noteWins = parseStatusBody({ note: '来自note', label: '来自label' });
  assert.equal(noteWins.label, '来自note', '同时给 note/label 时 note 优先（新参数名优先，label 兼容旧 body）');
  assert.equal(parseStatusBody({ label: 'x' }).labelFromNote, false, '旧 label body 不标 note 来源');
  console.log('ok: parseStatusBody 新旧兼容 + note 别名');
}

// ---------- 2) agent-hook 脚本：env 路由与 best-effort ----------
{
  const hookPath = path.join(root, 'src', 'main', 'runtime', 'builtins', 'scripts', '_agent-hook.mjs');

  // 起一个本地 status 接收器
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 有 env → POST 结构化 activity
  const r1 = spawnSync(
    process.execPath,
    [hookPath, 'muster-hook-v1', 'active', 'user-prompt-submit'],
    {
      input: JSON.stringify({ tool_name: 'Bash', tool_use_id: 'tu_1' }),
      env: { ...process.env, MUSTER_STATUS_URL: `http://127.0.0.1:${port}/v1/s/tok/status` },
      encoding: 'utf8'
    }
  );
  assert.equal(r1.status, 0, 'hook 必须总是 exit 0');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].body.activity, 'active');
  assert.equal(received[0].body.event, 'user-prompt-submit');
  assert.equal(received[0].body.toolName, 'Bash');
  assert.equal(received[0].body.toolUseId, 'tu_1');

  // 无 MUSTER_STATUS_URL（裸终端跑 claude）→ 立即 exit 0，不发请求
  const before = received.length;
  const r2 = spawnSync(
    process.execPath,
    [hookPath, 'muster-hook-v1', 'idle', 'stop'],
    { encoding: 'utf8' }
  );
  assert.equal(r2.status, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, before, '无 env 不应发请求');

  // 宿主挂了（URL 指向死端口）→ 仍 exit 0（best-effort）
  const r3 = spawnSync(
    process.execPath,
    [hookPath, 'muster-hook-v1', 'blocked', 'permission-request'],
    {
      env: { ...process.env, MUSTER_STATUS_URL: `http://127.0.0.1:9/v1/s/t/status` },
      encoding: 'utf8'
    }
  );
  assert.equal(r3.status, 0, '上报失败也不得挡 agent');

  // 忽略型事件（session-end）→ 不 POST
  const r4 = spawnSync(
    process.execPath,
    [hookPath, 'muster-hook-v1', 'ignore', 'session-end'],
    { env: { ...process.env, MUSTER_STATUS_URL: `http://127.0.0.1:${port}/v1/s/t/status` }, encoding: 'utf8' }
  );
  assert.equal(r4.status, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, before, 'session-end 忽略不 POST');

  server.close();
  console.log('ok: agent-hook env 路由 + best-effort + 事件忽略');
}

// ---------- 3) claude-code hooks 安装/卸载（合并纪律） ----------
{
  const claude = await import(
    pathToFileURL(path.join(root, 'src/main/runtime/builtins/scripts/claude-code.mjs')).href
  );
  const dir = path.join(tmp, 'ws-claude');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');

  // 预置用户已有 hooks 与其它键
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: { allow: ['Bash'] },
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo user-hook' }] }
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }]
        }
      },
      null,
      2
    ),
    'utf8'
  );

  claude.ensureClaudeHooks({ cwd: dir });
  const after1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after1.permissions.allow[0], 'Bash', '保留用户已有非 hooks 键');
  const ups1 = after1.hooks.UserPromptSubmit;
  assert.equal(ups1.length, 2, '用户 hook + 我们的 hook');
  assert.equal(ups1[0].hooks[0].command, 'echo user-hook', '用户 hook 排前面');
  assert.ok(ups1[1].hooks[0].command.includes('muster-hook-v1'));
  assert.equal(ups1[1].hooks[0].command.split(' ').at(-2), 'active', 'UserPromptSubmit → active');
  assert.ok(after1.hooks.Stop, '装 Stop → idle');
  assert.ok(after1.hooks.PermissionRequest, '装 PermissionRequest → blocked');
  assert.ok(after1.hooks.SessionEnd, '装 SessionEnd（忽略型）');
  assert.ok(after1.hooks.PreToolUse, '用户 PreToolUse 保留');

  // 重复运行去重
  claude.ensureClaudeHooks({ cwd: dir });
  const after2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const ours = after2.hooks.UserPromptSubmit.filter((g) =>
    g.hooks.some((h) => h.command.includes('muster-hook-v1'))
  );
  assert.equal(ours.length, 1, '重复 allocate 不追加重复条目');
  assert.equal(after2.hooks.UserPromptSubmit.length, 2);

  // 卸载：只删自己的
  const res = claude.uninstallDetectHooks({ cwd: dir });
  assert.ok(res.removed >= 4, `应移除全部 4 条（实际 ${res.removed}）`);
  const after3 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after3.hooks.UserPromptSubmit.length, 1, '用户 hook 保留');
  assert.equal(after3.hooks.UserPromptSubmit[0].hooks[0].command, 'echo user-hook');
  assert.ok(after3.hooks.PreToolUse, '用户 PreToolUse 保留');
  assert.ok(!after3.hooks.Stop && !after3.hooks.PermissionRequest, '我们的空事件键清掉');
  assert.deepEqual(after3.permissions, { allow: ['Bash'] });
  console.log('ok: claude-code hooks 合并/去重/卸载');
}

// ---------- 4) cursor-cli hooks 安装/卸载 ----------
{
  const cursor = await import(
    pathToFileURL(path.join(root, 'src/main/runtime/builtins/scripts/cursor-cli.mjs')).href
  );
  const dir = path.join(tmp, 'ws-cursor');
  fs.mkdirSync(dir, { recursive: true });
  const hooksPath = path.join(dir, '.cursor', 'hooks.json');

  cursor.ensureCursorHooks({ cwd: dir });
  const after1 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(after1.version, 1, '声明 schema version');
  for (const ev of [
    'sessionStart',
    'beforeSubmitPrompt',
    'preToolUse',
    'stop',
    'beforeShellExecution',
    'afterShellExecution'
  ]) {
    assert.ok(Array.isArray(after1.hooks[ev]), `装 ${ev}`);
  }
  const stopCmd = after1.hooks.stop[0].command;
  assert.ok(stopCmd.includes('muster-hook-v1') && stopCmd.includes(' idle '), 'stop → idle');
  const preTool = after1.hooks.preToolUse[0].command;
  assert.ok(preTool.includes(' active '), 'preToolUse → active');

  // 预置用户 hook 再装：保留 + 去重
  const withUser = {
    version: 1,
    hooks: { stop: [{ command: 'echo user-stop' }] }
  };
  fs.writeFileSync(hooksPath, JSON.stringify(withUser, null, 2), 'utf8');
  cursor.ensureCursorHooks({ cwd: dir });
  const after2 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(after2.hooks.stop.length, 2, '用户 + 我们的');
  assert.equal(after2.hooks.stop[0].command, 'echo user-stop');

  cursor.ensureCursorHooks({ cwd: dir });
  const after3 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(after3.hooks.stop.length, 2, '重复运行去重');

  const res = cursor.uninstallDetectHooks({ cwd: dir });
  assert.ok(res.removed >= 6, `应移除全部 6 条（实际 ${res.removed}）`);
  const after4 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.deepEqual(after4.hooks, { stop: [{ command: 'echo user-stop' }] }, '用户 hook 保留，空键清掉');
  console.log('ok: cursor-cli hooks 合并/去重/卸载');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] status-protocol');
