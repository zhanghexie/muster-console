import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-probe-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const { hiddenConsoleProcessList } = await import(pathToFileURL(compile('main/pty/consoleProcessList.ts')));
  for (const mode of ['valid', 'invalid', 'exit', 'error', 'timeout']) {
    let killed = 0;
    const launch = (file, args, options) => {
      assert.equal(file, 'fixture'); assert.deepEqual(args, ['123']);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.deepEqual(options.execArgv, []);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      const child = new EventEmitter(); child.kill = () => { killed++; return true; };
      setTimeout(() => {
        if (mode === 'valid') child.emit('message', {consoleProcessList:[123,456]});
        if (mode === 'invalid') child.emit('message', {consoleProcessList:[-1]});
        if (mode === 'exit') child.emit('exit', 1);
        if (mode === 'error') child.emit('error', Error('spawn failed'));
      }, 1);
      return child;
    };
    const keepAlive = setTimeout(() => {}, 100);
    assert.deepEqual(await hiddenConsoleProcessList(123, {launch, helper:'fixture', timeoutMs:10}), mode === 'valid' ? [123,456] : [123]);
    clearTimeout(keepAlive);
    assert.equal(killed, 1);
  }
  console.log('pty console probe: hidden Node helper, bounded exit/error/invalid/timeout passed');
} finally { fs.rmSync(tmp, {recursive:true,force:true}); }
