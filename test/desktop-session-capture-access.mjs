import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-session-captures-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { sessionCaptureDirectory, prepareSessionCaptureDirectory, withSessionCaptureReadAccess } =
    await import(pathToFileURL(compile('main/desktop/sessionCaptureAccess.ts')));
  const { pathInExecutionDirectories, additionalExecutionDirectories } =
    await import(pathToFileURL(compile('main/workspaceExecutionContext.ts')));
  const userData = path.join(temp, 'user-data'); fs.mkdirSync(userData);
  const context = { cwd: temp, readableDirectories: [], writableDirectories: [] };
  const first = withSessionCaptureReadAccess(context, userData, 'session-A');
  const second = withSessionCaptureReadAccess(context, userData, 'session-B');
  const fileA = path.join(sessionCaptureDirectory(userData, 'session-A'), 'screen.png');
  fs.writeFileSync(fileA, 'data');
  assert.equal(pathInExecutionDirectories(fileA, temp, first.readableDirectories), true);
  assert.equal(pathInExecutionDirectories(fileA, temp, second.readableDirectories), false);
  assert.deepEqual(additionalExecutionDirectories(first), [], 'capture read scope is never a native write root');
  assert.equal(withSessionCaptureReadAccess(first, userData, 'session-A'), first, 'scope addition is idempotent');
  assert.equal(path.dirname(sessionCaptureDirectory(userData, '../other')), path.join(userData, 'desktop-captures'));
  assert.throws(() => sessionCaptureDirectory('relative', 'session'), /absolute/);
  assert.throws(() => sessionCaptureDirectory(userData, ' '), /identity/);
  assert.equal(withSessionCaptureReadAccess(undefined, userData, 'session'), undefined);

  const otherUser = path.join(temp, 'other-user'), outside = path.join(temp, 'outside');
  fs.mkdirSync(otherUser); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(otherUser, 'desktop-captures'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareSessionCaptureDirectory(otherUser, 'session'), /not a managed directory/);
  assert.throws(() => withSessionCaptureReadAccess(context, otherUser, 'session', false), /not a managed directory/);
  assert.deepEqual(fs.readdirSync(outside), [], 'reject root redirection before creating a session directory');
  const redirected = sessionCaptureDirectory(userData, 'redirected');
  fs.symlinkSync(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareSessionCaptureDirectory(userData, 'redirected'), /not managed/);
  assert.throws(() => withSessionCaptureReadAccess(context, userData, 'redirected', false), /not managed/);
  console.log('desktop capture scope: session isolation, read-only projection and redirected paths passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
