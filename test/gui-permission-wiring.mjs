/**
 * Core owns its permission policy. External approval handlers preserve native
 * choices and enforce the separate host boundary when a call is observable.
 * 运行: node test/gui-permission-wiring.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, 'src/main/agentSession/drivers', rel), 'utf8');
assert.match(read('pi/approvalExtension.ts'), /decideToolCallPermission/);
for (const rel of ['acp/permission.ts', 'claude/canUseTool.ts', 'muse/driver.ts', 'zcode/driver.ts']) {
  const src = read(rel);
  assert.match(src, /evaluateNativeToolBoundary/, rel);
  assert.match(src, /nativeChoices/, rel);
  assert.doesNotMatch(src, /decideToolCallPermission|getPolicyState/, rel);
}

console.log('gui-permission-wiring: ok');
