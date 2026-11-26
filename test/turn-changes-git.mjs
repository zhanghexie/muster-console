/** Explicit Git integration: exact paths, ignored originals and nested roots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(root,'.tmp','turn-changes-git-'));
try {
  const compile=createSharedCompiler(root,tmp);
  const {TurnChangeService}=await import(pathToFileURL(compile('main/turnChanges/service.ts')).href);
  const work=path.join(tmp,'repo'), child=path.join(work,'plugins','child');
  fs.mkdirSync(child,{recursive:true});
  execFileSync('git',['init','--quiet',work]); execFileSync('git',['init','--quiet',child]);
  fs.writeFileSync(path.join(work,'.gitignore'),'secret.txt\nplugins/\n');
  fs.writeFileSync(path.join(work,'secret.txt'),'personal ignored original');
  fs.writeFileSync(path.join(work,'source.txt'),'old');fs.writeFileSync(path.join(child,'source.txt'),'child old');
  const service=new TurnChangeService(path.join(tmp,'store'));
  const tracker=service.begin('gui:a','m',work,[work,child]); await tracker.ready;
  await tracker.toolStart('a','write',{path:'source.txt',content:'new'},undefined,true);fs.writeFileSync(path.join(work,'source.txt'),'new');await tracker.toolEnd('a',true,undefined,true);
  await tracker.toolStart('b','write',{path:'secret.txt',content:'changed'},undefined,true);fs.writeFileSync(path.join(work,'secret.txt'),'changed');await tracker.toolEnd('b',true,undefined,true);
  await tracker.toolStart('c','write',{path:'plugins/child/source.txt',content:'child new'},undefined,true);fs.writeFileSync(path.join(child,'source.txt'),'child new');await tracker.toolEnd('c',true,undefined,true);
  const summary=await tracker.finish();
  const result=(await service.revert(summary.id,'gui:a','m',[work,child]));
  assert.deepEqual(result.restored,['source.txt','secret.txt','plugins/child/source.txt']);
  assert.equal(fs.readFileSync(path.join(work,'secret.txt'),'utf8'),'personal ignored original');
  assert.equal(fs.readFileSync(path.join(work,'source.txt'),'utf8'),'old');
  assert.equal(fs.readFileSync(path.join(child,'source.txt'),'utf8'),'child old');
  console.log('turn-changes-git: ignored originals and independent nested roots passed');
} finally {
  assert(tmp.startsWith(path.join(root,'.tmp')+path.sep));fs.rmSync(tmp,{recursive:true,force:true});
}
