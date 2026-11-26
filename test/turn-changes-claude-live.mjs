/** Opt-in real Claude SDK/model probe. It only edits a disposable fixture file. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

if (process.env.MUSTER_TEST_REVIEW_CLAUDE !== '1') { console.log('turn-changes-claude-live: skipped (opt-in)'); process.exit(0); }
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive:true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-claude-live-'));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const target = path.join(work, 'sample.txt'); fs.writeFileSync(target, 'red\nblue\n');
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { createClaudeReviewHooks } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/reviewCapture.ts')));
const { resolveClaudeExecutable } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/claudeSdk.ts')));
const service = new TurnChangeService(path.join(tmp, 'store'));
const tracker = service.begin('gui:live-claude', 'm', work, [work]);
const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 100_000);
const logs = []; let handle;
try {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_)/i.test(key)) delete env[key];
  env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const executable = await resolveClaudeExecutable();
  handle = query({ prompt:'Use the Edit tool to change only sample.txt: replace red with green, preserving the other line. Then reply done.',
    options:{ cwd:work, env, tools:['Edit'], settingSources:[], strictMcpConfig:true, mcpServers:{}, persistSession:false,
      ...(executable.executable ? { pathToClaudeCodeExecutable:executable.executable } : {}),
      permissionMode:'default', maxTurns:3, abortController:abort,
      canUseTool:async (name, input) => name === 'Edit' && path.resolve(work, String(input.file_path ?? '')) === target
        ? { behavior:'allow', updatedInput:input } : { behavior:'deny', message:'Only the isolated test file may be edited.' },
      hooks:createClaudeReviewHooks({ tracker:() => tracker, turnId:() => 'turn', isCurrent:() => !abort.signal.aborted, log:message => logs.push(message) }) } });
  let completed = false, error = '';
  for await (const event of handle) {
    if (event.type === 'result') { completed = event.subtype === 'success'; if (!completed) error = event.subtype; }
  }
  assert.equal(completed, true, `Claude did not complete the isolated turn (${error})`);
  assert.equal(fs.readFileSync(target, 'utf8'), 'green\nblue\n');
  const summary = await tracker.finish();
  assert.equal(summary.files.length, 1); assert.equal(summary.files[0].revertible, true);
  assert.deepEqual((await service.revert(summary.id, 'gui:live-claude', 'm', [work])).restored, ['sample.txt']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'red\nblue\n');
  assert.deepEqual(logs, []);
  console.log('turn-changes-claude-live: real Claude SDK/model edit and safe revert passed');
} catch (error) {
  console.error(`turn-changes-claude-live failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer); abort.abort(); handle?.close(); await tracker.ready; service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
