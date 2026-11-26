import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-native-permission-'));
const compile = createSharedCompiler(root, tmp);
const { resolveAcpPermission } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/permission.ts')).href);
const { automaticAcpPermissions, applyNativePermissionStrategy } = await import(
  pathToFileURL(compile('main/agentSession/drivers/nativePermissionPolicy.ts')).href
);
const cwd = path.join(tmp, 'workspace');
fs.mkdirSync(cwd);
const ids = ['enable-for-session', 'enable-once', 'decline-once', 'decline-always'];
const options = ['allow_always', 'allow_once', 'reject_once', 'reject_always'].map((kind, index) => ({
  optionId: ids[index], kind, name: `Native choice ${index}`
}));
const params = { options, toolCall: { toolCallId: 'call-1', name: 'bash', title: 'Run workspace operation', rawInput: { command: 'pwd' } } };
const cancelled = { outcome: { outcome: 'cancelled' } };
const input = { cwd, hostTools: [], getPolicyState() { throw new Error('must not use host mode'); }, log() {} };

try {
  for (const id of ids) {
    const result = await resolveAcpPermission({ params, cancelled: () => false,
      input: { ...input, requestApproval: async request => {
        assert.equal(request.toolName, 'Run workspace operation');
        assert.deepEqual(request.nativeChoices.map(choice => [choice.id, choice.kind, choice.scope]), [
          [ids[0], 'allow_always', 'persistent'], [ids[1], 'allow_once', 'once'],
          [ids[2], 'reject_once', 'once'], [ids[3], 'reject_always', 'persistent']
        ]);
        return { nativeChoiceId: id };
      } } });
    assert.deepEqual(result, { outcome: { outcome: 'selected', optionId: id } });
  }
  assert.deepEqual(await resolveAcpPermission({ params, cancelled: () => false,
    input: { ...input, requestApproval: async () => ({ nativeChoiceId: 'unoffered' }) } }), cancelled);
  const signal = new AbortController();
  const pending = resolveAcpPermission({ params, cancelled: () => false, signal: signal.signal,
    input: { ...input, requestApproval: () => new Promise(() => {}) } });
  signal.abort();
  assert.deepEqual(await pending, cancelled);
  fs.mkdirSync(path.join(cwd, '.muster'));
  const rules = path.join(cwd, '.muster', 'tool-rules.json');
  const impossible = { ...input, requestApproval: () => { throw new Error('rule must deny before showing choices'); } };
  for (const rule of [{ tool: 'bash', action: 'deny' }, { tool: 'bash', action: 'rewrite', rewrite: { command: 'echo rewritten' } }]) {
    fs.writeFileSync(rules, JSON.stringify([rule]));
    assert.deepEqual(await resolveAcpPermission({ params, cancelled: () => false, input: impossible }), cancelled);
  }
  const choice = (value, name = value, disabled) => ({ value, name, disabled });
  const directory = { status: 'ready', options: [
    { id: 'workflow', changePolicy: 'live', type: 'select', choices: [choice('yolo')] },
    { id: 'mode', changePolicy: 'live', type: 'select', choices: [choice('plan'), choice('build', 'Full access')] },
    { id: 'permissionMode', changePolicy: 'live', type: 'select', currentValue: 'ask',
      choices: [choice('ask'), choice('full-access', 'Anything', true), choice('yolo', 'Vendor label')] }
  ] };
  const selected = automaticAcpPermissions(directory);
  assert.deepEqual(selected, [{ id: 'permissionMode', value: 'yolo' }], 'select native IDs and ignore labels, workflows and disabled values');
  let automatic = true;
  let baseline;
  const calls = [];
  const policy = { ...input, getAutomaticPermissions: () => automatic, getNativePermissionRestore: () => baseline,
    async onNativePermissionRestore(value) { baseline = value; calls.push(value ? 'journal' : 'clear'); } };
  const read = () => directory;
  const set = async (id, value) => {
    calls.push(value);
    directory.options.find(option => option.id === id).currentValue = value;
  };
  await applyNativePermissionStrategy(policy, read, selected, set);
  automatic = false;
  await applyNativePermissionStrategy(policy, read, selected, set);
  assert.deepEqual(calls, ['journal', 'yolo', 'ask', 'clear']);
  assert.equal(baseline, undefined);
  console.log('ok: native ACP choices, persistent scopes, cancellation and explicit tool rules');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
