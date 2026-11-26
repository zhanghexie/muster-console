import fs from 'node:fs';
import path from 'node:path';

/** Remove only a real direct child created under this checkout's .tmp directory. */
export function removeWorkspaceFixture(target, prefix) {
  const workspace = fs.realpathSync.native(process.cwd());
  const tmp = path.join(workspace, '.tmp');
  const tmpStat = fs.lstatSync(tmp);
  if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) throw new Error('Refusing a linked workspace temporary directory');
  const root = fs.realpathSync.native(tmp);
  const expected = path.resolve(tmp);
  if (process.platform === 'win32' ? root.toLowerCase() !== expected.toLowerCase() : root !== expected) {
    throw new Error('Refusing a workspace temporary directory outside the checkout');
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to remove a non-directory test fixture');
  const resolved = fs.realpathSync.native(target);
  const parentMatches = process.platform === 'win32'
    ? path.dirname(resolved).toLowerCase() === root.toLowerCase() : path.dirname(resolved) === root;
  if (!parentMatches || !path.basename(resolved).startsWith(prefix)) throw new Error('Refusing to remove a test fixture outside the workspace');
  fs.rmSync(resolved, { recursive: true, force: true });
}
