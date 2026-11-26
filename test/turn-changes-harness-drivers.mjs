/** Real Muse and ZCode adapters over isolated fake native protocol processes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(); fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});
const tmp = fs.mkdtempSync(path.join(root,'.tmp','turn-harness-review-'));
const compile = createSharedCompiler(root,path.join(tmp,'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { ZCodeRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/zcode/driver.ts')));
const { MuseRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/muse/driver.ts')));
const fixture = path.join(root,'test','fixtures','review-harness.cjs');
const launcher = path.join(tmp,process.platform === 'win32' ? 'review-harness.cmd' : 'review-harness');
if (process.platform === 'win32') fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
else {
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, {mode:0o755});
}
const service = new TurnChangeService(path.join(tmp,'store')), trackers = [];
try {
  for (const [name, Driver] of [['zcode',ZCodeRuntimeDriver],['muse',MuseRuntimeDriver]]) {
    const work = path.join(tmp,name); fs.mkdirSync(work);
    fs.writeFileSync(path.join(work,`${name}.txt`),'before\n');
    fs.writeFileSync(path.join(work,name === 'zcode' ? 'z-late.txt' : 'm-late.txt'),'before\n');
    const tracker = service.begin(`gui:${name}`,'m',work,[work]); trackers.push(tracker);
    const input = { sessionId:name, cwd:work, systemPromptAppend:'', hostTools:[],
      getTurnId:()=>`${name}-turn`, getPolicyState:()=>({mode:'standard',planExecuting:false}),
      requestApproval:async()=>({approved:false}), log:()=>{} };
    const driver = new Driver({getExecutable:()=>launcher});
    const connection = await driver.connect(input);
    const seen = [];
    try {
      const pump = (async () => {
        for await (const event of connection.events) {
          seen.push(event);
          if ((event.type === 'tool-start' || event.type === 'tool-update') && !event.reviewLate)
            await tracker.toolStart(event.toolCallId,event.toolName,event.input,event.toolKind);
          if (event.type === 'tool-result') await tracker.toolEnd(event.toolCallId,event.ok,event.patch,false,event.reviewChanges);
          if (event.type === 'error') throw new Error(event.message);
          if (event.type === 'turn-complete') break;
        }
      })();
      await connection.send('fixture'); await pump;
      if (name === 'zcode') assert.ok(seen.some(event => event.type === 'native-config' &&
        event.state.options[0]?.choices.some(choice => choice.value === 'build')));
      const summary = await tracker.finish();
      assert.equal(summary.files.length,1,`${name} must capture the late in-progress path`);
      assert.equal(summary.files[0].path,`${name}.txt`);
      assert.equal(summary.files[0].revertible,false);
      assert.match(service.diff(summary.id,`gui:${name}`,'m',`${name}.txt`),/\+after/);
      assert(seen.some(event => event.type === 'tool-update'),`${name} must forward a path update`);
      assert(seen.some(event => event.type === 'tool-start' && event.toolCallId.endsWith('late') && event.reviewLate),`${name} must flag completion-only starts`);
    } finally { await connection.close(); }
  }
  console.log('turn-changes-harness-drivers: real Muse and ZCode adapters handled partial and late paths');
} finally {
  await Promise.all(trackers.map(tracker => tracker.ready)); service.dispose();
  assert.equal(path.dirname(tmp),path.join(root,'.tmp'));
  await fs.promises.rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
