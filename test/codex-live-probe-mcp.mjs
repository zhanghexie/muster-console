import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-probe-mcp-'));
let child;
try {
  const server = path.join(temp, 'server.mjs');
  fs.writeFileSync(server, `import readline from 'node:readline';
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { tools: [{ name: 'host_probe' }, { name: 'host_desktop_act' }] } }));
    });\n`);
  child = spawn(process.execPath, [path.resolve('test/helpers/readonly-probe-mcp.mjs')], {
    env: { ...process.env, MUSTER_PROBE_INBOUND_SCRIPT: server }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  child.stderr.resume();
  const replies = readline.createInterface({ input: child.stdout });
  const iterator = replies[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const list = JSON.parse((await iterator.next()).value);
  assert.deepEqual(list.result.tools[0].annotations, { readOnlyHint: true, destructiveHint: false });
  assert.equal(list.result.tools[1].annotations, undefined, 'unrelated tools must retain the native approval policy');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }) + '\n');
  const call = JSON.parse((await iterator.next()).value);
  assert.equal(call.result.tools[0].annotations, undefined, 'only tools/list responses may be changed');
  child.stdin.end();
  assert.equal((await once(child, 'close'))[0], 0);
  child = undefined;
  console.log('Codex live probe MCP proxy: only the no-op tools/list entry is annotated');
} finally {
  child?.kill();
  removeWorkspaceFixture(temp, 'codex-probe-mcp-');
}
