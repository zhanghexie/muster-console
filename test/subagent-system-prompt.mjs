/** Materialization chooses the parent mailbox hint from the session and toolset. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-system-prompt-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { materializeGuiWorkerPrompt } = await import(pathToFileURL(compile('main/agentSession/prompt.ts')).href);
  for (const runtimeId of ['pi', 'claude', 'codex-gui', 'acp', 'pi-external', 'zcode-gui']) {
    for (const parentSessionId of [undefined, 'parent']) {
      const { text: prompt } = materializeGuiWorkerPrompt({ id: 'child-session', cwd: tmp, parentSessionId }, 'default', {
        runtimeId, hostTools: [{ id: 'host.mail.send' }]
      });
      assert.equal(prompt.includes('You are a subagent running in your own Muster session.'), !!parentSessionId);
      assert.equal(prompt.includes('to="parent"'), !!parentSessionId);
      if (parentSessionId) assert.match(prompt, /host_mail_send/);
      assert.doesNotMatch(prompt, /sessions_reportParent|Registered Tools/);
    }
  }
  console.log('ok: subagent delivery uses the same mailbox across engines');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
