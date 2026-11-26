/** Regression: default product context never presumes a personal workflow or integration. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-generalization-'));
const compile = createSharedCompiler(root, tmp);
const load = (file) => import(pathToFileURL(compile(file)).href);
const clean = (value) => assert.doesNotMatch(value, /7067220353|lark-bug-investigator|勿提测|FeishuProjectMcp|feishu-daily-report|bugId:\s*7067/);
try {
  const { buildDefaultDispatcherAppendBody: body, buildMetaAgentAppendPrompt, buildCatalogAppendix } = await load('main/agent/systemPrompt.ts');
  const disabled = body(undefined, { mcpEnabled: false, mcpServers: ['sample-server'] });
  clean(disabled);
  assert.doesNotMatch(disabled, /sample-server|MCP is enabled|飞书 Project/);
  assert.match(body(undefined, { mcpEnabled: true, mcpServers: [] }), /no server is configured yet/);
  const enabled = body('http://localhost:1234', { mcpEnabled: true, mcpServers: ['inventory', 'document-search'] });
  clean(enabled);
  assert.match(enabled, /inventory, document-search/);
  assert.match(enabled, /mcp\.search.*nextOffset.*mcp\.call/);
  assert.match(enabled, /CLI Workers receive reporting instructions/);
  assert.doesNotMatch(enabled, /HOST(?:-EXT)?\.md/);
  assert.match(enabled, /automations/);
  assert.match(enabled, /sessions\.observe/);
  assert.doesNotMatch(enabled, /services[._]|pipeline[._]|sessions[._]outbox/);
  assert.match(enabled, /queued.*verification incomplete/);
  assert.match(enabled, /external pages.*not a new operation authorization/);
  const custom = buildMetaAgentAppendPrompt(undefined, { customBody: 'My custom workflow', rules: [{id:'x',enabled:true,text:'My workspace rule'}] });
  assert.match(custom[0], /^My custom workflow/);
  assert.match(custom[0], /My workspace rule/);
  assert.match(custom[1], /App Shell Capability Summary/);
  assert.ok(custom[1].includes('Use fenced `mermaid` blocks'));
  assert.match(custom[1], /Use host_ui_render when filtering/);
  const withoutWidgetTool = buildCatalogAppendix({ groups: [], tools: ['ui.render'] });
  assert.ok(withoutWidgetTool.includes('Use fenced `mermaid` blocks'));
  assert.doesNotMatch(withoutWidgetTool, /Use host_ui_render/);

  const { TOOL_DEFS } = await load('main/capabilities/catalog.ts');
  for (const tool of TOOL_DEFS) clean(JSON.stringify(tool));
  const { buildGuiWorkerSystemPrompt } = await load('shared/guiWorkerPrompt.ts');
  const prompt = buildGuiWorkerSystemPrompt({
    cwd: '/workspace',
    mode: 'default',
    tools: [{ id: 'host.memory.remember' }, { id: 'host.ask' }]
  });
  clean(prompt);
  assert.doesNotMatch(prompt, /AGENTS\.md|CLAUDE\.md|tool names, schemas/);
  assert.ok(prompt.includes('Read ~/.muster/skills/memory/SKILL.md before your first memory tool call'));
  assert.match(prompt, /Report failures/);
  assert.doesNotMatch(prompt, /multiSelect|\.agents\/skills\/memory/);

  const { buildHostIntro, buildTaskBriefText } = await load('shared/workerBrief.ts');
  const languageRule = "Reply in the user's requested language. Otherwise, use the language of their latest prose, excluding host prompts, quotes, code, and tool output.";
  for (const input of [
    buildMetaAgentAppendPrompt()[0], custom[0], prompt,
    buildGuiWorkerSystemPrompt({ isSubagent: true, tools: [] }),
    buildHostIntro(), buildTaskBriefText('帮我解释这条日志：Connection refused')
  ]) {
    assert.equal(input.split(languageRule).length, 2, 'each host prompt delivers the reply-language rule once');
  }

  const { parseJournalEntries, serializeJournalEntry } = await load('shared/journalFormat.ts');
  const entry = { topic: '配置校验', status: '已完成', problem: '检查配置读取', points: ['验证通过'] };
  assert.deepEqual(parseJournalEntries(serializeJournalEntry(entry)), [entry]);

  // B1 中转两工具的注册 schema（mcpExtension 单工具已退役；pi 注册面 = catalog 常驻投影）。
  const { MCP_SEARCH_DESCRIPTION, MCP_CALL_DESCRIPTION, MCP_SEARCH_PARAMETERS, MCP_CALL_PARAMETERS } =
    await load('shared/mcpRelay.ts');
  clean(MCP_SEARCH_DESCRIPTION);
  clean(MCP_CALL_DESCRIPTION);
  clean(JSON.stringify(MCP_SEARCH_PARAMETERS));
  clean(JSON.stringify(MCP_CALL_PARAMETERS));
  assert.match(MCP_SEARCH_DESCRIPTION, /nextOffset/);
  assert.match(MCP_CALL_DESCRIPTION, /mcp\.search/);
  assert.deepEqual(MCP_CALL_PARAMETERS.required, ['server', 'tool']);
  console.log('prompt-generalization: ok');
} finally {
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('prompt-generalization-'));
  fs.rmSync(tmp, {recursive:true, force:true});
}
