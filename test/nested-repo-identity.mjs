/** Real demo-* path shape, external worktrees, and physical path aliases. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(), temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nested-identity-'));
fs.symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'),process.platform==='win32'?'junction':'dir');
const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const { resolveRepoIdentity, resolveRegisteredWorktree } = await import(pathToFileURL(compile('main/git/repoIdentity.ts')).href);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', ['-c','core.longpaths=true',...args], {cwd,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
function init(dir) {
  fs.mkdirSync(dir,{recursive:true}); git(dir,'init','-q','-b','main'); git(dir,'config','user.name','Fixture'); git(dir,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(dir,'a.txt'),'base'); git(dir,'add','.'); git(dir,'commit','-qm','base'); return dir;
}
try {
  const workspace = init(path.join(temp,'中文 工作区'));
  const nested = init(path.join(workspace,'.dev-sandbox','workspaces','demo-frontend'));
  const svc = new GitService({get:()=>({workspace,activeWorkspaceId:'ws',workspaces:[{id:'ws',path:workspace}],worktreeStorageRoot:path.join(temp,'storage')})});
  const built = await svc.addSessionWorktreeGroup(nested,'40000001-demo');
  assert.equal(built.ok,true,built.message);
  assert.equal(await svc.resolveMainRepoFor(built.path),nested);
  assert.equal((await resolveRegisteredWorktree(built.path,[nested]))?.mainRepo,nested);
  if (process.platform === 'win32') {
    assert.ok(await resolveRegisteredWorktree(path.toNamespacedPath(built.path),[nested]),
      'Windows extended path for a demo-* group is the same registered worktree');
  }
  const alias = path.join(temp,'source-alias'); fs.symlinkSync(workspace,alias,process.platform==='win32'?'junction':'dir');
  const aliasNested = path.join(alias,'.dev-sandbox','workspaces','demo-frontend');
  assert.ok(await resolveRepoIdentity(aliasNested,[aliasNested]), 'a registered physical alias must resolve');
  // A linked checkout is registered under the alias, then revisited through its canonical path.
  const treeAlias = path.join(alias,'linked-demo'); git(aliasNested,'worktree','add','-q','-b','ao/alias',treeAlias);
  const treePhysical = path.join(workspace,'linked-demo');
  assert.ok(await resolveRegisteredWorktree(treePhysical,[nested]), 'canonical path must match alias registration physically');
  const broken = path.join(temp,'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken,'.git'),'gitdir: missing');
  assert.equal(await resolveRegisteredWorktree(broken,[nested]),null,'broken identities stay fail closed');
  console.log('ok: demo-frontend group ownership and registered physical aliases');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
