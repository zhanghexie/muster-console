import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareKimiSession, splitKimiLaunchArgs } from '../src/main/runtime/builtins/scripts/_kimi-acp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-test-'));
const fixture = path.resolve('test/fixtures/fake-kimi-acp.mjs');
const log = path.join(tmp, 'rpc.jsonl');
const fakeSpawn = (_argv, opts) => {
  const child = spawn(process.execPath, [fixture], { ...opts, env: { ...opts.env, KIMI_TEST_LOG: log } });
  return { child, dispose() { child.kill(); } };
};
try {
  const parts = splitKimiLaunchArgs(['--model=provider/one', '-m', 'provider/two', '--plan', '--add-dir', '/extra', '--yolo']);
  assert.deepEqual(parts, { args: ['--add-dir', '/extra', '--yolo'], model: 'provider/two', plan: true, additionalDirectories: ['/extra'] });
  for (const flag of ['--session', '--continue', '--agent', '--agent-file']) assert.throws(() => splitKimiLaunchArgs([flag, 'x']), /不能与/);
  const sessionId = await prepareKimiSession({ cwd: tmp, ...parts, reasoning: 'low' }, fakeSpawn);
  assert.equal(sessionId, 'session_test');
  let messages = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.filter(m => m.method === 'session/set_config_option').map(m => [m.params.configId, m.params.value]),
    [['model', 'provider/two'], ['thinking', 'low'], ['mode', 'plan']]);
  assert.deepEqual(messages.find(m => m.method === 'session/new').params.additionalDirectories, ['/extra']);
  assert.equal(messages.at(-1).method, 'session/close');
  await assert.rejects(prepareKimiSession({ cwd: tmp, reasoning: 'max' }, fakeSpawn), /不支持所选思考强度/);
  messages = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(messages.at(-1).method, 'session/delete');
  await assert.rejects(prepareKimiSession({ cwd: tmp, reasoning: 'low', env: { KIMI_TEST_SCENARIO: 'refuse' } }, fakeSpawn), /未确认所选思考强度/);
  console.log('Kimi ACP model/effort preparation, session handoff and refusal paths passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
