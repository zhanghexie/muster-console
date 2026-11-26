import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-panel-window-'));
const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), tmp);
const electron = path.join(tmp, 'node_modules/electron'); fs.mkdirSync(electron, { recursive: true });
fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
fs.writeFileSync(path.join(electron, 'index.js'), `import {EventEmitter} from 'node:events';
export const app={getPath:()=>${JSON.stringify(tmp)}}; export const shell={openExternal(){}};
export class WebContentsView {constructor(){throw Error('Ordinary extensions must not create native child views');}}
export class BrowserWindow extends EventEmitter {
 constructor(){super();globalThis.__popup=this;this.webContents=new EventEmitter();this.webContents.id=42;this.webContents.setWindowOpenHandler=()=>{};this.webContents.send=()=>{};this.dead=false;}
 loadURL(){return new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}
 isDestroyed(){return this.dead;} show(){} focus(){} destroy(){this.dead=true;this.emit('closed');}
}`);
globalThis.__dirname = tmp;
try {
  const { ExtensionPanelViews } = await import(pathToFileURL(compile('main/extensions/panelViews.ts')));
  const sent = [], calls = [];
  const ctx = { auxRendererIds: new Set(), getWindow: () => ({ webContents: { send: (...args) => sent.push(args) } }), config: { get: () => ({ workspaces: [] }) } };
  const instance = { token: 'token', extensionId: 'demo', workspaceId: 'ws', instanceId: 'instance', generation: 1, permissions: [], entry: 'board.html', extension: { name: 'Demo' } };
  const panels = new ExtensionPanelViews(ctx, async (identity, call) => { calls.push([identity, call]); return { ok: true }; });
  panels.create(instance); assert.equal(globalThis.__popup, undefined, 'embedded instances allocate metadata only');
  panels.place('token', 'window'); const popup = globalThis.__popup;
  await panels.call(42, { method: 'storage.keys', args: [] }); assert.equal(calls[0][0], instance);
  assert.throws(() => panels.init(99), /未绑定/);
  popup.emit('close');
  popup.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', '', true);
  popup.reject(Error('ERR_FAILED during close')); popup.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(([channel]) => channel === 'workbench:panelReturned').length, 1);
  assert.equal(sent.filter(([channel]) => channel === 'workbench:panelError').length, 0, 'late load failure from closed popup cannot invalidate iframe');
  panels.place('token', 'window'); globalThis.__popup.reject(Error('real load failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(([channel]) => channel === 'workbench:panelError').length, 1, 'live errors stay explicit');
  panels.release('token'); assert.throws(() => panels.init(42), /未绑定/);
  console.log('extension panel window: no native child views / sender binding / late close error regression passed');
} finally { delete globalThis.__popup; fs.rmSync(tmp, { recursive: true, force: true }); }
