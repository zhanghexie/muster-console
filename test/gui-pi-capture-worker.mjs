/** Real workerHost and Pi worker with local SSE; screenshot data is an offline fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Type } from '@earendil-works/pi-ai';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd(), prefix = 'gui-pi-capture-worker-';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix)), bundleDir = path.join(tmp, 'bundle', 'pi');
fs.mkdirSync(bundleDir, { recursive: true });
const abs = relative => path.join(root, relative).replaceAll('\\', '/');
const wrapper = path.join(tmp, 'entry.ts');
fs.writeFileSync(wrapper, [
  `export { createPiWorkerConnection } from '${abs('src/main/agentSession/drivers/pi/workerHost.ts')}';`,
  `export { setSkillsManagementService } from '${abs('src/main/capabilityManagement/runtimeSkills.ts')}';`,
  `export { desktopCaptureImageRequested, stageDesktopCaptureImage } from '${abs('src/main/desktop/captureImageScope.ts')}';`
].join('\n'));
await build({ entryPoints: [wrapper], bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  outfile: path.join(bundleDir, 'host.cjs'), logLevel: 'silent' });
await build({ entryPoints: [path.join(root, 'src/main/agentSession/drivers/pi/worker.ts')], bundle: true,
  platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(bundleDir, 'worker.cjs'), logLevel: 'silent' });
if (process.platform === 'win32') {
  const guardian = path.join(tmp, 'bundle', 'codex', 'worker'); fs.mkdirSync(guardian, { recursive: true });
  fs.copyFileSync(path.join(root, 'src/main/agentSession/drivers/codex/worker/windows-job.ps1'), path.join(guardian, 'windows-job.ps1'));
}
const require = createRequire(import.meta.url), Module = require('node:module'), originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { PNG } = require('pngjs');
const png = PNG.sync.write(new PNG({ width: 2500, height: 1200 }));
const base64 = png.toString('base64');
const { createPiWorkerConnection, setSkillsManagementService, desktopCaptureImageRequested, stageDesktopCaptureImage } =
  require(path.join(bundleDir, 'host.cjs'));
setSkillsManagementService({ additionalSkillPaths: () => [], prepareRuntimeSkillFilter: async () => skills => skills });
let requests = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const request = JSON.parse(body); requests.push(request);
    const first = !request.messages.some(message => message.role === 'tool');
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
      model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (first) {
      send(chunk({ tool_calls: [{ index: 0, id: 'capture-call-1', type: 'function',
        function: { name: 'host_desktop_look', arguments: '{}' } }] }));
      send(chunk({}, 'tool_calls'));
    } else { send(chunk({ role: 'assistant', content: 'done' })); send(chunk({}, 'stop')); }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function exercise(mode) {
  requests = [];
  const dir = path.join(tmp, mode), userData = path.join(dir, 'userdata'), home = path.join(userData, 'muster-core');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-fixture',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: mode === 'text' ? ['text'] : ['text', 'image'],
      contextWindow: 16000, maxTokens: 512, cost }]
  } } }));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'offline-fixture' } }));
  const extension = path.join(dir, 'rewrite.mjs');
  if (mode === 'rewrite') fs.writeFileSync(extension, `export default api => api.on('message_end', event => {
    if (event.message.role !== 'toolResult' || event.message.toolName !== 'host_desktop_look') return;
    return { message: { ...event.message, content: [{ type: 'text', text: 'changed after tool result' },
      ...event.message.content.filter(part => part.type === 'image')] } };
  });`);
  let current = true, desktopTurn = mode === 'turn-missing' ? undefined : 'desktop-turn', checks = 0, captureRequests = 0, connection;
  const diagnostics = [], events = [];
  const capturePng = mode === 'ipc-cap' ? Buffer.concat([png, Buffer.alloc(20 * 1024 * 1024 - png.length)]) : png;
  const tool = { id: 'host.desktop.look', label: 'desktop', description: 'offline screenshot fixture', permissionClass: 'read',
    resultFormat: 'execute-result-json', parameters: Type.Object({}),
    async execute() {
      if (desktopCaptureImageRequested()) {
        captureRequests++;
        stageDesktopCaptureImage(capturePng, () => {
          checks++;
          if (mode === 'desktop-steer' && checks === 2) desktopTurn = 'next-desktop-turn';
          return current && (mode !== 'revoked' || checks < 3);
        });
      }
      return JSON.stringify({ ok: true, result: { width: mode === 'dimensions' ? 2499 : 2500, height: 1200, path: 'fixture.png',
        ...(mode === 'ipc-cap' ? { padding: 'x'.repeat(6 * 1024 * 1024) } : {}) } });
    } };
  const readTurn = async () => {
    const turn = [];
    for await (const event of connection.events) {
      events.push(event); turn.push(event);
      if (event.type === 'turn-complete' || event.type === 'error') break;
    }
    assert.equal(turn.at(-1)?.type, 'turn-complete', JSON.stringify({ types: turn.map(event => event.type), diagnostics }));
  };
  try {
    connection = await createPiWorkerConnection({ sessionId: `fixture-${mode}`, cwd: dir, systemPromptAppend: '', nativeTools: [],
      ...(mode === 'rewrite' ? { extensionPaths: [extension] } : {}),
      modeController: { mode: 'auto', executing: false, planSteps: [] }, hostTools: [tool],
      getTurnId: () => current ? 'host-turn' : undefined, getDesktopTurnId: () => current ? desktopTurn : undefined,
      getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }),
      log: (level, message) => diagnostics.push(`${level}: ${message}`) },
    { ctx: { usage: { recordModelCall() {} } }, userDataDir: userData, providerId: 'fixture', modelId: 'fixture',
      shellEnv: { settings: { images: { autoResize: true }, retry: { enabled: false }, compaction: { enabled: false } }, bashAvailable: true }, secrets: [] });
    await connection.send('Run the screenshot fixture.'); await readTurn();
    assert.equal(requests.length, 2);
    const second = JSON.stringify(requests[1]);
    assert.equal(second.includes(base64), mode === 'vision', 'image must reach only the visual, authorized model');
    assert.equal(captureRequests, mode === 'text' || mode === 'turn-missing' ? 0 : 1);
    assert.equal(JSON.stringify(events).includes(base64), false, 'screenshot bytes must not enter public GUI events');
    if (mode === 'text') assert.match(second, /不支持或无法确认图像输入/);
    if (mode === 'revoked') assert.match(second, /authorization changed/i);
    if (mode === 'desktop-steer') assert.match(second, /authorization changed/i);
    if (mode === 'turn-missing') assert.match(second, /turn is unavailable/i);
    if (mode === 'rewrite') assert.match(second, /screenshot changed or became unavailable/i);
    if (mode === 'dimensions') assert.match(second, /dimensions are invalid/i);
    if (mode === 'ipc-cap') assert.match(second, /IPC capacity/i);
    if (mode === 'vision') {
      // A 2500-pixel image would normally be resized by Pi's default 2000-pixel limit.
      const image = requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(part => part.type === 'image_url');
      assert.ok(image?.image_url?.url === `data:image/png;base64,${base64}`, 'model must receive the unscaled PNG');
      const sessionDir = path.join(userData, 'agents', 'pi', 'sessions');
      const files = fs.readdirSync(sessionDir).filter(file => file.endsWith('.jsonl'));
      assert.equal(files.length, 1); assert.ok(fs.readFileSync(path.join(sessionDir, files[0]), 'utf8').includes(base64), 'Pi persists the tool image in native history');
      await connection.send('Continue this conversation.'); await readTurn();
      assert.equal(requests.length, 3);
      assert.ok(JSON.stringify(requests[2]).includes(base64), 'Pi resends the historical screenshot on a subsequent request');
    }
  } finally {
    current = false; await connection?.close();
  }
}

try {
  for (const mode of ['vision', 'text', 'revoked', 'desktop-steer', 'turn-missing', 'rewrite', 'dimensions', 'ipc-cap']) await exercise(mode);
  console.log('gui-pi-capture-worker: real Pi worker image, text fallback, revocation and history passed');
} finally {
  await new Promise(resolve => server.close(resolve)); setSkillsManagementService(undefined); Module._load = originalLoad;
  removeWorkspaceFixture(tmp, prefix);
}
