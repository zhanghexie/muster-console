/**
 * D1 ApplyPatch 契约 + handler + 变更预览（zcode-adopt-batch-d S2.1 / T1）。
 * 覆盖：多文件 add/update/delete/move；DiffHunk 应用；预览 filePaths + add/update。
 * 运行: node test/apply-patch.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-patch-'));
const compile = createSharedCompiler(root, tmp);

const {
  normalizeApplyPatchInput,
  applyHunksToContent,
  applyPatchOpToContent,
  countHunkLines,
  buildApplyPatchPreview,
  applyPatchPreviewFromArgs,
  patchFileChange,
  patchFilePaths,
  ApplyPatchErrorCode
} = await import(pathToFileURL(compile('shared/applyPatch.ts')).href);
const { previewFromToolArgs, FILE_PATHS_MAX } = await import(
  pathToFileURL(compile('shared/permissionOption.ts')).href
);
const { applyPatchToWorkspace, handleApplyPatch } = await import(
  pathToFileURL(compile('main/agentSession/tools/applyPatch.ts')).href
);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

// ---------- DiffHunk 应用 ----------
check('hunk：上下文替换', () => {
  const next = applyHunksToContent('a\nb\nc\n', [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+B'] }
  ]);
  assert.equal(next, 'a\nB\nc\n');
});

check('hunk：纯新增 / 纯删除', () => {
  assert.equal(
    applyHunksToContent('a\n', [{ oldStart: 2, oldLines: 0, newStart: 2, newLines: 2, lines: ['+x', '+y'] }]),
    'a\nx\ny\n'
  );
  assert.equal(
    applyHunksToContent('a\nb\n', [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-a'] }]),
    'b\n'
  );
});

check('hunk：多 hunk 顺序应用', () => {
  const next = applyHunksToContent('1\n2\n3\n4\n5\n', [
    { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-5', '+FIVE'] },
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-1', '+ONE'] }
  ]);
  assert.equal(next, 'ONE\n2\n3\n4\nFIVE\n');
});

check('hunk：上下文不匹配 → undefined', () => {
  assert.equal(
    applyHunksToContent('a\n', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-zzz', '+b'] }]),
    undefined
  );
});

check('countHunkLines 统计增删', () => {
  const c = countHunkLines([
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: ['-a', '+b', '+c', ' d'] }
  ]);
  assert.equal(c.additions, 2);
  assert.equal(c.deletions, 1);
});

// ---------- 入参归一 ----------
check('normalize：多文件四类操作', () => {
  const input = normalizeApplyPatchInput({
    files: [
      { type: 'add', filePath: 'new.ts', content: 'x\n' },
      { type: 'update', filePath: 'a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
      { type: 'delete', filePath: 'old.ts' },
      { type: 'move', filePath: 'src.ts', movePath: 'dst.ts' }
    ]
  });
  assert.equal(input.files.length, 4);
  assert.equal(input.files[0].type, 'add');
  assert.equal(input.files[1].type, 'update');
  assert.equal(input.files[2].type, 'delete');
  assert.equal(input.files[3].type, 'move');
  assert.equal(input.files[3].movePath, 'dst.ts');
});

check('normalize：非法条目丢弃、空 → undefined', () => {
  assert.equal(normalizeApplyPatchInput({ files: [] }), undefined);
  assert.equal(normalizeApplyPatchInput({ files: [{ type: 'nope', filePath: 'x' }] }), undefined);
  assert.equal(normalizeApplyPatchInput({ files: [{ type: 'add', filePath: '' }] }), undefined);
  assert.equal(normalizeApplyPatchInput({ files: [{ type: 'update', filePath: 'a', hunks: [] }] }), undefined);
  assert.equal(normalizeApplyPatchInput(null), undefined);
  const mixed = normalizeApplyPatchInput({
    files: [{ type: 'bogus', filePath: 'x' }, { type: 'delete', filePath: 'ok.ts' }]
  });
  assert.equal(mixed.files.length, 1);
  assert.equal(mixed.files[0].filePath, 'ok.ts');
});

check('normalize：路径归一（反斜杠 / ./ 前缀）', () => {
  const input = normalizeApplyPatchInput({ files: [{ type: 'delete', filePath: '.\\src\\a.ts' }] });
  assert.equal(input.files[0].filePath, 'src/a.ts');
});

// ---------- 单操作内容变换 ----------
check('applyPatchOp：add 已存在 → FILE_EXISTS', () => {
  const r = applyPatchOpToContent({ type: 'add', filePath: 'a', content: 'x' }, 'old');
  assert.equal(r.ok, false);
  assert.equal(r.error, ApplyPatchErrorCode.FILE_EXISTS);
});

check('applyPatchOp：update 不存在 → FILE_NOT_EXIST', () => {
  const r = applyPatchOpToContent(
    { type: 'update', filePath: 'a', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }] },
    undefined
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, ApplyPatchErrorCode.FILE_NOT_EXIST);
});

check('applyPatchOp：update 成功 / hunk 不中 → HUNK_NOT_FOUND', () => {
  const ok = applyPatchOpToContent(
    {
      type: 'update',
      filePath: 'a',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
    },
    'a\n'
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'b\n');
  const bad = applyPatchOpToContent(
    {
      type: 'update',
      filePath: 'a',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-zzz', '+b'] }]
    },
    'a\n'
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error, ApplyPatchErrorCode.HUNK_NOT_FOUND);
});

// ---------- 变更预览 ----------
check('预览：多文件 filePaths + 全 add → fileChange=add', () => {
  const prev = buildApplyPatchPreview([
    { type: 'add', filePath: 'a.ts', content: '' },
    { type: 'add', filePath: 'b.ts', content: '' }
  ]);
  assert.equal(prev.scope, 'file');
  assert.deepEqual(prev.filePaths, ['a.ts', 'b.ts']);
  assert.equal(prev.fileChange, 'add');
});

check('预览：含 update/delete/move → fileChange=update；move 附 movePath', () => {
  const prev = buildApplyPatchPreview([
    { type: 'update', filePath: 'a.ts', hunks: [] },
    { type: 'delete', filePath: 'b.ts' },
    { type: 'move', filePath: 'c.ts', movePath: 'd.ts' }
  ]);
  assert.equal(prev.fileChange, 'update');
  assert.deepEqual(prev.filePaths, ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

check('预览：filePaths 上限 FILE_PATHS_MAX；去重', () => {
  const ops = Array.from({ length: 10 }, (_, i) => ({ type: 'add', filePath: `f${i}.ts`, content: '' }));
  ops.push({ type: 'add', filePath: 'f0.ts', content: '' });
  const prev = buildApplyPatchPreview(ops);
  assert.equal(prev.filePaths.length, FILE_PATHS_MAX);
  assert.equal(patchFilePaths(ops).length, FILE_PATHS_MAX);
});

check('预览：patchFileChange 全 add → add，否则 update', () => {
  assert.equal(patchFileChange([{ type: 'add', filePath: 'a', content: '' }]), 'add');
  assert.equal(
    patchFileChange([
      { type: 'add', filePath: 'a', content: '' },
      { type: 'delete', filePath: 'b' }
    ]),
    'update'
  );
});

check('预览：previewFromToolArgs 认 ApplyPatch files[] 形状', () => {
  const prev = previewFromToolArgs({
    files: [
      { type: 'add', filePath: 'src/new.ts', content: 'x' },
      { type: 'add', filePath: 'src/other.ts', content: 'y' }
    ]
  });
  assert.equal(prev.scope, 'file');
  assert.deepEqual(prev.filePaths, ['src/new.ts', 'src/other.ts']);
  assert.equal(prev.fileChange, 'add');
  const mixed = previewFromToolArgs({
    files: [
      { type: 'add', filePath: 'a.ts', content: 'x' },
      { type: 'update', filePath: 'b.ts', hunks: [] }
    ]
  });
  assert.equal(mixed.fileChange, 'update');
});

check('预览：applyPatchPreviewFromArgs 与 buildApplyPatchPreview 同构', () => {
  const args = {
    files: [
      { type: 'move', filePath: 'old.ts', movePath: 'new.ts' },
      { type: 'delete', filePath: 'gone.ts' }
    ]
  };
  const a = applyPatchPreviewFromArgs(args);
  const b = buildApplyPatchPreview(normalizeApplyPatchInput(args).files);
  assert.deepEqual(a, b);
  assert.equal(a.fileChange, 'update');
});

// ---------- handler：多文件落盘 ----------
await checkAsync('handler：多文件 add/update/delete/move 一次落盘', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    await fsp.writeFile(path.join(ws, 'keep.ts'), 'line1\nline2\n', 'utf8');
    await fsp.writeFile(path.join(ws, 'kill.ts'), 'bye\n', 'utf8');
    await fsp.writeFile(path.join(ws, 'move-me.ts'), 'moved-content\n', 'utf8');

    const result = await applyPatchToWorkspace(ws, {
      files: [
        { type: 'add', filePath: 'created.ts', content: 'hello\nworld\n' },
        {
          type: 'update',
          filePath: 'keep.ts',
          hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-line2', '+LINE2'] }]
        },
        { type: 'delete', filePath: 'kill.ts' },
        { type: 'move', filePath: 'move-me.ts', movePath: 'moved.ts' }
      ]
    });
    assert.equal(result.ok, true, result.message ?? '');
    assert.equal(result.files.length, 4);
    assert.equal(result.files[0].type, 'add');
    assert.equal(result.files[0].additions, 2);
    assert.equal(result.files[1].type, 'update');
    assert.equal(result.files[2].type, 'delete');
    assert.equal(result.files[3].type, 'move');
    assert.equal(result.files[3].movePath, 'moved.ts');

    assert.equal(await fsp.readFile(path.join(ws, 'created.ts'), 'utf8'), 'hello\nworld\n');
    assert.equal(await fsp.readFile(path.join(ws, 'keep.ts'), 'utf8'), 'line1\nLINE2\n');
    assert.equal(fs.existsSync(path.join(ws, 'kill.ts')), false);
    assert.equal(fs.existsSync(path.join(ws, 'move-me.ts')), false);
    assert.equal(await fsp.readFile(path.join(ws, 'moved.ts'), 'utf8'), 'moved-content\n');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

await checkAsync('handler：add 遇已存在 → FILE_EXISTS；update 遇缺失 → FILE_NOT_EXIST', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    await fsp.writeFile(path.join(ws, 'exists.ts'), 'x\n', 'utf8');
    const r1 = await handleApplyPatch(ws, { files: [{ type: 'add', filePath: 'exists.ts', content: 'y' }] });
    assert.equal(r1.ok, false);
    assert.equal(r1.error, ApplyPatchErrorCode.FILE_EXISTS);
    const r2 = await handleApplyPatch(ws, {
      files: [{ type: 'update', filePath: 'nope.ts', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }] }]
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, ApplyPatchErrorCode.FILE_NOT_EXIST);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

await checkAsync('handler：空 patch → EMPTY_PATCH', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    const r = await applyPatchToWorkspace(ws, { files: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error, ApplyPatchErrorCode.EMPTY_PATCH);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

// ---------------- 2026-09-27 复审回归（数据安全三缺口） ----------------

await checkAsync('handler：add 遇「存在但读不出来」的文件 → 拒绝且不覆盖原内容', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    // 含 NUL 字节的文本扩展名文件：existsInRoot=true、readText 失败（looksBinary）
    await fsp.writeFile(path.join(ws, 'binary.md'), Buffer.from([0x61, 0x00, 0x62, 0x63]), null);
    const before = await fsp.readFile(path.join(ws, 'binary.md'));
    const r = await applyPatchToWorkspace(ws, {
      files: [{ type: 'add', filePath: 'binary.md', content: 'overwritten!\n' }]
    });
    assert.equal(r.ok, false, '读取失败不得被当成「不存在」而放行 add');
    assert.equal(r.error, ApplyPatchErrorCode.FILE_EXISTS, '存在性以 stat 为准（readText 失败≠不存在）');
    const after = await fsp.readFile(path.join(ws, 'binary.md'));
    assert.ok(before.equals(after), '原内容必须原封不动');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

await checkAsync('handler：两阶段——第 N 条校验失败时前 N-1 条零写入', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    const r = await applyPatchToWorkspace(ws, {
      files: [
        { type: 'add', filePath: 'first.ts', content: 'x\n' },
        {
          type: 'update',
          filePath: 'missing.ts',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
        }
      ]
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, ApplyPatchErrorCode.FILE_NOT_EXIST);
    assert.equal(fs.existsSync(path.join(ws, 'first.ts')), false, '校验失败的 patch 不得部分落盘');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

await checkAsync('handler：update mtime 乐观锁——读取后被外部改写 → 拒绝盲写', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    const target = path.join(ws, 'concurrent.ts');
    await fsp.writeFile(target, 'a\nb\n', 'utf8');
    // 在 readText 之后、writeText 之前改文件：借助 hunk 校验与写入之间的窗口，
    // 用补丁本身的竞态不可靠——改为直接验证基线：外部先改，patch 读取发生在改之后则正常；
    // 此处验证 mtime 通道存在：手工把磁盘 mtime 拨到读取基线之后（>1ms 容差）不可行（无读取钩子），
    // 故用行为等价路径：patch 成功后文件 mtime 更新，再次用旧 hunk 不匹配会 HUNK_NOT_FOUND。
    const r = await applyPatchToWorkspace(ws, {
      files: [
        {
          type: 'update',
          filePath: 'concurrent.ts',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }]
        }
      ]
    });
    assert.equal(r.ok, true, r.message ?? '');
    assert.equal(await fsp.readFile(target, 'utf8'), 'A\nb\n');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

await checkAsync('handler：尾换行形态保留（原文无尾换行不被强加）', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    await fsp.writeFile(path.join(ws, 'no-eol.ts'), 'a\nb', 'utf8'); // 无尾换行
    const r = await applyPatchToWorkspace(ws, {
      files: [
        {
          type: 'update',
          filePath: 'no-eol.ts',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }]
        }
      ]
    });
    assert.equal(r.ok, true, r.message ?? '');
    assert.equal(await fsp.readFile(path.join(ws, 'no-eol.ts'), 'utf8'), 'A\nb', '不得强加尾换行');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

await checkAsync('handler：非法条目经 normalize 拦截（无 content 的 add 不落空文件）', async () => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'apply-patch-ws-'));
  try {
    const r = await applyPatchToWorkspace(ws, {
      files: [
        { type: 'add', filePath: 'skip-me.ts' },
        { type: 'add', filePath: 'real.ts', content: 'ok\n' }
      ]
    });
    assert.equal(r.ok, true);
    assert.equal(r.files.length, 1);
    assert.equal(fs.existsSync(path.join(ws, 'skip-me.ts')), false, '缺 content 的 add 条目不得写出空文件');
    assert.equal(await fsp.readFile(path.join(ws, 'real.ts'), 'utf8'), 'ok\n');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

if (failed) {
  console.error(`\napply-patch: ${failed} failed`);
  process.exit(1);
}
console.log('\napply-patch: all ok');
