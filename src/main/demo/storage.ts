import { t } from '../../shared/i18n';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DemoOptions } from './options';

const marker = 'muster-local-demo-v1\n';
const sceneMarker = 'muster-local-demo-scene-v1\n';
const ignoreContents = '*\n';
function exists(target: string) { return fs.lstatSync(target, { throwIfNoEntry: false }); }
function owns(dir: string, expected: string) {
  const stamp = path.join(dir, 'owner');
  return exists(stamp)?.isFile() && fs.readFileSync(stamp, 'utf8') === expected;
}
function directory(target: string) {
  const stat = exists(target);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(t('演示路径必须是本地目录：{{path}}', { path: target }));
  if (!stat) fs.mkdirSync(target, { mode: 0o700 });
}
function remove(target: string) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

export function demoWorkspaceResolver(storeRoot: string, work: string) {
  const physical = fs.realpathSync(storeRoot);
  const storage = path.join(work, 'workspace-data');
  directory(storage);
  return (id: string, roots: readonly { path: string }[]) => {
    for (const source of roots) {
      let project = path.resolve(source.path);
      try { project = fs.realpathSync(project); } catch { /* Preserve previously registered offline roots. */ }
      const relative = path.relative(physical, project);
      if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
        throw new Error(t('请选择演示数据目录以外的项目文件夹。'));
      }
    }
    const dir = path.join(storage, createHash('sha256').update(id).digest('hex'));
    directory(dir);
    return dir;
  };
}

/** Acquire before touching a scene. SQLite releases this OS lock even after a crash. */
export function openDemoStore(base: string, mode: DemoOptions['mode']) {
  const root = path.resolve(base, '.muster-demo');
  if (!exists(root) && mode !== 'build') return null;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  // A terminal opened from the demo has its own TEMP and HOME. Every caller
  // targeting this store must still use the same inode, even across deletion.
  const locks = path.join(path.dirname(root), '.muster-demo-lock');
  directory(locks);
  const ignore = path.join(locks, '.gitignore'), lockMarker = '# Muster demo coordination v1\n*\n';
  if (!exists(ignore) && !fs.readdirSync(locks).length) fs.writeFileSync(ignore, lockMarker, { flag: 'wx' });
  if (!exists(ignore)?.isFile() || fs.readFileSync(ignore, 'utf8') !== lockMarker) throw new Error(t('演示锁目录归属不匹配：{{path}}', { path: locks }));
  const lock = path.join(locks, 'lock.sqlite');
  if (exists(lock) && !exists(lock)?.isFile()) throw new Error(t('演示锁路径异常：{{path}}', { path: lock }));
  const db = new DatabaseSync(lock);
  try { db.exec('BEGIN EXCLUSIVE'); }
  catch (error) { db.close(); throw new Error(t('Demo 数据正在使用或无法加锁。请退出正在使用这些数据的演示实例。'), { cause: error }); }
  try {
    const newRoot = !exists(root);
    if (newRoot && mode !== 'build') { db.close(); return null; }
    directory(root);
    const stamp = path.join(root, 'owner');
    if (newRoot && mode === 'build') {
      fs.writeFileSync(stamp, marker, { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(root, '.gitignore'), ignoreContents, { flag: 'wx' });
    }
    if (!owns(root, marker)) throw new Error(t('该目录不是集序创建的 demo 数据目录：{{path}}', { path: root }));
  } catch (error) { db.close(); throw error; }
  return { root, close: () => db.close() };
}

export function recommendedDemoProject(base: string, scene: string) {
  const parent = path.join(base, '.muster-demo-projects');
  const fresh = !exists(parent);
  directory(parent);
  if (fresh) fs.writeFileSync(path.join(parent, '.gitignore'), ignoreContents, { flag: 'wx' });
  return path.join(parent, scene);
}

export function prepareScene(root: string, opts: DemoOptions) {
  const scenes = path.join(root, 'scenes');
  const scene = path.join(scenes, opts.scene);
  const work = path.join(scene, 'work'), saved = path.join(scene, 'authored');
  const staging = path.join(scene, 'copying'), recordings = path.join(scene, 'recordings');
  if (exists(scenes)) directory(scenes);
  if (opts.mode === 'delete') {
    const entries = opts.allScenes && exists(scenes) ? fs.readdirSync(scenes).map(name => path.join(scenes, name)) : [scene];
    for (const entry of entries) {
      if (!exists(entry)) continue;
      if (!exists(entry)?.isDirectory() || !owns(entry, sceneMarker)) {
        if (!opts.allScenes) throw new Error(t('该目录不是集序创建的演示场景：{{path}}', { path: entry }));
        continue;
      }
      for (const part of ['work', 'authored', 'copying', 'viewer', 'recordings']) remove(path.join(entry, part));
      fs.unlinkSync(path.join(entry, 'owner'));
      if (!fs.readdirSync(entry).length) fs.rmdirSync(entry);
    }
    if (exists(scenes) && !fs.readdirSync(scenes).length) fs.rmdirSync(scenes);
    if (opts.allScenes && fs.readdirSync(root).every(f => f === 'owner' || f === '.gitignore')) {
      const ignore = path.join(root, '.gitignore');
      if (exists(ignore)?.isFile() && fs.readFileSync(ignore, 'utf8') === ignoreContents) fs.unlinkSync(ignore);
      fs.unlinkSync(path.join(root, 'owner'));
      if (!fs.readdirSync(root).length) fs.rmdirSync(root);
    }
    return { work, recordings };
  }
  if (opts.mode !== 'build' && !exists(scene)) {
    if (opts.list) return { work, recordings };
    throw new Error(t('场景尚未搭建，请先使用 demo-build --scene {{scene}}', { scene: opts.scene }));
  }
  const newScene = !exists(scene);
  directory(scenes); directory(scene);
  if (newScene) fs.writeFileSync(path.join(scene, 'owner'), sceneMarker, { flag: 'wx', mode: 0o600 });
  if (!owns(scene, sceneMarker)) throw new Error(t('该目录不是集序创建的演示场景：{{path}}', { path: scene }));
  if (opts.record || exists(recordings)) directory(recordings);
  if (opts.replay) directory(path.join(scene, 'viewer'));
  if (opts.replay || opts.list) return { work, recordings };
  // The live path never changes, including absolute workspace, Git worktree and
  // native session references. Only a quiescent, locked tree is ever moved.
  if (exists(saved)) {
    directory(saved);
    remove(work);
    fs.renameSync(saved, work);
  }
  remove(staging);
  if (opts.mode === 'build') { directory(work); return { work, recordings }; }
  if (!exists(work)) throw new Error(t('场景没有可运行的搭建数据。'));
  directory(work);
  fs.renameSync(work, saved);
  try {
    fs.cpSync(saved, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
      filter(file) {
        const s = fs.lstatSync(file);
        if (s.isSocket() || s.isFIFO()) return false;
        // Only Chromium-owned top-level lock names, never project files of the same name.
        return !/^chromium[/\\]Singleton(Cookie|Socket|Lock)$/.test(path.relative(saved, file));
      } });
    fs.renameSync(staging, work);
  } catch (error) {
    remove(staging);
    fs.renameSync(saved, work);
    throw error;
  }
  return { work, recordings };
}
