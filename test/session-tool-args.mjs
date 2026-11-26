import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tool-args-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const load = async p => import(pathToFileURL(compile(p)).href);
  const { validateObserveMode: observe, normalizeMailboxOffsets: mail } = await load('shared/sessionToolArgs.ts');
  observe({mode:'directory',limit:5}); observe({mode:'detail',sessionId:'x',includeHistory:true});
  observe({mode:'detail',externalSessionId:'x'}); observe({sessionId:'x',limit:5});
  for(const args of [{mode:'detail'}, {mode:'directory',sessionId:'x'}, {mode:'directory',facts:{}},
    {mode:'detail',sessionId:'x',limit:1}, {mode:'unknown'}]) assert.throws(()=>observe(args));
  assert.deepEqual(mail({listOffset:3,includeBody:false}),{offset:3,includeBody:false});
  assert.deepEqual(mail({messageId:'m',bodyOffset:5}),{messageId:'m',offset:5});
  assert.deepEqual(mail({offset:3}),{offset:3});
  assert.deepEqual(mail({messageId:'m',bodyOffset:5,offset:5}),{messageId:'m',offset:5});
  for(const args of [{bodyOffset:1}, {messageId:'m',listOffset:1}, {listOffset:1,offset:2},
    {listOffset:1,cursor:'x'}, {listOffset:-1}, {listOffset:1.5}]) assert.throws(()=>mail(args));
  const { getToolDef } = await load('main/capabilities/catalog/api.ts');
  const { pickConfirmNote } = await load('shared/confirmDialog.ts');
  assert.equal(pickConfirmNote({reason:'legacy'}),'legacy');
  assert.equal(pickConfirmNote({reason:'legacy',confirmNote:'new'}),'new');
  assert.equal(getToolDef('sessions.delete').parameters.properties.reason,undefined);
  assert.ok(getToolDef('sessions.delete').parameters.properties.confirmNote);
  for(const name of ['sessions.setStatus','scheduler.policy.set']) assert.ok(getToolDef(name).parameters.properties.reason);
  const props=getToolDef('sessions.readMessages').parameters.properties;
  assert.equal(props.offset,undefined); assert.ok(props.listOffset && props.bodyOffset);
  assert.equal(props.waitMs,undefined); assert.equal(props.watchSessionIds,undefined);
  assert.ok(getToolDef('waitFor').parameters.properties.condition);
  console.log('session-tool-args: mode/offset contracts and confirmation alias compatibility passed');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
