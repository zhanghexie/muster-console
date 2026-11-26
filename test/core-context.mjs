/** Real Pi loop + disk session + HTTP receiver. Model choices and usage are scripted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildSessionProjection, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-fold-'));
const raw = 'preamble\n' + 'process record\n'.repeat(520) + 'WARNING E531: 保留旧配置键\nneedle-639-original\n' + 'ok\n'.repeat(800) + 'completed';
const pinned = 'Keep legacy.config verbatim.';
const requests = [];
const choices = [];
const views = new Map();
let callNo = 0;
let billedPrompt = 0;
function call(action, args) {
  return { tool_calls: [{ index: 0, id: 'call_' + ++callNo, type: 'function',
    function: { name: action, arguments: JSON.stringify(args) } }] };
}
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks)));
  const delta = choices.shift() ?? { content: 'done' };
  const payload = (data, finish_reason) => 'data: ' + JSON.stringify({ id: 'chat-fixture', model: 'fixture', object: 'chat.completion.chunk',
    ...(billedPrompt && finish_reason ? { usage: { prompt_tokens: billedPrompt, completion_tokens: 10, total_tokens: billedPrompt + 10 } } : {}),
    choices: [{ index: 0, delta: data, finish_reason }] }) + '\n\n';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(payload({ role: 'assistant', ...delta }, null) + payload({}, delta.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let session;
try {
  const mod = path.join(tmp, 'core.mjs');
  await build({ entryPoints: ['src/main/agent/coreContext.ts'], outfile: mod, platform: 'node', format: 'esm', bundle: true });
  const { createCoreContextExtension, CORE_CONTEXT_TOOL, recommendCoreFold } = await import(pathToFileURL(mod));
  const row = (id, role, content) => {
    const message = { role, content };
    return { sourceEntry: { type: 'message', id, message }, messages: [message] };
  };
  const recent = [row('u1','user','next'), row('a1','assistant','ok'), row('u2','user','last'), row('a2','assistant','ok')];
  assert.equal(recommendCoreFold(recent, true), undefined);
  assert.equal(recommendCoreFold([row('protected','user','exact user text'.repeat(4000)), ...recent], false), undefined);
  assert.equal(recommendCoreFold([row('incomplete','assistant', [{ type:'text', text:'x'.repeat(64000) },
    { type:'toolCall', id:'missing-result', arguments:{} }]), ...recent], false), undefined);
  const runtime = await ModelRuntime.create({ authPath: path.join(tmp, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(tmp, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('test', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture',
    models: [{ id: 'fixture', name: 'Fixture', contextWindow: 160000, maxTokens: 4096, reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const manager = SessionManager.create(tmp, path.join(tmp, 'sessions'));
  const traceModule = path.join(tmp, 'trace.mjs');
  await build({ entryPoints: ['src/main/agentSession/drivers/pi/requestCompression.ts'], outfile: traceModule, platform: 'node', format: 'esm', bundle: true });
  const { traceRequestCompression } = await import(pathToFileURL(traceModule));
  const trace = (payload = requests.at(-1)) => traceRequestCompression(Buffer.from(JSON.stringify(payload)), manager.getLeafId(), manager, tmp, buildSessionProjection).items;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 64 }, retry: { enabled: false } });
  let enabled = true;
  const loadResources = async (maxResultChars) => {
    const loader = new DefaultResourceLoader({ cwd: tmp, agentDir: tmp, noExtensions: true, noSkills: true, noContextFiles: true,
      noThemes: true, noPromptTemplates: true, settingsManager: settings, systemPrompt: 'fixture',
      extensionFactories: [createCoreContextExtension(() => ({ enabled }), maxResultChars)] });
    await loader.reload();
    return loader;
  };
  const loader = await loadResources(200);
  ({ session } = await createAgentSession({ cwd: tmp, agentDir: tmp, settingsManager: settings, modelRuntime: runtime,
    model: runtime.getModel('test', 'fixture'), thinkingLevel: 'off', resourceLoader: loader, sessionManager: manager, tools: ['read', CORE_CONTEXT_TOOL] }));
  const file = path.join(tmp, 'fixture.txt');
  fs.writeFileSync(file, raw);
  choices.push(call('read', { path: file }));
  await session.prompt(pinned);
  assert.equal(requests.length, 2);
  const tool = request => request.messages.find(m => m.role === 'tool');
  assert.equal(tool(requests[1]).content, raw);
  const source = manager.getBranch().find(e => e.message?.role === 'toolResult');
  const edits = manager.getBranch().filter(e => e.type === 'context_edit');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].targetId, source.id);
  const card = edits[0].replacement.content[0].text;
  views.set('raw', raw);
  views.set('core-excerpt', card);
  assert.ok(card.includes('WARNING E531') && card.includes(source.id));
  assert.ok(card.includes('needle-639-original'));
  if (process.env.CORE_BENCH_DSH) {
    const { toolExcerpt } = await import(pathToFileURL(path.join(process.env.CORE_BENCH_DSH, 'plan.js')));
    const ref = toolExcerpt([{ id: source.id, role: 'tool', isError: false, text: raw }], source.id);
    views.set('dsh-excerpt', ref.text);
    console.log('Same tool output, excerpt bytes:', JSON.stringify({ dsh: Buffer.byteLength(ref.text), core: Buffer.byteLength(card),
      dshMiddleWarning: ref.text.includes('E531'), coreMiddleWarning: card.includes('E531') }));
  }
  await session.prompt('Continue.');
  assert.equal(tool(requests.at(-1)).content, card);
  const before = requests[1], after = requests.at(-1);
  const pos = before.messages.findIndex(m => m.role === 'tool');
  assert.deepEqual(before.messages.slice(0, pos), after.messages.slice(0, pos));
  assert.deepEqual(before.tools, after.tools);
  assert.equal(tool(before).tool_call_id, tool(after).tool_call_id);
  assert.ok(!manager.getBranch().some(e => e.type === 'compaction'));

  const coreCall = async (args, prompt = 'Inspect.') => {
    choices.push(call(CORE_CONTEXT_TOOL, args));
    await session.prompt(prompt);
    const msg = requests.at(-1).messages.filter(m => m.role === 'tool').at(-1);
    return msg.content;
  };
  const hit = JSON.parse(await coreCall({ action: 'search', query: 'needle-639-original' })).hits.find(h => h.id === source.id);
  assert.ok(hit);
  const miss = JSON.parse(await coreCall({ action: 'search', query: 'missing-98231-not-in-evidence' }));
  assert.deepEqual(miss.hits, [], 'the search invocation itself is not source evidence');
  assert.ok(JSON.parse(await coreCall({ action: 'read', id: source.id, offset: hit.offset })).text.startsWith('needle-639-original'));
  const firstPage = await coreCall({ action: 'read', id: source.id });
  assert.ok(firstPage.length <= 200);
  const page = JSON.parse(firstPage);
  assert.ok(page.next > 0);
  assert.equal(page.text, raw.slice(0, page.next));
  const searchPage = await coreCall({ action: 'search', query: 'process record' });
  assert.ok(searchPage.length <= 200, 'search pages must fit contextTrim even with long previews');
  assert.equal(JSON.parse(searchPage).hits[0].id, source.id);
  const oldestKeep = manager.getBranch().find(e => e.message?.role === 'assistant' && e.message.stopReason === 'stop').id;
  const seenBoundaries = new Set();
  let cursor = 0;
  do {
    const body = await coreCall({ action: 'status', offset: cursor });
    assert.ok(body.length <= 200, 'the model must receive a complete status page');
    const status = JSON.parse(body);
    for (const b of status.boundaries) {
      assert.ok(!seenBoundaries.has(b.keep), 'appending status calls must not duplicate an earlier page');
      seenBoundaries.add(b.keep);
    }
    cursor = status.next;
    assert.ok(seenBoundaries.size < 80, 'the cursor must reach the start of history');
  } while (cursor !== null);
  assert.ok(seenBoundaries.has(oldestKeep));
  const initialKeep = manager.getBranch().find(e => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('Continue.')).id;
  // This historic prefix contains the shortened log and a long completed reply.
  // With a small excerpt alone, folding would grow the prompt and must be rejected.
  choices.push({ content: 'Intermediate analysis. '.repeat(250) });
  await session.prompt('Finish analysis.');
  await session.prompt('Retain this turn.');
  const keep = manager.getBranch().find(e => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('Retain this turn.')).id;
  await coreCall({ action: 'fold', keep, summary: 'Investigated fixture. Verify diagnostics before changing configuration.' });
  let blocks = manager.getBranch().filter(e => e.type === 'compaction');
  assert.equal(blocks.length, 1);
  const first = blocks[0];
  assert.equal(first.details.level, 1);
  assert.ok(first.details.sources.includes(source.id));
  assert.ok(JSON.stringify(requests.at(-1)).includes(pinned));
  assert.ok(!requests.at(-1).messages.some(m => m.role === 'tool' && m.tool_call_id === tool(before).tool_call_id));
  let sourceCursor = 0;
  const members = [];
  do {
    const body = await coreCall({ action: 'sources', id: first.id, offset: sourceCursor });
    assert.ok(body.length <= 200, 'sources must retain a readable cursor under mode trim');
    const list = JSON.parse(body);
    members.push(...list.sources);
    sourceCursor = list.next;
  } while (sourceCursor !== null);
  assert.deepEqual(members, first.details.sources);
  choices.push({ content: 'Phase two analysis. '.repeat(320) });
  await session.prompt('Phase two.');
  await session.prompt('Third phase.');
  const third = manager.getBranch().find(e => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('Third phase.')).id;
  await coreCall({ action: 'fold', keep: third, summary: 'Two phases complete. Evidence still references the original read.' });
  blocks = manager.getBranch().filter(e => e.type === 'compaction');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].details.previous, first.id);
  assert.equal(blocks[1].details.level, 2);
  assert.ok(blocks[1].summary.includes(pinned));
  assert.ok(blocks[1].summary.includes('WARNING E531'));
  choices.push({ content: 'Phase three investigation. '.repeat(220) });
  await session.prompt('Gather evidence.');
  await session.prompt('Fourth phase.');
  const fourth = manager.getBranch().find(e => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('Fourth phase.')).id;
  await coreCall({ action: 'fold', keep: fourth, summary: 'Three phases complete; retain constraints and source evidence.' });
  const newest = manager.getBranch().filter(e => e.type === 'compaction').at(-1);
  assert.equal(newest.details.level, 3);
  const checkpointItem = trace().find(item => item.kind === 'checkpoint');
  assert.equal(checkpointItem.id, newest.id);
  assert.equal(checkpointItem.previous, blocks[1].id);
  assert.deepEqual(checkpointItem.sources.map(s => s.id), [blocks[1].id, ...newest.details.sources]);
  assert.equal(newest.details.previous, blocks[1].id);
  assert.ok(newest.summary.includes('WARNING E531'));
  views.set('core-level3', newest.summary);
  if (process.env.CORE_BENCH_BILLION) {
    const target = path.join(tmp, 'acp.mjs');
    await build({ entryPoints: [path.join(process.env.CORE_BENCH_BILLION, 'kernel/src/index.ts')],
      outfile: target, bundle: true, platform: 'node', format: 'esm' });
    const { createCore, createInitialState, defaultConfig, assignRefs } = await import(pathToFileURL(target));
    const core = createCore();
    const config = defaultConfig(160000);
    Object.assign(config, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    Object.assign(config.compress, { minCompressRange: 0, minSummaryLength: 0 });
    const messages = [{ id: 'pin', role: 'user', text: pinned, contentType: 'text' },
      { id: 'read-call', role: 'assistant', text: 'read fixture', contentType: 'text' },
      { id: source.id, role: 'tool', text: raw, contentType: 'tool-result', toolName: 'read', toolCallId: 'call_1' },
      { id: 'tail', role: 'user', text: 'Continue.', contentType: 'text' }];
    let state = createInitialState();
    state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
    let id;
    for (const [i, entry] of [first, blocks[1], newest].entries()) {
      const applied = core.applyCompression({ messages, config, state, ranges: [{
        startRef: id ?? state.messageRefs.byRaw['read-call'], endRef: id ?? state.messageRefs.byRaw[source.id],
        summary: entry.summary.split('\n')[1] }] });
      assert.equal(applied.result.blocksCreated, 1, JSON.stringify(applied.result.errors));
      state = applied.state;
      const block = state.blocks.at(-1);
      id = block.blockId;
      assert.equal(block.tier, i + 1);
      assert.ok(core.decompress(id, state).effectiveMessageIds.includes(source.id));
      views.set('billion-level3', block.summary);
    }
    console.log('billion-context and Core: the same fixture evidence resolves through three summary generations.');
  }
  await coreCall({ action: 'expand', id: newest.id });
  const restored = manager.getBranch().filter(e => e.type === 'compaction').at(-1);
  assert.equal(restored.summary, blocks[1].summary);
  await coreCall({ action: 'expand', id: restored.id });
  assert.equal(manager.getBranch().filter(e => e.type === 'compaction').at(-1).summary, first.summary);
  const reopened = SessionManager.open(manager.getSessionFile());
  assert.equal(reopened.getEntry(source.id).message.content[0].text, raw);
  assert.equal(JSON.stringify(reopened.buildSessionProjection().messages), JSON.stringify(manager.buildSessionProjection().messages));
  const fork = SessionManager.inMemory(tmp, {}, [manager.getHeader(), ...manager.getEntries()]);
  fork.createBranchedSession(source.id);
  assert.equal(fork.buildSessionProjection().messages.find(m => m.role === 'toolResult').content[0].text, raw);
  assert.ok(!fork.getBranch().some(e => e.id === first.id));
  assert.match(await coreCall({ action: 'fold', keep: initialKeep, summary: 'stale' }), /stale/);
  choices.push(call('read', { path: path.join(tmp, 'missing-fixture.txt') }));
  await session.prompt('Diagnose this missing file.');
  const failure = manager.getBranch().find(e => e.message?.role === 'toolResult' && e.message.toolName === 'read' && e.message.isError);
  assert.ok(failure);
  assert.ok(!manager.getBranch().some(e => e.type === 'context_edit' && e.targetId === failure.id));
  choices.push({ content: 'Diagnosis of missing fixture. '.repeat(220) });
  await session.prompt('Record the diagnosis.');
  await session.prompt('Keep this new request.');
  const lastUser = manager.getBranch().filter(e => e.message?.role === 'user').at(-1);
  await coreCall({ action: 'fold', keep: lastUser.id, summary: 'The missing file remains unresolved.' });
  const withFailure = manager.getBranch().filter(e => e.type === 'compaction').at(-1);
  assert.ok(withFailure.summary.includes(failure.id));
  assert.ok(withFailure.summary.includes(JSON.stringify(failure.message.content[0].text)));
  assert.ok(JSON.parse(await coreCall({ action: 'read', id: failure.id })).text.includes('missing-fixture'));
  const child = SessionManager.inMemory(tmp, {}, [manager.getHeader(), ...manager.getEntries()]);
  child.createBranchedSession(withFailure.id);
  assert.ok(child.getBranch().some(e => e.id === source.id));
  assert.equal(child.getEntry(source.id).message.content[0].text, raw);
  enabled = false;
  const beforeCount = manager.getBranch().filter(e => e.type === 'context_edit').length;
  choices.push(call('read', { path: file }));
  await session.prompt('Read with automatic compression disabled.');
  assert.equal(manager.getBranch().filter(e => e.type === 'context_edit').length, beforeCount);
  const latestRead = manager.getBranch().filter(e => e.message?.role === 'toolResult' && e.message.toolName === 'read').at(-1);
  assert.equal(latestRead.message.content[0].text, raw);
  await coreCall({ action: 'fold', id: latestRead.id, summary: 'Read fixture; verify E531.' });
  const single = manager.getBranch().filter(e => e.type === 'context_edit').at(-1);
  assert.equal(single.targetId, latestRead.id);
  const foldedItem = trace().find(item => item.id === latestRead.id);
  assert.equal(foldedItem.kind, 'summary');
  assert.equal(foldedItem.sources[0].chars, raw.length);
  assert.deepEqual(trace({messages: [{role: 'user', content: single.replacement.content[0].text}]}), []);
  assert.ok(single.replacement.content[0].text.includes('WARNING E531: 保留旧配置键'));
  assert.equal(manager.getEntry(latestRead.id).message.content[0].text, raw);
  enabled = true;
  // Several tool turns in one run. Each newly returned result must be seen by
  // the model before the next boundary may compact it, even after an earlier edit.
  choices.push(call('read', { path: file }), call('read', { path: file }), call('read', { path: file }));
  const start = requests.length;
  await session.prompt('Read three times.');
  for (const req of requests.slice(start + 1)) assert.equal(req.messages.filter(m => m.role === 'tool').at(-1).content, raw);
  const repeated = manager.getBranch().filter(e => e.message?.role === 'toolResult' && e.message.toolName === 'read').slice(-3);
  for (const item of repeated) assert.equal(manager.getBranch().filter(e => e.type === 'context_edit' && e.targetId === item.id).length, 1);
  choices.push({ content: 'Native checkpoint after repeated reads.' });
  await session.compact('Summarize the fixture work.');
  assert.ok(manager.getBranch().filter(e => e.type === 'compaction').at(-1).summary.includes('Native checkpoint'));
  assert.ok(JSON.parse(await coreCall({ action: 'read', id: source.id, offset: hit.offset })).text.startsWith('needle-639-original'));
  choices.push({ content: 'completed analysis record '.repeat(420) });
  await session.prompt('Record a bounded phase.');
  await session.prompt('Open a new phase.');
  billedPrompt = 100000;
  assert.ok(trace().some(item => item.kind === 'native'));
  const pressureStart = requests.length;
  await session.prompt('Update measured usage.');
  await session.prompt('Continue under pressure.');
  await session.prompt('Keep working.');
  const hints = manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'muster.context.v1');
  assert.equal(hints.length, 1, 'pressure should nudge once at unchanged usage');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('Completed history:'));
  assert.equal(requests.length - pressureStart, 3, 'host pressure hints must never create a model turn');
  billedPrompt = 0;
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGP8z4AATEhsPBwAM9EBBzDn4UwAAAAASUVORK5CYII=';
  const originalText = 'after-image-phase-record '.repeat(2100);
  choices.push({ content: originalText });
  await session.prompt('Keep this image.', { images: [{ type: 'image', mimeType: 'image/png', data: imageData }] });
  await session.prompt('The phase has finished.');
  await session.prompt('Continue with new work.');
  const segment = manager.getBranch().findLast(e => e.type === 'custom_message' && e.details?.start && e.details?.net >= 32000);
  assert.ok(segment, 'recommend a completed range below the pressure threshold');
  const { start: rangeStart, keep: rangeKeep } = segment.details;
  assert.match(await coreCall({ action: 'fold', start: rangeStart, keep: rangeKeep, summary: 'Finished reviewing records after the image.' }), /proposed/);
  const range = manager.getBranch().findLast(e => e.customType === 'muster.range.v1');
  assert.ok(range?.data.sources.includes(rangeStart));
  const body = JSON.stringify(requests.at(-1).messages);
  const sentImage = requests.slice(0,-1).flatMap(r => r.messages).flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image_url');
  assert.ok(sentImage && body.includes(sentImage.image_url.url) && body.includes('Finished reviewing records after the image.') && !body.includes(originalText));
  assert.ok(trace().some(item => item.sources.some(source => source.id === rangeStart)));
  const reopenedRange = SessionManager.open(manager.getSessionFile());
  assert.ok(reopenedRange.buildSessionProjection().messages.some(m => m.role === 'compactionSummary' && m.summary === range.data.summary));
  assert.ok(JSON.parse(await coreCall({ action: 'sources', id: range.id })).sources.includes(rangeStart));
  assert.ok(JSON.parse(await coreCall({ action: 'read', id: rangeStart })).text.startsWith('after-image-phase-record'));
  await coreCall({ action: 'expand', id: range.id });
  assert.ok(JSON.stringify(requests.at(-1).messages).includes(originalText));
  const appRoot = process.env.CORE_BENCH_USER_DATA;
  if (appRoot || (process.env.CORE_BENCH_PROVIDER && process.env.CORE_BENCH_MODEL)) {
    assert.equal(views.size, 5, 'Supply both pinned reference checkouts for a live comparison.');
    const selected = appRoot ? JSON.parse(fs.readFileSync(path.join(appRoot, 'config.json'), 'utf8')).llm : null;
    const providerId = appRoot ? selected.activeProviderId : process.env.CORE_BENCH_PROVIDER;
    const modelId = appRoot ? selected.activeModelId : process.env.CORE_BENCH_MODEL;
    const coreHome = appRoot && path.join(appRoot, 'muster-core');
    const live = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false,
      ...(coreHome && { authPath: path.join(coreHome, 'auth.json'), modelsPath: path.join(coreHome, 'models.json') }) });
    const model = live.getModel(providerId, modelId);
    assert.ok(model, `Missing selected model ${providerId}/${modelId}`);
    assert.ok(await live.checkAuth(providerId), `Missing credentials for ${providerId}`);
    console.log(`Live comparison: ${providerId}/${modelId} (${model.api})`);
    const ask = async (body) => {
      const reply = await live.completeSimple(model, { messages: [{ role: 'user', timestamp: 0, content: body }] },
        { maxTokens: 512, temperature: 0, signal: AbortSignal.timeout(45000) });
      assert.equal(reply.stopReason, 'stop', `Provider returned ${reply.stopReason}`);
      return reply.content.filter(p => p.type === 'text').map(p => p.text).join('').trim();
    };
    const question = 'Return only a JSON array of two scalar strings in this order: [warning code, complete ordinary record starting with "needle-"]. The warning code is the single alphanumeric identifier following WARNING. Use JSON null for a missing value. No objects, guessing or explanation.';
    const score = answer => {
      const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      return Number(parsed[0] === 'E531') + Number(parsed[1] === 'needle-639-original');
    };
    // The same readback for every arm isolates evidence carried by the view
    // from post-recovery answer quality. Real tool routing is tested above.
    async function readAll() {
      let offset = 0, output = '';
      do {
        const p = JSON.parse(await coreCall({ action: 'read', id: source.id, offset }));
        output += p.text;
        offset = p.next;
      } while (offset !== null);
      assert.equal(output, raw);
      return output;
    }
    const original = await readAll();
    const results = [];
    for (const [arm, view] of views) {
      const answer = await ask(`${question}\nEvidence:\n${view}`);
      const direct = score(answer);
      const afterAnswer = direct === 2 ? answer : await ask(`${question}\nEvidence:\n${view}\nOriginal tool output:\n${original}`);
      const afterRead = score(afterAnswer);
      results.push({ arm, direct, afterRead });
      console.log(JSON.stringify({ model: model.id, arm, direct, afterRead, facts: 2, answer, afterAnswer }));
    }
    // Exercise real model decisions in the Pi tool loop, separate from the
    // paired view comparison above. Only synthetic data lives in this session.
    const liveManager = SessionManager.inMemory(tmp);
    const { session: liveSession } = await createAgentSession({ cwd: tmp, agentDir: tmp,
      modelRuntime: live, model, thinkingLevel: 'off', resourceLoader: await loadResources(), settingsManager: settings,
      sessionManager: liveManager, tools: ['read', CORE_CONTEXT_TOOL] });
    const visibleReply = () => liveManager.getBranch().filter(e => e.message?.role === 'assistant').at(-1)
      ?.message.content.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
    const liveTrace = () => JSON.stringify(liveManager.getBranch().filter(e => e.type === 'message').map(e => {
      const m = e.message;
      return { role: m.role, stop: m.stopReason, error: m.isError, calls: Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'toolCall').map(p => ({ name: p.name, args: p.arguments })) : [],
        preview: Array.isArray(m.content) ? m.content.find(p => p.type === 'text')?.text.slice(0, 180) : '' };
    }));
    let toolCalls = 0;
    const stopTracing = liveSession.subscribe(event => {
      if (event.type !== 'tool_execution_start') return;
      console.log(`Live Pi tool: ${event.toolName} ${event.args?.action ?? ''}`);
      if (++toolCalls > 24) void liveSession.abort();
    });
    const deadline = setTimeout(() => void liveSession.abort(), 360000);
    try {
      // Make the phase independently foldable even if the model writes a
      // one-line handoff. These unique observations survive the mechanical pass.
      const observations = path.join(tmp, 'phase-observations.txt');
      fs.writeFileSync(observations, Array.from({ length: 72 }, (_, i) =>
        `Fixture case ${i + 1}: verified the migration path for synthetic component group ${i + 1}.`).join('\n'));
      await liveSession.prompt(`Read both synthetic inputs. Read the complete log in one call with ${JSON.stringify({ path: file, offset: 1, limit: 2000 })}, then read all of ${observations}. Report completion in one sentence without identifiers.`);
      assert.ok(liveManager.getBranch().some(e => e.type === 'context_edit'), liveTrace());
      assert.ok(liveManager.getBranch().some(e => e.message?.role === 'toolResult' &&
        e.message.content.some(p => p.type === 'text' && p.text.includes('Fixture case 72:'))), liveTrace());
      await liveSession.prompt('Use core_context status. Choose this user message as the keep boundary and fold the completed phase with one short sentence in your own words. End after the fold. Do not repeat the source lines.');
      assert.ok(liveManager.getBranch().some(e => e.type === 'compaction' && e.details?.owner === 'muster.context.v1'), liveTrace());
      await liveSession.prompt('The source file is unavailable for this step. Use core_context to recover the exact original warning code and the full record beginning with needle-. Answer with both literals.');
      assert.ok(liveManager.getBranch().some(e => e.message?.role === 'assistant' && e.message.content.some(
        p => p.type === 'toolCall' && p.name === CORE_CONTEXT_TOOL && ['search', 'read'].includes(p.arguments.action))), liveTrace());
      assert.match(visibleReply(), /E531/);
      assert.match(visibleReply(), /needle-639-original/);
      console.log('Real Pi model loop: read, mechanical excerpt, model-written checkpoint and evidence retrieval passed.');
    } finally { clearTimeout(deadline); stopTracing(); liveSession.dispose(); }
    assert.ok(results.every(r => r.afterRead === 2), 'One or more factual readbacks missed the exact values.');
  }
  console.log(`Core context: ${requests.length} HTTP requests, ${Buffer.byteLength(raw)} → ${Buffer.byteLength(card)} bytes; exact recall, stable prefix, nested checkpoint, expansion, restart and fork passed`);
} finally {
  session?.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
