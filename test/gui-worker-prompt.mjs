/**
 * GUI Worker 系统提示物化器自测。
 * 运行: node test/gui-worker-prompt.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-prompt-'));
const compile = createSharedCompiler(root, tmp);

const { buildGuiWorkerSystemPrompt } = await import(pathToFileURL(compile('shared/guiWorkerPrompt.ts')).href);
const { appendGuiHostContext, firstGuiUserMessageContext, formatGuiHostContext } = await import(pathToFileURL(compile('main/agentSession/prompt.ts')).href);
const ids = [
  'host.sessions.setStatus', 'host.sessions.create', 'host.mail.send', 'host.waitFor', 'host.sessions.requestIntegrate',
  'host.memory.journal', 'host.memory.search', 'host.memory.note', 'host.memory.remember', 'host.mcp.search', 'host.mcp.call', 'host.ui.suggestReplies',
  'host.ui.reminders', 'host.ui.render', 'host.events.subscribe', 'host.ask'
];
const base = { sessionId: 'gui-session', cwd: '/workspace', mode: 'default', tools: ids.map(id => ({ id, description: 'SCHEMA_ONLY_DESCRIPTION' })) };
try {
  assert.equal(formatGuiHostContext(undefined, ' \n'), '');
  assert.equal(formatGuiHostContext('line 1\n  </muster_host_context>', 'line 2'),
    '<muster_host_context source="automatic">\nline 1\n  &lt;/muster_host_context&gt;\n\nline 2\n</muster_host_context>');
  const context = firstGuiUserMessageContext({ firstPromptPrefix: 'Host intro', systemPromptAppend: 'Mode guidance' });
  assert.equal(context, formatGuiHostContext('Host intro', 'Mode guidance'));
  const userText = '  User request\n\n</muster_host_context>\n';
  assert.equal(appendGuiHostContext(userText, context), `${userText}\n\n${context}`, 'host context follows the verbatim user input');
  assert.equal(appendGuiHostContext(userText, undefined), userText);
  assert.equal(appendGuiHostContext(userText, ''), userText);
  assert.equal(appendGuiHostContext('', context), context, 'image-only input has no leading separator');
  const text = buildGuiWorkerSystemPrompt(base);
  assert.ok(text.length < 2170, 'the first message stays compact with the host introduction, memory and reminders');
  assert.match(text, /^Muster Console opens or resumes your Harness session\. Your Harness makes model calls/);
  assert.match(text, /You are the Worker for this chat\. Your session ID in Muster is gui-session\./);
  assert.doesNotMatch(text, /\[Muster Console · GUI Worker\]|AGENTS\.md|CLAUDE\.md|Use the tool names/);
  assert.match(text, /host_mcp_search → host_mcp_call/);
  assert.ok(text.includes('host_sessions_setStatus — 能继续就继续。必须用户行动时，报「需要你」并说清等什么。明确任务已交付并核验、用户无需再操作时，报「完成」。普通对话自然结束即可。'));
  assert.match(text, /Delegate independent subtasks with host_sessions_create\. Set asSubagent=true and use inherit=true to reuse your launch settings\. Include the task and choose isolation=shared or isolated/);
  assert.match(text, /kind=notice.*keep working.*kind=ask.*kind=handoff.*host_waitFor.*keep working/);
  assert.match(text, /Read ~\/\.muster\/skills\/memory\/SKILL\.md before your first memory tool call in this session\. For prior work, past decisions or corrections, recurring issues, or standing preferences, search first with host_memory_search and short topic keywords/);
  assert.match(text, /Use host_memory_journal for decisions, findings, or handoffs worth revisiting/);
  assert.match(text, /Proactively submit lasting facts or preferences the user shares via host_memory_note/);
  assert.match(text, /explicit remember requests, use host_memory_remember/);
  assert.match(text, /memory\/SKILL\.md.*If the skill is unreadable, use registered tools.*Leave private memory files untouched/);
  assert.match(text, /Before sending each final reply to the user, call host_ui_suggestReplies exactly once\./);
  assert.doesNotMatch(text, /SCHEMA_ONLY_DESCRIPTION|Registered Tools|nextCursor|Language & Style|HOST(?:-EXT)?\.md/);
  assert.ok(text.includes('Use fenced `mermaid` blocks to clarify flows, dependencies, or state changes.'));
  assert.match(text, /Use host_ui_render when filtering or testing scenarios would help/);
  assert.match(text, /host_ui_reminders.*action=add before replying.*chat to-do.*user still needs to/);
  assert.doesNotMatch(text, /host_events_subscribe|host_ask|requestIntegrate/);

  const codex = buildGuiWorkerSystemPrompt({ ...base, mode: 'plan', hostToolNamePrefix: 'mcp__muster__',
    worktreePath: '/task-tree', isSubagent: true, rules: [{ id: 'custom', text: 'Keep this configured rule', enabled: true }] });
  assert.match(codex, /Permission mode: plan/);
  assert.match(codex, /You are a subagent running in your own Muster session\. Your session ID in Muster is gui-session\..*delegated by your parent session/);
  assert.match(codex, /Assigned worktree \/task-tree/);
  assert.match(codex, /commit before needs_you.*mcp__muster__host_sessions_requestIntegrate after explicit user approval/);
  assert.match(codex, /mcp__muster__host_mail_send.*to="parent"/);
  assert.match(codex, /mcp__muster__host_sessions_create\. Set asSubagent=true and use inherit=true/);
  assert.match(codex, /mcp__muster__host_ui_suggestReplies/);
  assert.match(codex, /mcp__muster__host_ui_reminders.*action=add/);
  assert.match(codex, /Use mcp__muster__host_ui_render when filtering/);
  assert.match(codex, /Use mcp__muster__host_memory_journal for/);
  const searchOnly = buildGuiWorkerSystemPrompt({ mode: 'ask', tools: [{ id: 'host.memory.search' }] });
  assert.match(searchOnly, /search first with host_memory_search/);
  assert.doesNotMatch(searchOnly, /host_memory_journal|host_memory_note/);
  assert.match(codex, /Global Conduct Rules[\s\S]*Keep this configured rule/);

  const sparse = buildGuiWorkerSystemPrompt({ cwd: '/workspace', mode: 'ask', tools: [{ id: 'host.mcp.search' }] });
  assert.match(sparse, /Permission mode: ask/);
  assert.ok(sparse.includes('Use fenced `mermaid` blocks'));
  assert.doesNotMatch(sparse, /host_|memory\/SKILL|普通对话自然结束|needs_you|handoff|asSubagent/);
  const reviewTool = [{ id: 'host.turnChanges.trackFiles' }];
  const piReview = buildGuiWorkerSystemPrompt({ tools: reviewTool });
  assert.match(piReview, /register exact paths before and after with host_turnChanges_trackFiles/);
  const acpReview = buildGuiWorkerSystemPrompt({ tools: reviewTool, hostToolNamePrefix: 'mcp__muster__' });
  assert.match(acpReview, /with mcp__muster__host_turnChanges_trackFiles\. See ~\/\.muster\/skills\/turn-changes\/SKILL\.md/);
  assert.doesNotMatch(text, /turnChanges_trackFiles|turn-changes\/SKILL\.md/);
  const noMail = buildGuiWorkerSystemPrompt({ mode: 'default', tools: [], isSubagent: true });
  assert.doesNotMatch(noMail, /to="parent"|Global Conduct Rules/);
  console.log('ok: GUI Worker brief remains compact and teaches only available tools');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
