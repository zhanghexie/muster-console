/** Real merge-tree diagnostics, same filenames in two nested repos / two task groups. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(), temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'conflict-report-'));
fs.symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'),process.platform==='win32'?'junction':'dir');
const compile = createSharedCompiler(root,path.join(temp,'compiled'));
const load = rel => import(pathToFileURL(compile(rel)).href);
const { integrateRepoGroup, precheckRepoMerge, parseMergeTreeConflictPaths } = await load('main/git/nestedRepos.ts');
const { integrateTaskWorktrees } = await load('main/git/worktreeTaskIntegrate.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const git = (cwd,...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const filename = '相同 文件.txt';
function init(main,tree) {
  fs.mkdirSync(main,{recursive:true}); git(main,'init','-q','-b','main'); git(main,'config','user.name','Fixture'); git(main,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(main,'.gitignore'),'.dev-sandbox/\n'); fs.writeFileSync(path.join(main,filename),'base'); git(main,'add','.');git(main,'commit','-qm','base');
  const baseCommit=git(main,'rev-parse','HEAD');git(main,'worktree','add','-q','-b','ao/report',tree);
  return baseCommit;
}
function edit(repo,text) {fs.writeFileSync(path.join(repo,filename),text);git(repo,'add','.');git(repo,'commit','-qm',text);}
try {
  assert.deepEqual(parseMergeTreeConflictPaths('tree\0a\nb.txt\0 file \0\0diagnostic\0CONFLICT text\0'),['a\nb.txt',' file ']);
  const main=path.join(temp,'legacy'),tree=path.join(temp,'legacy-tree'); init(main,tree);
  const paths=['.dev-sandbox/workspaces/demo-frontend','.dev-sandbox/workspaces/demo-backend'];
  const repos=paths.map(rel=>{
    const src=path.join(main,rel),wt=path.join(tree,rel); init(src,wt); edit(src,'source');edit(wt,'worker');return {path:rel,branch:'ao/report',baseBranch:'main'};
  });
  const before=[main,...paths.map(rel=>path.join(main,rel))].map(p=>git(p,'rev-parse','HEAD'));
  const pre=await precheckRepoMerge({repoMain:path.join(main,paths[0]),worktreePath:path.join(tree,paths[0]),branch:'ao/report',target:'main',label:paths[0]});
  assert.deepEqual(pre.conflicts,[filename],'merge-tree diagnostics must never appear as conflict filenames');
  const result=await integrateRepoGroup({mainRepo:main,containerRoot:tree,mainBranch:'ao/report',mainBaseBranch:'main',repos});
  assert.equal(result.ok,false);assert.equal(result.entries.filter(e=>e.status==='failed').length,2,'report every failing repo');
  for(const rel of paths) {
    assert.deepEqual(result.entries.find(e=>e.repo===rel).conflicts,[filename]);
    assert.ok(result.message.includes(rel),result.message);
  }
  assert.ok(!result.message.includes('Auto-merging'));assert.ok(!result.message.includes('CONFLICT ('));
  assert.deepEqual([main,...paths.map(rel=>path.join(main,rel))].map(p=>git(p,'rev-parse','HEAD')),before,'all-or-nothing preflight leaves every HEAD unchanged');
  const groups=['frontend','backend'].map(id=>{
    const src=path.join(temp,id),wt=path.join(temp,`${id}-tree`),baseCommit=init(src,wt);edit(src,'source');edit(wt,'worker');
    const sourceRoot={rootId:id,path:src,cwd:src,physicalPath:sourcePathKey(src)};
    return {id,path:wt,sourceRoot,source:{mainRepo:src,commonDir:path.join(src,'.git')},branch:'ao/report',baseBranch:'main',baseCommit,repos:[]};
  });
  const ws={id:'ws',path:groups[0].source.mainRepo,controlRoot:groups[0].source.mainRepo,defaultRootId:'frontend',rootsRevision:1,roots:groups.map(g=>({id:g.id,path:g.source.mainRepo}))};
  const cfg={workspaces:[ws],activeWorkspaceId:'ws'};
  const session={id:'task-report',name:'Report',type:'terminal',workspaceId:'ws',cwd:groups[0].path,sourceRoot:groups[0].sourceRoot,worktreeGroups:{version:1,primaryGroupId:'frontend',groups}};
  normalizeSessionWorktrees(session);
  const taskBefore=groups.map(g=>git(g.source.mainRepo,'rev-parse','HEAD'));
  const ctx={config:{get:()=>cfg},workspaceIdFor:()=>ws.id,findSession:()=>session,persist(){},broadcast(){}};
  const task=await integrateTaskWorktrees(ctx,session,{skipNpmInstall:true,skipTypecheck:true});
  assert.equal(task.ok,false); assert.ok(task.message.includes('frontend/.'),task.message);assert.ok(task.message.includes('backend/.'),task.message);
  for(const group of task.groups) {assert.equal(group.repos[0].status,'failed');assert.deepEqual(group.repos[0].conflicts,[filename]);}
  assert.deepEqual(groups.map(g=>git(g.source.mainRepo,'rev-parse','HEAD')),taskBefore);
  console.log('ok: nested and cross-group conflicts are grouped, exact, and zero-write');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
