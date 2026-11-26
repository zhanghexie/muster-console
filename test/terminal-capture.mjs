/**
 * terminal.capture / terminal.write 扩展的纯函数与 Catalog 契约。
 * Run: node test/terminal-capture.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-capture-'));
// terminalCapture.ts 现 import shared/i18n（i18next）：用带目录解析与 i18next shim 的
// shared-compile 按依赖树转译；catalog.ts 仅类型依赖，也一并树式带上
const compile = createSharedCompiler(root, tmp);

const sharedOut = compile('shared/terminalCapture.ts');
const {
  CAPTURE_KEEP,
  TEXT_TAIL_CHARS,
  CTRL_C,
  captureFilesToDelete,
  terminalTextTail,
  captureImageRelPath,
  buildSendBotImageArgs,
  encodeTerminalKey,
  isTypedWriteMode,
  splitCaptureDisplay,
  isCaptureToolName,
  resolveTerminalWriteIntent,
  DEFAULT_WRITE_ENTER_COUNT,
  pickTerminalCaptureCanvas,
  captureUsesBufferRaster
} = await import(pathToFileURL(sharedOut).href);

assert.equal(CAPTURE_KEEP, 20);
assert.equal(TEXT_TAIL_CHARS, 800);
assert.equal(CTRL_C, '\x03');

assert.deepEqual(
  captureFilesToDelete(
    [
      { name: 'a.png', mtimeMs: 1 },
      { name: 'b.png', mtimeMs: 3 },
      { name: 'c.txt', mtimeMs: 99 },
      { name: 'd.png', mtimeMs: 2 }
    ],
    2
  ),
  ['a.png']
);
assert.deepEqual(captureFilesToDelete([], 20), []);
const twentyOne = Array.from({ length: 21 }, (_, i) => ({
  name: `c${String(i).padStart(2, '0')}.png`,
  mtimeMs: i
}));
assert.equal(captureFilesToDelete(twentyOne, 20).length, 1);
assert.equal(captureFilesToDelete(twentyOne, 20)[0], 'c00.png');

assert.equal(terminalTextTail('hello'), 'hello');
assert.equal(terminalTextTail('a\n\n\n\nb'), 'a\n\nb');
const long = 'x'.repeat(900);
assert.equal(terminalTextTail(long).length, 800);
assert.equal(terminalTextTail(long), long.slice(-800));

assert.equal(captureImageRelPath('shot.png'), './shot.png');
assert.equal(captureImageRelPath('E:\\\\tmp\\\\shot.png'), './shot.png');
assert.equal(captureImageRelPath('/tmp/shot.png'), './shot.png');
assert.deepEqual(buildSendBotImageArgs('oc_1', './shot.png'), [
  'im',
  '+messages-send',
  '--as',
  'bot',
  '--chat-id',
  'oc_1',
  '--image',
  './shot.png'
]);
assert.equal(encodeTerminalKey('ctrl-c'), '\x03');
assert.equal(encodeTerminalKey('Ctrl+C'), '\x03');
assert.equal(encodeTerminalKey('enter'), '\r');
assert.throws(() => encodeTerminalKey('alt-f4'), /ctrl-c \/ enter/);

assert.deepEqual(resolveTerminalWriteIntent({ mode: 'typed' }), {
  typed: true,
  submit: true,
  enterCount: DEFAULT_WRITE_ENTER_COUNT,
  keyKind: null
});
assert.equal(resolveTerminalWriteIntent({ mode: 'typed', submit: false }).submit, false);
assert.equal(resolveTerminalWriteIntent({ mode: 'submit' }).typed, true);
assert.equal(resolveTerminalWriteIntent({ mode: 'submit' }).submit, true);
assert.equal(resolveTerminalWriteIntent({ mode: 'typed', enterCount: 1 }).enterCount, 1);
assert.equal(resolveTerminalWriteIntent({ mode: 'typed', enterCount: '1' }).enterCount, 1);
assert.equal(resolveTerminalWriteIntent({}).submit, false);
assert.equal(resolveTerminalWriteIntent({ submit: true }).submit, true);
assert.equal(resolveTerminalWriteIntent({ key: 'enter' }).keyKind, 'enter');
assert.equal(resolveTerminalWriteIntent({ key: 'ctrl-c' }).keyKind, 'ctrl-c');
assert.equal(isTypedWriteMode('typed'), true);
assert.equal(isTypedWriteMode('submit'), true);
assert.equal(isTypedWriteMode('raw'), false);
assert.equal(isTypedWriteMode(undefined), false);

assert.equal(
  pickTerminalCaptureCanvas([
    { width: 800, height: 600, webgl: false },
    { width: 800, height: 600, webgl: true },
    { width: 80, height: 600, webgl: false }
  ])?.webgl,
  true,
  '同尺寸优先 WebGL 画布'
);
assert.equal(
  pickTerminalCaptureCanvas([
    { width: 100, height: 100, webgl: false },
    { width: 800, height: 600, webgl: false }
  ])?.width,
  800
);
assert.equal(captureUsesBufferRaster(), true);

assert.equal(isCaptureToolName('terminal.capture'), true);
assert.equal(isCaptureToolName('terminal_capture'), true);
assert.equal(isCaptureToolName('terminal.write'), false);

const split = splitCaptureDisplay({
  ok: true,
  sessionId: 's1',
  textTail: 'hi',
  previewPath: 'C:\\data\\terminal-captures\\a.png'
});
assert.equal(split.imagePath, 'C:\\data\\terminal-captures\\a.png');
assert.equal(split.result.previewPath, split.imagePath, '模型和 UI 使用同一个落盘路径');
assert.equal(splitCaptureDisplay({ ok: true }).imagePath, undefined);
assert.equal(
  JSON.stringify(splitCaptureDisplay({ ok: true, textTail: 'x' }).result).includes('preview'),
  false
);

const catalogOut = compile('main/capabilities/catalog.ts');
const {
  CATALOG_VERSION,
  getToolDef,
  WORKER_TOOL_ALLOWLIST,
  EXTENSION_HOST_TOOLS,
  isWorkerAllowedTool,
  isExtensionHostTool,
  catalogAppendixText
} = await import(pathToFileURL(catalogOut).href);

assert.ok(Number(CATALOG_VERSION.split('.')[1] || 0) >= 37, `Catalog 版本随 R-18b 多仓组 bump（≥1.37，当前 ${CATALOG_VERSION}）`);

// A6 后 dynamic 附录：组职责在 pi Available tools 行内标注，附录只点名白名单条目
// （全文随工具定义注册，不复述）；组行不再出现（详见 catalog-summary-slim.mjs）
const toolHelp = getToolDef('mcp.search');
assert.ok(toolHelp, '应有 mcp.search');
const appendix = catalogAppendixText();
assert.doesNotMatch(appendix, /tools\.search/, 'R5 发现层退役：附录不再指路 tools.search');
assert.ok(appendix.includes('resident and registered natively') && appendix.includes('run entries'), '工具目录指向常驻直调与 run 入口');
assert.equal(appendix.includes('统一派活（推荐）'), false, '白名单描述不在附录复述');
assert.ok(appendix.length < 2000, `附录应保持瘦形态（当前 ${appendix.length} 字）`);
assert.doesNotMatch(appendix, /\[\w+\] \d+ 个工具/, '组行不再出现在附录');

const setStatus = getToolDef('sessions.setStatus');
assert.ok(setStatus, '应有 sessions.setStatus');
assert.equal(setStatus.parameters.required, undefined, 'phase/note 至少传一个，由 executor 校验');
assert.match(setStatus.description, /Omit sessionId for your own session/, 'Catalog 写明调度缺省报到本会话');
assert.ok(getToolDef('sessions.observe'));
assert.ok(getToolDef('sessions.observe'));
assert.ok(getToolDef('sessions.search'));
assert.ok(getToolDef('llm.quota'));
assert.ok(getToolDef('sessions.observe'));
assert.ok(getToolDef('events.subscribe'));
assert.ok(getToolDef('events.unsubscribe'));
assert.ok(getToolDef('sessions.observe'));
assert.ok(getToolDef('share.set'));
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.observe'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.observe'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.search'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('llm.quota'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.observe'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.subscribe'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.unsubscribe'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.register'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.emit'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.review'), false);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.observe'), true);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('share.set'), true);
assert.equal(getToolDef('sessions.setPhase'), undefined, '旧 setPhase 已合并');
assert.equal(getToolDef('sessions.setLiveStatus'), undefined, '旧 setLiveStatus 已合并');
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.integrate'), false);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.requestIntegrate'), true);
const integrate = getToolDef('sessions.integrate');
assert.ok(integrate, '应有 sessions.integrate');
assert.equal(integrate.dangerous, true);
assert.equal(isWorkerAllowedTool('sessions.integrate'), false);
const approvalProp = integrate.parameters.properties.approval;
assert.ok(approvalProp, 'sessions.integrate 应有 approval 参数');
assert.deepEqual(approvalProp.enum, ['auto', 'required']);
assert.ok(!integrate.parameters.required?.includes('approval'), 'approval 缺省 required，schema 不强制');
const requestIntegrate = getToolDef('sessions.requestIntegrate');
assert.ok(requestIntegrate, '应有 sessions.requestIntegrate');
assert.equal(requestIntegrate.dangerous, false);
assert.equal(isWorkerAllowedTool('sessions.requestIntegrate'), true);

const capture = getToolDef('terminal.capture');
assert.ok(capture, '应有 terminal.capture');
assert.equal(capture.dangerous, false);
assert.ok(capture.parameters.properties.sessionId);
assert.ok(capture.parameters.properties.name);
assert.equal(capture.parameters.additionalProperties, false);
assert.equal(capture.parameters.properties.delivery, undefined);
assert.equal(capture.parameters.properties.caption, undefined);
assert.equal(capture.parameters.required, undefined);

const write = getToolDef('terminal.write');
assert.ok(write.parameters.properties.name);
assert.ok(write.parameters.properties.mode);
assert.ok(write.parameters.properties.key);
assert.ok(write.parameters.properties.enterCount);
assert.ok(!write.parameters.required?.includes('sessionId'));
assert.ok(!write.parameters.required?.includes('text'));
assert.match(write.parameters.properties.submit.description, /typed\/submit default true, raw false/);
assert.match(write.description, /sessionId or name, and text or key/);
assert.match(write.parameters.properties.key.description, /enter/);

assert.equal(WORKER_TOOL_ALLOWLIST.includes('terminal.capture'), false);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('terminal.write'), false);
assert.equal(EXTENSION_HOST_TOOLS.includes('host.terminal.capture'), false);
assert.equal(EXTENSION_HOST_TOOLS.includes('host.terminal.write'), true);
assert.equal(isWorkerAllowedTool('terminal.capture'), false);
assert.equal(isExtensionHostTool('terminal.capture'), false);
assert.equal(isExtensionHostTool('terminal_capture'), false);
assert.equal(isExtensionHostTool('host.terminal.capture'), false);

// Exercise the actual handler -> executor -> model serialization (run entries expand in the executor since R5).
compile('main/capabilities/validateArguments.ts');
const executorOut = compile('main/capabilities/executor.ts');
const executorSource = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
for (const [, exports, filename] of executorSource.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
  if (filename === 'terminal') continue;
  fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${filename}.mjs`), exports.split(',').map(name => `export const ${name.trim()} = {};`).join('\n'));
}
const electronDir = path.join(tmp, 'node_modules/electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', exports: './index.js' }));
fs.writeFileSync(path.join(electronDir, 'index.js'), 'export const app = {getPath: () => globalThis.captureUserData};');
fs.writeFileSync(path.join(tmp, 'main/ipc/rendererRequest.mjs'), 'export const requestRendererOnce = async () => {globalThis.captureStarted?.();return globalThis.captureReply;};');
const validatorFile = path.join(tmp, 'main/capabilities/validateArguments.mjs');
fs.writeFileSync(validatorFile, fs.readFileSync(validatorFile, 'utf8').replace('@earendil-works/pi-ai/utils/validation', pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/validation.js')).href));
const { executeTool, serializeResult } = await import(pathToFileURL(executorOut).href);
const { terminalHost } = await import(pathToFileURL(path.join(tmp, 'main/capabilities/hosts/terminal.mjs')).href);
globalThis.captureUserData = path.join(tmp, 'user-data');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
globalThis.captureReply = { ok: true, dataUrl: png };
let buffer = 'CLI ready';
const ctx = { getWindow: () => ({}), resolveBubbleWorkspaceId: () => 'ws',
  sessions: { get: () => ({ id: 's1', type: 'terminal', name: 'CLI' }) },
  pty: { getBuffer: () => buffer, getOutputCursor: () => 'cursor', write: () => true } };
try {
  const written = await terminalHost['terminal.write'](ctx, { sessionId: 's1', text: 'query' });
  assert.equal(written.outputCursor, 'cursor', 'write returns a cursor captured before input');
  {
    // R5：发现层退役——直调工具经 executeTool 序列化（原 tools.call 代理路径已删）
    const result = await executeTool(ctx, 'terminal.capture', '{"sessionId":"s1"}');
    assert.equal(result.ok, true, JSON.stringify(result));
    const model = JSON.parse(serializeResult(result)).result;
    assert.equal(model.imageCaptured, true);
    assert.equal(model.previewPath, result.display.imagePath, 'direct calls preserve PNG path for the model');
    assert.ok(fs.existsSync(model.previewPath));
    assert.equal(model.textTail, 'CLI ready');
    assert.equal(model.outputCursor, 'cursor');
    assert.equal(path.basename(path.dirname(model.previewPath)), 'terminal-captures');
    assert.equal(Object.hasOwn(model, 'delivery'), false);
  }
  const obsolete = await executeTool(ctx, 'terminal.capture', '{"sessionId":"s1","delivery":"feishu"}');
  assert.equal(obsolete.ok, false);
  await assert.rejects(terminalHost['terminal.capture'](ctx, { sessionId: 's1', delivery: 'feishu' }), /capture is local/);
  let reply;
  const started = new Promise(resolve => { globalThis.captureStarted = resolve; });
  globalThis.captureReply = new Promise(resolve => { reply = resolve; });
  const stop = new AbortController();
  const cancelled = executeTool(ctx, 'terminal.capture', '{"sessionId":"s1"}', {signal:stop.signal});
  await started; stop.abort(); reply({ok:true,dataUrl:png});
  assert.equal((await cancelled).cancelled, true);
  delete globalThis.captureStarted;
  globalThis.captureReply = { ok: false, error: 'renderer unavailable' };
  const fallback = JSON.parse(serializeResult(await executeTool(ctx, 'terminal.capture', '{"sessionId":"s1"}'))).result;
  assert.equal(fallback.imageCaptured, false);
  assert.equal(fallback.previewPath, undefined);
  assert.equal(fallback.textTail, 'CLI ready');
  assert.equal(fallback.captureError, 'renderer unavailable');
  buffer = '';
  assert.equal((await executeTool(ctx, 'terminal.capture', '{"sessionId":"s1"}')).ok, false, 'no image and no text is an error');
  globalThis.captureReply = { ok: true, dataUrl: 'data:invalid' };
  assert.equal((await executeTool(ctx, 'terminal.capture', '{"sessionId":"s1"}')).ok, false, 'failed PNG persistence is not success');
} finally {
  delete globalThis.captureUserData; delete globalThis.captureReply; delete globalThis.captureStarted;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('[ok] terminal-capture');
