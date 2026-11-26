/**
 * read-state 过期提示纯函数回归（zcode-adopt-batch-a A1 / T1）：
 * 1) 登记：同路径重读覆盖、partial 标记、空路径忽略；
 * 2) 标脏判定：读后写→提示、mtime+size 未变→无、hash 未变→无、partial 规则；
 * 3) 多文件合并文案（优先路径在前、单条/列表两形态、【read-state】前缀）；
 * 4) 纯路径优先集（docs/**、契约、AGENTS/HOST、.agents/skills/**）；
 * 5) bash 疑似写反向判定 + read 工具归类 + partial 入参识别。
 * 运行: node test/read-state.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'read-state-'));
const compile = createSharedCompiler(root, tmp);

const rs = await import(pathToFileURL(compile('shared/readState.ts')).href);
const {
  READ_STATE_HINT_TAG,
  isPriorityReadPath,
  registerReadState,
  isReadStale,
  checkWriteStale,
  checkBashStale,
  composeStaleHint,
  formatMtime,
  classifyReadStateTool,
  isSuspectedWriteCommand,
  isPartialReadInput,
  extractReadStatePath,
  extractShellCommand,
  createReadStateTracker
} = rs;

const table = () => new Map();

// ── 1) 登记 ──
{
  const t = table();
  registerReadState(t, {
    path: 'docs/a.md',
    mtimeMs: 1000,
    size: 10,
    contentHash: 'h1',
    isPartialView: false
  });
  assert.equal(t.size, 1);
  const e = t.get('docs/a.md');
  assert.equal(e.mtimeMs, 1000);
  assert.equal(e.size, 10);
  assert.equal(e.contentHash, 'h1');
  assert.equal(e.isPartialView, false);

  // 同路径重读覆盖旧快照
  registerReadState(t, {
    path: 'docs/a.md',
    mtimeMs: 2000,
    size: 20,
    isPartialView: true
  });
  assert.equal(t.size, 1);
  assert.equal(t.get('docs/a.md').mtimeMs, 2000);
  assert.equal(t.get('docs/a.md').isPartialView, true);
  assert.equal(t.get('docs/a.md').contentHash, undefined, '重读未带 hash 则清掉旧 hash');

  // 空路径忽略
  registerReadState(t, { path: '  ', mtimeMs: 1, size: 1, isPartialView: false });
  assert.equal(t.size, 1);

  // 路径分隔符归一（反斜杠与正斜杠同键）
  registerReadState(t, { path: 'docs\\b.md', mtimeMs: 5, size: 5, isPartialView: false });
  registerReadState(t, { path: 'docs/b.md', mtimeMs: 6, size: 6, isPartialView: false });
  assert.equal(t.size, 2, 'docs\\b.md 与 docs/b.md 同键');
  assert.equal(t.get('docs/b.md').mtimeMs, 6);

  console.log('ok  登记（覆盖/partial/空路径/路径归一）');
}

// ── 2) 标脏判定 ──
{
  const prev = {
    path: 'AGENTS.md',
    mtimeMs: 1000,
    size: 100,
    contentHash: 'abc',
    isPartialView: false
  };
  // 读后写→提示（mtime 或 size 变化）
  assert.equal(isReadStale(prev, { mtimeMs: 2000, size: 100 }), true, 'mtime 变即脏');
  assert.equal(isReadStale(prev, { mtimeMs: 1000, size: 200 }), true, 'size 变即脏');
  // mtime+size 未变→无
  assert.equal(isReadStale(prev, { mtimeMs: 1000, size: 100 }), false, 'mtime+size 未变不提示');
  // hash 未变→无（哪怕 mtime 被 touch）
  assert.equal(
    isReadStale(prev, { mtimeMs: 1000, size: 100, contentHash: 'abc' }),
    false
  );
  assert.equal(
    isReadStale(prev, { mtimeMs: 9999, size: 999, contentHash: 'abc' }),
    false,
    'hash 未变不提示'
  );
  // hash 变了才提示
  assert.equal(
    isReadStale(prev, { mtimeMs: 9999, size: 999, contentHash: 'xyz' }),
    true
  );
  // 无 hash 时退化为 mtime+size
  const noHash = { path: 'x', mtimeMs: 1, size: 1, isPartialView: true };
  assert.equal(isReadStale(noHash, { mtimeMs: 1, size: 1 }), false);
  assert.equal(isReadStale(noHash, { mtimeMs: 2, size: 1 }), true);

  // checkWriteStale：命中已读路径
  const t = table();
  registerReadState(t, {
    path: 'docs/plan.md',
    mtimeMs: 1000,
    size: 50,
    contentHash: 'h',
    isPartialView: false
  });
  const hit = checkWriteStale(t, 'docs/plan.md', { mtimeMs: 2000, size: 50 });
  assert.ok(hit, '读后写命中');
  assert.equal(hit.path, 'docs/plan.md');
  assert.equal(hit.readMtimeMs, 1000);
  assert.equal(hit.isPriority, true, 'docs/** 优先路径');
  assert.equal(
    checkWriteStale(t, 'docs/plan.md', { mtimeMs: 1000, size: 50 }),
    null,
    '指纹未变不命中'
  );
  assert.equal(
    checkWriteStale(t, 'docs/other.md', { mtimeMs: 2000, size: 50 }),
    null,
    '未读过的路径不命中'
  );

  console.log('ok  标脏判定（读后写/未变无/hash/partial 退化）');
}

// ── 2b) partial 标记 ──
{
  const t = table();
  registerReadState(t, {
    path: 'AGENTS.md',
    mtimeMs: 1000,
    size: 100,
    isPartialView: true
  });
  const hit = checkWriteStale(t, 'AGENTS.md', { mtimeMs: 2000, size: 100 });
  assert.ok(hit);
  assert.equal(hit.isPartialView, true, 'partial 标记带进命中');

  // partial 读 + hash 未变 → 不提示（hash 只盖已读片段）
  registerReadState(t, {
    path: '.agents/skills/x/SKILL.md',
    mtimeMs: 100,
    size: 10,
    contentHash: 'ph',
    isPartialView: true
  });
  assert.equal(
    checkWriteStale(t, '.agents/skills/x/SKILL.md', {
      mtimeMs: 999,
      size: 99,
      contentHash: 'ph'
    }),
    null,
    'partial 且 hash 未变不提示'
  );

  // 全量读 + hash 未变同样不提示
  registerReadState(t, {
    path: 'HOST.md',
    mtimeMs: 1,
    size: 1,
    contentHash: 'f',
    isPartialView: false
  });
  assert.equal(
    checkWriteStale(t, 'HOST.md', { mtimeMs: 2, size: 2, contentHash: 'f' }),
    null
  );

  console.log('ok  partial 标记与 hash 抑制');
}

// ── 3) 多文件合并文案 ──
{
  assert.equal(composeStaleHint([]), '');
  assert.equal(composeStaleHint([
    { path: 'a', readMtimeMs: 0, isPartialView: false, isPriority: false }
  ]).includes(READ_STATE_HINT_TAG), true);

  const single = composeStaleHint([
    { path: 'docs/a.md', readMtimeMs: 1000, isPartialView: false, isPriority: true }
  ]);
  assert.ok(single.startsWith(READ_STATE_HINT_TAG), '单条也带前缀');
  assert.match(single, /你曾读过 docs\/a\.md/);
  assert.match(single, /mtime /);
  assert.match(single, /请重读后再依据其内容决策/);
  assert.doesNotMatch(single, /^- /m, '单条不走列表');

  const multi = composeStaleHint([
    { path: 'src/z.ts', readMtimeMs: 2000, isPartialView: true, isPriority: false },
    { path: 'AGENTS.md', readMtimeMs: 1000, isPartialView: false, isPriority: true },
    { path: 'docs/b.md', readMtimeMs: 1500, isPartialView: false, isPriority: true }
  ]);
  assert.ok(multi.startsWith(READ_STATE_HINT_TAG));
  assert.match(multi, /下列 3 个文件/);
  const lines = multi.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3, '三条列表行');
  // 优先路径在前：AGENTS.md、docs/b.md 先于 src/z.ts
  assert.match(lines[0], /AGENTS\.md/);
  assert.match(lines[1], /docs\/b\.md/);
  assert.match(lines[2], /src\/z\.ts/);

  console.log('ok  多文件合并（优先排序/单条/列表/前缀）');
}

// ── 4) 纯路径优先集 ──
{
  assert.equal(isPriorityReadPath('docs/a.md'), true);
  assert.equal(isPriorityReadPath('docs/sub/deep/x.md'), true);
  assert.equal(isPriorityReadPath('pkg/docs/a.md'), true);
  assert.equal(isPriorityReadPath('AGENTS.md'), true);
  assert.equal(isPriorityReadPath('agents.md'), true);
  assert.equal(isPriorityReadPath('CLAUDE.md'), true);
  assert.equal(isPriorityReadPath('.muster/HOST.md'), true);
  assert.equal(isPriorityReadPath('.muster/HOST-EXT.md'), true);
  assert.equal(isPriorityReadPath('.agents/skills/foo/SKILL.md'), true);
  assert.equal(isPriorityReadPath('.agents/skills/foo/refs/x.md'), true);

  assert.equal(isPriorityReadPath('src/main/x.ts'), false);
  assert.equal(isPriorityReadPath('package.json'), false);
  assert.equal(isPriorityReadPath('README.md'), false);
  assert.equal(isPriorityReadPath('docs-old/a.md'), false, 'docs-old 不是 docs/**');
  assert.equal(isPriorityReadPath('.agents/other/x.md'), false);

  // checkBashStale 的 isPriority 透传
  const t = table();
  registerReadState(t, { path: 'src/a.ts', mtimeMs: 1, size: 1, isPartialView: false });
  registerReadState(t, { path: 'AGENTS.md', mtimeMs: 1, size: 1, isPartialView: false });
  const hits = checkBashStale(t, [
    { path: 'src/a.ts', mtimeMs: 2, size: 1 },
    { path: 'AGENTS.md', mtimeMs: 2, size: 1 }
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits.find((h) => h.path === 'AGENTS.md').isPriority, true);
  assert.equal(hits.find((h) => h.path === 'src/a.ts').isPriority, false);

  console.log('ok  纯路径优先集');
}

// ── 4b) bash 回扫 ──
{
  const t = table();
  registerReadState(t, { path: 'docs/a.md', mtimeMs: 1, size: 1, isPartialView: false });
  registerReadState(t, { path: 'docs/b.md', mtimeMs: 1, size: 1, isPartialView: false });
  registerReadState(t, { path: 'docs/c.md', mtimeMs: 1, size: 1, isPartialView: false });

  // 只有 a 变了 → 只命中 a
  const hits = checkBashStale(t, [
    { path: 'docs/a.md', mtimeMs: 2, size: 1 },
    { path: 'docs/b.md', mtimeMs: 1, size: 1 },
    { path: 'docs/c.md', mtimeMs: 1, size: 1 }
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'docs/a.md');

  // currentStats 未覆盖的路径跳过
  assert.equal(
    checkBashStale(t, [{ path: 'docs/b.md', mtimeMs: 1, size: 1 }]).length,
    0,
    '未覆盖路径不凭空命中'
  );
  // 未登记路径忽略
  assert.equal(
    checkBashStale(t, [{ path: 'docs/zzz.md', mtimeMs: 9, size: 9 }]).length,
    0
  );

  console.log('ok  bash 回扫（命中/跳过/未登记忽略）');
}

// ── 5) bash 疑似写 + 工具归类 + partial 入参 ──
{
  assert.equal(isSuspectedWriteCommand(''), false, '空命令 unknown 不标脏');
  assert.equal(isSuspectedWriteCommand('   '), false);
  assert.equal(isSuspectedWriteCommand('grep "x f'), false, '无法切段 unknown 不标脏');
  assert.equal(isSuspectedWriteCommand('ls -la'), false, '只读命令不标脏');
  assert.equal(isSuspectedWriteCommand('cat docs/a.md'), false);
  assert.equal(isSuspectedWriteCommand('echo hi > file'), true, '重定向写=疑似写');
  assert.equal(isSuspectedWriteCommand('git push'), true);
  assert.equal(isSuspectedWriteCommand('npm run lint:fix'), true);
  assert.equal(isSuspectedWriteCommand('rm -rf dist'), true);
  assert.equal(isSuspectedWriteCommand('sed -i s/a/b/ f'), true);

  assert.equal(classifyReadStateTool('read'), 'read');
  assert.equal(classifyReadStateTool('Read'), 'read');
  assert.equal(classifyReadStateTool('read_image'), 'read');
  assert.equal(classifyReadStateTool('write'), 'write');
  assert.equal(classifyReadStateTool('Write'), 'write');
  assert.equal(classifyReadStateTool('Edit'), 'write');
  assert.equal(classifyReadStateTool('MultiEdit'), 'write');
  assert.equal(classifyReadStateTool('file_change'), 'write');
  assert.equal(classifyReadStateTool('delete'), 'write');
  assert.equal(classifyReadStateTool('bash'), 'shell');
  assert.equal(classifyReadStateTool('Bash'), 'shell');
  assert.equal(classifyReadStateTool('shell'), 'shell');
  assert.equal(classifyReadStateTool('command_execution'), 'shell');
  assert.equal(classifyReadStateTool('askQuestion'), 'other');
  assert.equal(classifyReadStateTool('sessions.setStatus'), 'other');

  assert.equal(isPartialReadInput({ path: 'a' }), false);
  assert.equal(isPartialReadInput({ path: 'a', offset: 0 }), true, 'offset=0 也是 partial');
  assert.equal(isPartialReadInput({ path: 'a', limit: 100 }), true);
  assert.equal(isPartialReadInput({ limit: undefined }), false);

  console.log('ok  bash 疑似写反向 + 工具归类 + partial 入参');
}

// ── 6) formatMtime 稳定形态 ──
{
  const s = formatMtime(Date.UTC(2026, 8, 26, 12, 0, 0));
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  console.log('ok  formatMtime 形态');
}

// ── 7) 跟踪器（T2 接线用的会话级状态机） ──
{
  const tr = createReadStateTracker();
  assert.equal(tr.size(), 0);
  assert.equal(tr.takeHint(), '');
  tr.noteRead('docs/a.md', { mtimeMs: 1000, size: 10, contentHash: 'h' }, true);
  assert.equal(tr.size(), 1);
  const hit = tr.noteWrite('docs/a.md', { mtimeMs: 2000, size: 10 });
  assert.equal(hit.path, 'docs/a.md');
  assert.equal(hit.isPartialView, true);
  assert.equal(tr.pendingHits().length, 1);
  assert.ok(tr.takeHint().startsWith(READ_STATE_HINT_TAG));
  assert.equal(tr.takeHint(), '', 'takeHint 清空 pending');
  // hash 未变不提示
  tr.noteRead('AGENTS.md', { mtimeMs: 5, size: 5, contentHash: 'f' }, false);
  assert.equal(tr.noteWrite('AGENTS.md', { mtimeMs: 9, size: 9, contentHash: 'f' }), null);
  // 多文件合并（同回合一条）
  tr.noteRead('docs/x.md', { mtimeMs: 1, size: 1 }, false);
  tr.noteRead('src/y.ts', { mtimeMs: 1, size: 1 }, true);
  tr.noteWrite('docs/x.md', { mtimeMs: 2, size: 1 });
  tr.noteWrite('src/y.ts', { mtimeMs: 2, size: 1 });
  assert.match(tr.takeHint(), /下列 2 个文件/);
  // bash 回扫
  tr.noteRead('docs/p.md', { mtimeMs: 1, size: 1 }, false);
  tr.noteRead('docs/q.md', { mtimeMs: 1, size: 1 }, false);
  const sweep = tr.noteBashSweep([
    { path: 'docs/p.md', mtimeMs: 9, size: 1 },
    { path: 'docs/q.md', mtimeMs: 1, size: 1 }
  ]);
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].path, 'docs/p.md');
  assert.ok(tr.readPaths().includes('docs/p.md') && tr.readPaths().includes('docs/q.md'));
  assert.match(tr.takeHint(), /docs\/p\.md/);
  console.log('ok  跟踪器（登记/合并/hash 抑制/bash 回扫）');
}

// ── 8) 工具入参提取 ──
{
  for (const [input, want] of [
    [{ path: 'a.md' }, 'a.md'], [{ file_path: 'b.md' }, 'b.md'], [{ filePath: 'c.md' }, 'c.md'],
    [{ target_file: 'd.md' }, 'd.md'], [{ file: 'e.md' }, 'e.md'], [{ path: '  ' }, null], [{}, null]
  ]) assert.equal(extractReadStatePath(input), want);
  assert.equal(extractShellCommand({ command: 'ls' }), 'ls');
  assert.equal(extractShellCommand({ shellCommand: 'pwd' }), 'pwd');
  assert.equal(extractShellCommand({}), '');
  console.log('ok  工具入参提取');
}

// ── 9) T2 宿主接线（readStateTrack：工具事件 → 登记/标脏 → takeHint 前缀） ──
{
  const track = await import(
    pathToFileURL(compile('main/agentSession/host/readStateTrack.ts')).href
  );
  const {
    noteReadStateToolStart: start,
    noteReadStateToolResult: end,
    takeReadStateHint: take,
    readStatePending: pending,
    readStateSize: sz
  } = track;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'read-state-ws-'));
  const docPath = path.join(ws, 'docs', 'a.md');
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, 'v1\n');
  const entry = {}; // SessionEntry 替身（WeakMap 键）
  const call = (id, name, input, ok = true) => {
    start(entry, id, name, input);
    end(entry, id, ok, ws);
  };

  // Read 成功 → 登记；写成功且指纹变化 → 下一轮前缀含【read-state】
  start(entry, 'c1', 'read', { path: docPath, offset: 0, limit: 10 });
  assert.equal(sz(entry), 0, 'tool-start 只暂存');
  end(entry, 'c1', true, ws);
  assert.equal(sz(entry), 1, 'read 成功后登记');
  assert.equal(take(entry), '', '纯读不产生提示');
  fs.writeFileSync(docPath, 'v2-longer\n');
  call('c2', 'Write', { path: docPath, content: 'x' });
  assert.equal(pending(entry), 1, '写后标脏进 pending');
  const hint = take(entry);
  assert.ok(hint.startsWith(READ_STATE_HINT_TAG), '下一轮前缀含【read-state】');
  assert.match(hint, /请重读/);
  assert.equal(pending(entry), 0, 'takeHint 清空');

  // 指纹未变 → 无提示
  call('c3', 'read', { path: docPath });
  call('c4', 'edit', { path: docPath, old_string: 'x', new_string: 'x' });
  assert.equal(take(entry), '', '指纹未变不提示');

  // bash 疑似写回扫 / 只读不标脏 / 失败不标脏
  fs.writeFileSync(docPath, 'v1\n');
  call('c5', 'read', { path: docPath });
  fs.writeFileSync(docPath, 'v3-changed-size\n'); // size 必须变：mtime 粒度可能不够
  call('c6', 'bash', { command: 'echo hi > out.txt' });
  assert.equal(pending(entry), 1, 'bash 疑似写回扫命中');
  assert.match(take(entry), /【read-state】/);
  call('c7', 'bash', { command: 'ls -la' });
  assert.equal(pending(entry), 0, '只读 bash 不标脏');
  call('c8', 'read', { path: docPath }, false);
  call('c9', 'write', { path: docPath }, false);
  assert.equal(pending(entry), 0, '失败结果不标脏');

  // 多文件合并（同回合一条，优先路径在前）
  const docB = path.join(ws, 'AGENTS.md');
  fs.writeFileSync(docB, 'b1\n');
  call('c10', 'read', { path: docPath });
  call('c11', 'read', { path: docB });
  fs.writeFileSync(docPath, 'v4-longer\n');
  fs.writeFileSync(docB, 'b2-longer\n');
  call('c12', 'write', { path: docPath });
  call('c13', 'write', { path: docB });
  const merged = take(entry);
  assert.match(merged, /下列 2 个文件/);
  assert.match(merged.split('\n').filter((l) => l.startsWith('- '))[0], /AGENTS\.md/);

  console.log('ok  T2 宿主接线（读后写/未变无/bash 回扫/失败/合并）');

  // ── 2026-09-27 复审回归 ──
  // 相对/绝对路径混用命中同一键（resolve 后登记）
  {
    const entry2 = {};
    const rel = path.join('docs', 'a.md'); // 相对 ws
    start(entry2, 'r1', 'read', { path: rel });
    end(entry2, 'r1', true, ws);
    assert.equal(sz(entry2), 1, '相对路径登记');
    fs.writeFileSync(docPath, 'v5-much-longer-content\n');
    // 绝对路径写同一文件 → 必须标脏（旧实现键不 resolve，混用即漏判）
    start(entry2, 'w1', 'Write', { path: docPath, content: 'x' });
    end(entry2, 'w1', true, ws);
    assert.equal(pending(entry2), 1, '绝对路径写命中相对路径登记（resolve 键）');
    assert.match(take(entry2), /【read-state】/);
  }

  // codex file_change 的 changes[] 多路径形态
  {
    const entry3 = {};
    start(entry3, 'r2', 'read', { path: docPath });
    end(entry3, 'r2', true, ws);
    fs.writeFileSync(docPath, 'v6-much-much-longer-content\n');
    start(entry3, 'fc1', 'file_change', {
      changes: [{ path: docPath }, { path: path.join(ws, 'other.md') }]
    });
    end(entry3, 'fc1', true, ws);
    assert.equal(pending(entry3), 1, 'changes[] 形态的写命中已读路径');
    assert.match(take(entry3), /【read-state】/);
  }

  // composeStaleHint 截断（>10 个只列前 10 + 总数）
  {
    const many = Array.from({ length: 15 }, (_, i) => ({
      path: `f${i}.md`,
      readMtimeMs: 1,
      isPartialView: false,
      isPriority: false
    }));
    const hint15 = composeStaleHint(many);
    assert.match(hint15, /下列 15 个文件/);
    assert.match(hint15, /仅列前 10 个/);
    assert.equal(
      hint15.split('\n').filter((l) => l.startsWith('- ') && /f\d+\.md/.test(l)).length,
      10
    );
  }
  console.log('ok  复审回归（resolve 键 / changes[] / 提示截断）');
}

console.log('read-state: all ok');
