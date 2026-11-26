/** 生产 AgentFloat + CSS：窄栏悬浮状态不能挤出对话按钮。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireTestLease } from './helpers/lease.mjs';
import { execute } from './helpers/execute.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
try {
const result = await execute(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/agent-float-status-width.tsx',
  '--scenario', 'test/fixtures/agent-float-status-width-scenario.mjs',
  '--target', '.left-ws-slot', '--styles', 'base,chat,markdown,agent-chat,float,left',
  '--out', '.tmp/ui-captures/status-width-regression',
  '--themes', 'dark,light', '--widths', '780'
], { cwd: root, env: process.env, timeoutMs: 55000 });
process.stdout.write(result.out);
if (result.timedOut) throw new Error('Status width verification timed out; incomplete.');
process.exitCode = result.code;
} finally { release(); }
