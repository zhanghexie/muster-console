// Task-specific asset preparation for the existing UI verification harness.
// The skill remains unchanged; production AgentFloat imports WebP workspace icons.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildSync} from 'esbuild';
const root=process.cwd(),fixture=path.join(root,'.tmp','memory-subsystem-fixture.mjs');
fs.mkdirSync(path.dirname(fixture),{recursive:true});
buildSync({entryPoints:[path.join(root,'test/fixtures/memory-subsystem.tsx')],outfile:fixture,bundle:true,platform:'browser',format:'esm',jsx:'automatic',
  loader:{'.webp':'dataurl','.png':'dataurl','.svg':'dataurl','.jpg':'dataurl','.jpeg':'dataurl','.gif':'dataurl'},
  define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false'}});
const result=spawnSync(process.execPath,[path.join(root,'.agents/skills/ui-verification/scripts/capture-component.mjs'),
  '--fixture',fixture,'--scenario','test/fixtures/memory-subsystem-scenario.mjs','--target','.memory-subsystem-fixture',
  '--styles','base,skel,side,float,left,selection,agent-chat,markdown,chat,mail-envelope,turn-changes,harness,board,memory,responsive,mobile,material',
  ...process.argv.slice(2)],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
