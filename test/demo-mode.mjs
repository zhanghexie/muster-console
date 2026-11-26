import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-demo-test-'));
try {
  const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), tmp);
  const load = file => import(pathToFileURL(compile('main/demo/' + file + '.ts')).href);
  const { parseDemoArgs: parse, replayTitleBar } = await load('options');
  const { demoWorkspaceResolver, openDemoStore, prepareScene, recommendedDemoProject } = await load('storage');
  const { startTape, listTapes, readTape } = await load('tapes');
  assert.equal(parse(['--normal', 'demo-build']), null);
  assert.equal(parse(['--record']), null);
  assert.equal(parse(['--demo-build']).record, false);
  assert.equal(parse(['--demo-run']).record, false);
  const recordingOpts = parse(['--demo-build', '--scene', '甲', '--record']);
  assert.equal(recordingOpts.record, true);
  for (const args of [['--demo-run', '--record'], ['--demo-delete', '--record'], ['--demo-build', '--record=false']]) {
    assert.throws(() => parse(args), /--record/);
  }
  assert.equal(replayTitleBar('win32').titleBarOverlay.height, 36);
  assert.deepEqual(replayTitleBar('darwin'), { titleBarStyle: 'hiddenInset' });
  assert.deepEqual(replayTitleBar('linux'), {});
  for (const scene of ['../outside', '/root', 'C:\\work', 'NUL', 'LPT¹', 'x.y', 'a/b']) {
    assert.throws(() => parse(['--demo-delete', '--scene', scene]));
  }
  for (const args of [['--demo-run', '--demo-delete'], ['--demo-build', '--replay'], ['--demo-run', '--replay=../xx'],
    ['--demo-run', '--speed=2'], ['--demo-run', '--replay', '--from=-1'], ['--demo-run', '--list', '--replay']]) assert.throws(() => parse(args));
  assert.equal(parse(['--demo-run', '--replay', '--speed=2', '--from', '2.5']).from, 2.5);
  const base = path.join(tmp, 'existing-project');
  fs.mkdirSync(base);
  execFileSync('git', ['-C', base, 'init', '-q']);
  const file = path.join(base, 'existing.txt');
  fs.writeFileSync(file, 'work in progress');
  const opts = parse(['--demo-build', '--scene', '甲']);
  assert.equal(openDemoStore(base, 'delete'), null);
  const db = openDemoStore(base, 'build');
  try {
    const tempKey = process.platform === 'win32' ? 'TEMP' : 'TMPDIR', originalTemp = process.env[tempKey];
    try {
      process.env[tempKey] = base;
      assert.throws(() => openDemoStore(base, 'delete'), /使用或无法加锁/);
    } finally {
      if (originalTemp === undefined) delete process.env[tempKey]; else process.env[tempKey] = originalTemp;
    }
    const { work, recordings } = prepareScene(db.root, opts);
    assert.deepEqual(listTapes(recordings), []);
    assert.equal(fs.existsSync(recordings), false);
    const newProject = recommendedDemoProject(base, opts.scene);
    fs.mkdirSync(newProject);
    fs.writeFileSync(path.join(newProject, 'keep'), 'new project');
    const resolveData = demoWorkspaceResolver(db.root, work);
    assert.throws(() => resolveData('scene', [{ path: work }]), /演示数据目录以外/);
    assert.ok(resolveData('scene', [{ path: base }]).startsWith(work + path.sep));
    const marker = path.join(work, 'draft');
    fs.writeFileSync(marker, 'author');
    const external = path.join(tmp, 'outside');
    fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep'), 'original');
    fs.symlinkSync(external, path.join(work, 'workspace-link'), process.platform === 'win32' ? 'junction' : 'dir');
    prepareScene(db.root, recordingOpts);
    const tape = startTape(recordings, 900, 640);
    tape.append([{ type: 4, timestamp: 100, data: {} }]);
    assert.deepEqual(listTapes(recordings), []);
    tape.append([{ type: 2, timestamp: 101, data: { node: '初始' } }, { type: 3, timestamp: 102, data: { text: '结果' } }]);
    tape.close(); assert.equal(listTapes(recordings)[0].id, tape.id);
    fs.appendFileSync(path.join(recordings, tape.id + '.jsonl'), '{"incomplete');
    const status = execFileSync('git', ['-C', base, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
    assert.equal(status.trim(), 'existing.txt');
    const events = []; for await (const chunk of readTape(recordings, tape.id)) events.push(...chunk);
    assert.deepEqual(events.map(e => e.type), [4, 2, 3]);
    for (let i = 0; i < 2; i++) {
      const run = prepareScene(db.root, { ...opts, mode: 'run' }); assert.equal(run.work, work);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'author'); fs.writeFileSync(marker, 'only this run');
    }
    // Interrupted clone after the author tree was renamed. The next build recovers it.
    fs.rmSync(work, { recursive: true }); fs.mkdirSync(path.join(path.dirname(work), 'copying'));
    prepareScene(db.root, opts); assert.equal(fs.readFileSync(marker, 'utf8'), 'author');
    const other = prepareScene(db.root, { ...opts, scene: '乙' });
    prepareScene(db.root, { ...opts, mode: 'delete' });
    assert.equal(fs.existsSync(work), false); assert.ok(fs.existsSync(other.work));
    prepareScene(db.root, parse(['--demo-delete'])); assert.equal(fs.existsSync(db.root), false);
    assert.equal(fs.readFileSync(path.join(newProject, 'keep'), 'utf8'), 'new project');
    assert.equal(fs.readFileSync(file, 'utf8'), 'work in progress');
    assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'original');
  } finally { db.close(); }
  const unowned = path.join(base, '.muster-demo'); fs.mkdirSync(unowned);
  fs.writeFileSync(path.join(unowned, 'keep'), 'pre-existing');
  assert.throws(() => openDemoStore(base, 'delete'), /不是集序创建/);
  assert.equal(fs.readFileSync(path.join(unowned, 'keep'), 'utf8'), 'pre-existing');
  const mixed = openDemoStore(path.join(tmp, 'mixed'), 'build');
  try {
    prepareScene(mixed.root, opts);
    const foreign = path.join(mixed.root, 'scenes', '已有项目');
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'original');
    assert.throws(() => prepareScene(mixed.root, { ...opts, scene: '已有项目', mode: 'delete' }), /不是集序创建/);
    prepareScene(mixed.root, parse(['--demo-delete']));
    assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'original');
  } finally { mixed.close(); }
  console.log('Demo flags, exclusive lock, crash recovery, replay journal and existing-project preservation passed.');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
