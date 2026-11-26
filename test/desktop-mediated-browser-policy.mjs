import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-browser-policy-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { classifyMediatedBrowserOperation: classify } = await import(pathToFileURL(compile('main/desktop/mediatedBrowserPolicy.ts')));
  const { browserAuditAction } = await import(pathToFileURL(compile('main/desktop/mediatedBrowserPolicy.ts')));
  const { DesktopAuditStore } = await import(pathToFileURL(compile('main/desktop/auditStore.ts')));
  const { HOST_BROWSER_READ_TOOLS, HOST_BROWSER_ACTION_TOOLS } = await import(pathToFileURL(compile('shared/hostTools/index.ts')));
  const argsFor = name => name === 'browser.dialog' ? { action: 'list' } : name === 'browser.recording' ? { action: 'status' } : {};
  for (const name of [...HOST_BROWSER_READ_TOOLS, ...HOST_BROWSER_ACTION_TOOLS]) assert.doesNotThrow(() => classify(name, argsFor(name)), name);
  const audit = new DesktopAuditStore(':memory:');
  for (const name of [...HOST_BROWSER_READ_TOOLS, ...HOST_BROWSER_ACTION_TOOLS]) {
    const action = browserAuditAction(name, argsFor(name));
    assert.doesNotThrow(() => audit.append({ sessionId: 'session', taskId: 'task', source: 'browser', action, stage: 'read', result: 'allowed' }), name);
  }
  audit.close();
  assert.equal(browserAuditAction('browser.evaluate', { expression: 'secret expression' }), 'evaluate');
  assert.equal(browserAuditAction('browser.cookies', { action: 'set', value: 'secret cookie' }), 'cookies-write');
  assert.equal(browserAuditAction('browser.dialog', { action: 'list' }), 'dialog-read');
  assert.equal(browserAuditAction('browser.recording', { action: 'stop' }), 'recording-stop');
  assert.deepEqual(classify('browser.evaluate', { expression: 'document.title' }),
    { target: 'tab', contentRead: true, pixelRead: true, unknownEffect: true, cleanup: false });
  assert.equal(classify('browser.click', { target: 'e1' }).unknownEffect, true);
  assert.equal(classify('browser.screenshot', {}).pixelRead, true);
  assert.equal(classify('browser.screenshot', { fullPage: true }).unknownEffect, true);
  assert.equal(classify('browser.screenshot', { selector: '#item' }).unknownEffect, true);
  assert.equal(classify('browser.movePointer', { target: '10,20' }).unknownEffect, true);
  assert.deepEqual(classify('browser.recording', { action: 'stop' }),
    { target: 'recording', contentRead: false, pixelRead: true, unknownEffect: false, cleanup: true });
  assert.equal(classify('browser.recording', { action: 'cancel' }).cleanup, true);
  assert.equal(classify('browser.recording', { action: 'start' }).cleanup, true, 'failed start may still leave a recording active');
  assert.equal(classify('browser.cookies', { action: 'set', tabId: 'x' }).target, 'profile');
  assert.equal(classify('browser.downloads', {}).target, 'profile');
  assert.equal(classify('browser.cookies', { action: 'set' }).unknownEffect, true);
  assert.equal(classify('browser.storage', { action: 'get' }).contentRead, true);
  assert.equal(classify('browser.activate', { foreground: true }).unknownEffect, true);
  assert.equal(classify('browser.activate', { foreground: false }).unknownEffect, false);
  for (const [name, args] of [['browser.future', {}], ['browser.recording', { action: 'future' }],
    ['browser.cookies', { action: 'future' }], ['browser.dialog', { action: 'future' }], ['browser.activate', { foreground: 'true' }]]) {
    assert.throws(() => classify(name, args), /Unclassified|Invalid/);
    assert.throws(() => browserAuditAction(name, args), /Unclassified|Invalid/);
  }
  console.log('browser mediation: all registered handlers classified, risky actions and unknowns fail closed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
