import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readModelRequestSource } from '../../../src/main/agentSession/modelRequestSource';
import { listModelRequests, recordingToken, saveModelRequest, setModelRequestRecording } from '../../../src/main/agentSession/modelRequestStore';
import { safeScopedKey, userDataStorage } from '../../../src/main/runtimeKernel/storageRootResolver';
import { schedulerModelRequestId } from '../../../src/shared/modelRequest';

let root: string;
const workspace = 'Workspace/One';
const scheduler = schedulerModelRequestId(workspace);
const text = '原始结果\n'.repeat(1300);

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-request-source-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function nativeFile(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'fixture.jsonl'), [
    { type: 'session', id: 'native-session' },
    { type: 'message', id: 'source', message: { role: 'toolResult', content: [{ type: 'text', text }] } }
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

function record(session: string, file?: string, nativeId = 'native-session') {
  setModelRequestRecording(root, session, true);
  saveModelRequest(root, session, recordingToken(root, session)!, { at: Date.now(), model: 'fixture', protocol: 'test', complete: true }, Buffer.from('{}'),
    file ? { file, nativeId, items: [{ kind: 'excerpt', id: 'source', path: 'messages[1].content',
      sources: [{ id: 'source', role: 'toolResult', chars: text.length }] }] } : undefined);
  return listModelRequests(root, session)[0]!.id;
}

it.each([workspace, `${workspace}:tasks`])('reads paginated original text from the recorded scheduler bucket %s', async bucket => {
  const relativeFile = path.join(safeScopedKey(bucket), 'fixture.jsonl');
  nativeFile(path.join(userDataStorage(root).resolve('app', 'pi-sessions'), path.dirname(relativeFile)));
  const call = record(scheduler, relativeFile);
  expect(await readModelRequestSource(root, scheduler, call, 'source', 0)).toEqual({ text: text.slice(0, 6000), next: 6000 });
  expect(await readModelRequestSource(root, scheduler, call, 'source', 6000)).toEqual({ text: text.slice(6000), next: null });
});

it('keeps original text scoped to the recorded call, workspace, and native session', async () => {
  const directory = userDataStorage(root).resolve('app', 'pi-sessions');
  const ownFile = path.join(safeScopedKey(workspace), 'fixture.jsonl');
  const otherFile = path.join(safeScopedKey('Workspace?One'), 'fixture.jsonl');
  nativeFile(path.join(directory, path.dirname(ownFile)));
  nativeFile(path.join(directory, path.dirname(otherFile)));
  const ownCall = record(scheduler, ownFile);
  expect(await readModelRequestSource(root, scheduler, ownCall, 'unattributed', 0)).toBeNull();
  expect(await readModelRequestSource(root, schedulerModelRequestId('Workspace?One'), ownCall, 'source', 0)).toBeNull();
  expect(await readModelRequestSource(root, scheduler, record(scheduler, otherFile), 'source', 0)).toBeNull();
  expect(await readModelRequestSource(root, scheduler, record(scheduler, ownFile, 'replaced-session'), 'source', 0)).toBeNull();
  expect(await readModelRequestSource(root, scheduler, record(scheduler), 'source', 0)).toBeNull();
});
