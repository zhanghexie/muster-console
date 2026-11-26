import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
// Actual SDK with a local controlled model; no supplier key, real home directory or real workspace data.
const scratch = path.resolve('.tmp'); fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'memory-curator-pi-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { __setPiSdkForTests } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/piSdk.ts')));
const { createMemoryCuratorPiFactory, createCuratorResourceLoader } = await import(pathToFileURL(compile('main/memory/curator/pi.ts')));
const { CuratorBudgetError } = await import(pathToFileURL(compile('main/memory/curator/budget.ts')));
const { createCuratorTools, MEMORY_CURATOR_TOOL_NAMES } = await import(pathToFileURL(compile('main/memory/curator/tools.ts')));
const pi = await import('@earendil-works/pi-coding-agent');
__setPiSdkForTests(pi);
const marker = 'UNRELATED_RESOURCE_MUST_NOT_BE_LOADED';
const escaped = path.join(temp, 'unrelated-executed');
for (const directory of [temp, path.join(temp, 'curator', 'pi-home')]) {
  fs.mkdirSync(path.join(directory, '.pi', 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(directory, '.pi', 'skills', 'unrelated'), { recursive: true });
  fs.mkdirSync(path.join(directory, '.pi', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), marker);
  fs.writeFileSync(path.join(directory, '.pi', 'skills', 'unrelated', 'SKILL.md'), `---\nname: unrelated\ndescription: ${marker}\n---\n${marker}`);
  fs.writeFileSync(path.join(directory, '.pi', 'prompts', 'unrelated.md'), marker);
  fs.writeFileSync(path.join(directory, '.pi', 'extensions', 'unrelated.ts'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(escaped)},${JSON.stringify(marker)});export default function() {}`);
  fs.writeFileSync(path.join(directory, '.pi', 'settings.json'), JSON.stringify({ extensions: ['./extensions/unrelated.ts'], skills: ['./skills'], prompts: ['./prompts'] }));
  fs.writeFileSync(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { unrelated: { command: marker } } }));
}
const loader = createCuratorResourceLoader(pi);
assert.deepEqual(loader.getAgentsFiles().agentsFiles, []); assert.deepEqual(loader.getSkills().skills, []);
assert.deepEqual(loader.getPrompts().prompts, []); assert.deepEqual(loader.getExtensions().extensions, []);
assert.throws(() => loader.extendResources({ skillPaths: [{ path: temp, metadata: {} }] }), /禁止/);
await loader.reload(); assert.deepEqual(loader.getSkills().skills, []);
const source = '挂载卸载循环测试确认监听器恢复原数';
const candidate = { id: 'sdk-candidate', eventId: 'sdk-event', namespace: 'worker', origin: 'worker', text: '清理订阅', searchKeys:['订阅清理'], sourceText: source, createdAt: 1, evidence: [{ id: 'test-result', source: 'fixture', eventTime: 1, verification: 'test' }] };
const lesson = { kind: 'reusable_lesson', summary: '组件卸载清理订阅', problem: '多次挂载累计回调', action: '卸载时unsubscribe', rationale: source, applicability: ['React'], exceptions: [], expectedFutureUse: '避免监听器泄漏' };
const requests = [], events = [], receipts = [];
let mode = 'main', step = 0;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
  const tools = body.tools?.map(t => t.function.name).sort(); assert.deepEqual(tools, [...MEMORY_CURATOR_TOOL_NAMES].sort());
  assert.equal(JSON.stringify(body).includes(marker), false, 'unrelated resources must not reach the provider');
  const index = step++;
  const call = mode === 'loop'||mode==='shared-initial'&&index<30 ? ['memory_candidates', {}] : mode === 'main' ? [
    ['memory_candidates', {}],
    ['bash', { command: `echo prohibited > ${escaped}` }],
    ['memory_search', { candidateId: candidate.id, query: '订阅清理' }],
    ['memory_evidence', { candidateId: candidate.id, evidenceId: 'source' }],
    ['memory_commit', { candidateId: candidate.id, decision: 'save', draft: lesson, sourceQuote: source, reason: '单次可靠证据成立', deletionComparisons: [] }]
  ][index] : undefined;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const write = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id: `chat-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'curator-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  write({ role: 'assistant', content: '' });
  if (call) {
    write({ tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
    write({}, 'tool_calls');
  } else { write({ reasoning_content: 'PRIVATE_THINKING_MUST_NOT_APPEAR' }); write({ content: '记忆处理已完成。' }); write({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const config = { llm: { activeProviderId: 'curator-controlled', activeModelId: 'curator-fixture', providers: [{ id: 'curator-controlled', name: 'Controlled local fixture', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-only', api: 'openai-completions', models: [{ id: 'curator-fixture', contextWindow: 32000, maxTokens: 2048 }] }] } };
const tools = createCuratorTools({ candidates: [candidate], policyVersion: 'fixture', assertCurrent() {}, references: () => ({ records: [], deleted: [] }), readEvidence: () => ({ status: 'available', text: source }), defer() {}, commit(c, decision) {
  assert.equal(c.origin, 'worker'); const receipt = { operationId: decision.operationId, candidateId: c.id, policyVersion: decision.policyVersion, decision: decision.decision, disposition: 'active', affected: [], reason: 'saved', at: 1 }; receipts.push(receipt); return receipt;
} });
const factory = createMemoryCuratorPiFactory({ config: () => config });
let session;
try {
  session = await factory({ root: temp, directory: path.join(temp, 'curator'), tools, onEvent: event => events.push(event), maxModelRequests: 8 });
  assert.equal(requests.length, 0, 'even a connected state does not request a model');
  assert.ok(fs.existsSync(session.file), 'fresh session header is durable before its first response');
  const id = session.id, file = session.file;
  await session.run({ kind: 'candidate', text: '请处理本轮宿主候选，仅使用记忆工具。' }, new AbortController().signal);
  assert.equal(receipts.length, 1); assert.equal(requests.length, 6);
  assert.equal(fs.existsSync(escaped), false, 'unknown native tool and undiscovered extension never execute');
  assert.equal(events.some(event => event.type === 'tool-result' && event.isError), true, 'native tool invocation is rejected');
  assert.equal(JSON.stringify(events).includes('PRIVATE_THINKING_MUST_NOT_APPEAR'), false);
  assert.equal(events.filter(e => e.type === 'model-start').length, 6);
  session.dispose(); mode = 'final'; step = 0;
  session = await factory({ root: temp, directory: path.join(temp, 'curator'), sessionFile: file, tools, onEvent: event => events.push(event), maxModelRequests: 8 });
  assert.equal(session.id, id, 'SessionManager reopens the durable dedicated session');
  await session.run({ kind: 'user', text: '查一下现有记忆，不执行无关工作。' }, new AbortController().signal);
  assert.equal(requests.at(-1).messages.some(m => m.role === 'assistant' && String(m.content).includes('记忆处理已完成')), true, 'prior conversation is restored');
  session.dispose(); session = undefined;
  mode = 'loop'; step = 0; const before = requests.length;
  session = await factory({ root: temp, directory: path.join(temp, 'budget'), tools, onEvent() {}, maxModelRequests: 2 });
  await assert.rejects(() => session.run({ kind: 'candidate', text: '循环预算测试' }, new AbortController().signal), error=>error instanceof CuratorBudgetError&&error.kind==='requests');
  assert.equal(requests.length - before, 2, 'request limit applies before HTTP, including tool loops');
  session.dispose();session=undefined;
  config.llm.providers[0].models[0].contextWindow=128000;
  const beforeDefault=requests.length;
  session=await factory({root:temp,directory:path.join(temp,'default-budget'),tools,onEvent(){}});
  await assert.rejects(()=>session.run({kind:'candidate',text:'默认32次调用预算'},new AbortController().signal),error=>error instanceof CuratorBudgetError&&error.kind==='requests');
  assert.equal(requests.length-beforeDefault,32,'the default admits exactly 32 HTTP requests, without a thirty-third');
  session.dispose();session=undefined;mode='final';
  config.llm.providers[0].models[0].contextWindow=8192;
  const beforeSmall=requests.length;
  session=await factory({root:temp,directory:path.join(temp,'small-context'),tools,maxModelRequests:32,onEvent(){}});
  await assert.rejects(()=>session.run({kind:'candidate',text:'x'.repeat(100000)},new AbortController().signal),error=>error instanceof CuratorBudgetError&&error.kind==='context');
  assert.equal(requests.length,beforeSmall,'small configured contexts stop before HTTP');
  session.dispose();session=undefined;
  config.llm.providers[0].models[0].contextWindow=1_000_000;
  session=await factory({root:temp,directory:path.join(temp,'large-context'),tools,maxModelRequests:32,onEvent(){}});
  await session.run({kind:'candidate',text:'x'.repeat(100000)},new AbortController().signal);
  assert.equal(requests.length,beforeSmall+1,'a configured large context is not cut off at the old 64k character ceiling');
  session.dispose();session=undefined;
  config.llm.activeModelId='mimo-v2.5-pro';config.llm.providers[0].models[0].id='mimo-v2.5-pro';delete config.llm.providers[0].models[0].contextWindow;
  session=await factory({root:temp,directory:path.join(temp,'unknown-context'),tools,maxModelRequests:32,onEvent(){}});
  await assert.rejects(()=>session.run({kind:'candidate',text:'x'.repeat(200000)},new AbortController().signal),error=>error instanceof CuratorBudgetError&&error.kind==='context');
  assert.equal(requests.length,beforeSmall+1,'a model name alone does not invent a million-token context');
  session.dispose();session=undefined;
  config.llm.providers[0].models[0].contextWindow=128000;
  let sharedRequests=0;const beforeShared=requests.length;mode='shared-initial';step=0;
  session=await factory({root:temp,directory:path.join(temp,'shared-turn-budget'),tools,maxModelRequests:32,onEvent(){},beforeModelRequest(){
    if(sharedRequests>=32)throw new CuratorBudgetError('requests');sharedRequests++;
  }});
  await session.run({kind:'candidate',text:'first batch turn'},new AbortController().signal);
  assert.equal(sharedRequests,31);mode='final';
  await session.run({kind:'repair',text:'host receipt reconciliation only'},new AbortController().signal);
  await assert.rejects(()=>session.run({kind:'repair',text:'must not get another free allocation'},new AbortController().signal),error=>error instanceof CuratorBudgetError&&error.kind==='requests');
  assert.equal(requests.length-beforeShared,32,'31 initial requests plus one repair request exhaust the shared host budget without a thirty-third HTTP call');
  assert.match(fs.readFileSync(session.file,'utf8'),/memory-receipt-repair/,'repair is a host custom message, rather than a new user authorization');
  console.log('memory-curator-pi: actual SDK closed resources, provider manifest, receipts, persistence and strict request budget passed');
} finally {
  session?.dispose(); __setPiSdkForTests(null);
  await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
  const relative = path.relative(scratch, temp); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(temp, { recursive: true, force: true });
}
