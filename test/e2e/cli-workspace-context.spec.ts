import { test, expect, _electron, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('CLI first prompt discovers and calls host tools without protocol files', async ({}, testInfo) => {
  await exerciseCliWorkspace(testInfo, 'first-prompt');
});

test('真实 CLI PTY 保留多根范围并在进程退出后释放根占用', async ({}, testInfo) => {
  await exerciseCliWorkspace(testInfo, 'workspace');
});

async function exerciseCliWorkspace(testInfo: TestInfo, scenario: 'first-prompt' | 'workspace') {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'cli-context-e2e-'));
  // RuntimeHost only accepts entries in its bundled builtin registry. Use an isolated
  // copy of the built app so the fixture runtime never modifies the real bundle.
  const fixtureApp = path.join(fixture, 'app');
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.cpSync(path.join(project, 'out'), path.join(fixtureApp, 'out'), { recursive: true });
  fs.cpSync(path.join(project, 'resources'), path.join(fixtureApp, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(project, 'package.json'), path.join(fixtureApp, 'package.json'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  fs.mkdirSync(userData, { recursive: true });
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  const a = path.join(fixture, 'a'); const b = path.join(fixture, '源 B');
  const c = path.join(fixture, 'c'); const d = path.join(fixture, 'd');
  for (const dir of [a, b, c, d]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    agentRules: [{ id: 'cli-fixture', text: 'fixture-cli-direct-conduct-rule', enabled: true }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  const runtimeRoot = path.join(userData, 'agent-runtimes');
  const builtinRoot = path.join(project, 'src/main/runtime/builtins');
  fs.cpSync(path.join(builtinRoot, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtinRoot, 'registry.json'), 'utf8'));
  registry.runtimes.push({ id: 'fixture-cli', label: 'Local CLI', script: 'fixture-cli.mjs', enabled: true, builtin: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  const fixtureBuiltins = path.join(fixtureApp, 'out/main/runtime/builtins');
  fs.writeFileSync(path.join(fixtureBuiltins, 'registry.json'), JSON.stringify(registry));
  const records = path.join(fixture, 'cli-records.jsonl');
  const child = path.join(fixture, 'cli.cjs');
  // A real Node process under the production PTY; no model, credentials or external services.
  fs.writeFileSync(child, `const fs = require('node:fs');
const record = value => fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify(value) + '\\n');
const idle = async () => {
  const response = await fetch(process.env.MUSTER_STATUS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activity: 'idle', event: 'stop' }) });
  record({ kind: 'idle', ok: response.ok });
};
const suggest = async () => {
  const response = await fetch(process.env.MUSTER_TOOL_URL, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.MUSTER_SESSION_TOKEN },
    body: JSON.stringify({ name: 'host.ui.suggestReplies', arguments: { replies: ['继续检查', '整理结果'] } }) });
  record({ kind: 'suggest', ok: response.ok, result: await response.text() });
};
const prompt = text => { const i = text.indexOf('请使用 UTF-8 编码读取并立即执行任务文件：'); return i < 0 ? '' : fs.readFileSync(text.slice(i + '请使用 UTF-8 编码读取并立即执行任务文件：'.length).trim(), 'utf8'); };
const args = process.argv.slice(2); const dirs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') dirs.push(args[++i]);
record({ kind: 'start', cwd: process.cwd(), dirs, prompt: prompt(args.at(-1) || '') });
const useHostCatalog = async () => {
  const url = process.env.MUSTER_TOOL_URL;
  const headers = { authorization: 'Bearer ' + process.env.MUSTER_SESSION_TOKEN, 'content-type': 'application/json' };
  const [anonymous, invalid, response] = await Promise.all([
    fetch(url), fetch(url, { headers: { authorization: 'Bearer unknown-fixture-token' } }), fetch(url, { headers })
  ]);
  const catalog = await response.json();
  const tool = catalog.tools?.find(entry => entry.name === 'host.sessions.observe');
  const called = tool && await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name: tool.name, arguments: {} }) });
  const result = called && await called.json();
  record({ kind: 'tool-catalog', anonymous: anonymous.status, invalid: invalid.status, status: response.status,
    schema: tool?.inputSchema?.type, count: catalog.tools?.length, callOk: called?.ok && result?.ok !== false });
};
void useHostCatalog().catch(error => record({ kind: 'tool-catalog', error: String(error) }));
process.stdout.write('Local CLI ready\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8'); let input = '';
process.stdin.on('data', data => { for (const ch of data) { if (ch === '\\r' || ch === '\\n') {
  if (input.trim() === 'FIXTURE_IDLE') void idle();
  else if (input.trim() === 'FIXTURE_SUGGEST') void suggest();
  else if (input.trim() === 'FIXTURE_SCROLL') {
    process.stdout.write(Array.from({ length: 150 }, (_, i) => 'SCROLL_FIXTURE_' + i).join('\\r\\n') + '\\r\\n');
    record({ kind: 'scroll-output' });
  }
  else if (input.startsWith('Read the UTF-8 file ')) {
    const tick = String.fromCharCode(96), file = input.split(tick)[1];
    record({ kind: 'composer', text: input, contents: fs.readFileSync(file, 'utf8') });
  } else if (input.trim()) record({ kind: 'mail-wake', text: input });
  input = '';
} else input += ch; } });
process.stdin.resume();
// This fixture performs no work; report its continuing idle state after PTY redraws as well.
setInterval(() => { void idle(); }, 250);
`);
  const fixtureRuntime = `import { randomUUID } from 'node:crypto';
import { appendCliPrompt } from './_helpers.mjs';
export function workspaceDirectories() { return { flag: '--add-dir', note: 'Local fixture accepts writable directories; no OS sandbox is provided.' }; }
export async function allocate() { return { sessionId: randomUUID() }; }
export function appendPrompt(options) { return appendCliPrompt(options); }
export function resolveLaunch({ extraArgs }) { return { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(child)}, ...extraArgs] }; }
`;
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-cli.mjs'), fixtureRuntime);
  fs.writeFileSync(path.join(fixtureBuiltins, 'scripts/fixture-cli.mjs'), fixtureRuntime);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `cli-context-${process.pid}`;
  env.MUSTER_WEB = '1'; env.MUSTER_WEB_PORT = '0'; env.MUSTER_WEB_HOST = '127.0.0.1';
  const app = await _electron.launch({ executablePath: require('electron'), args: [fixtureApp, '--disable-gpu'], cwd: fixture, env });
  const appOutput: string[] = [];
  app.process().stdout?.on('data', data => appOutput.push(String(data)));
  app.process().stderr?.on('data', data => appOutput.push(String(data)));
  let sessionId: string | undefined;
  const readRecords = () => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const opened = await win.evaluate(async ({ a, b, c }) => (window as any).api.workspaces.open({ name: 'CLI roots',
      roots: [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'c', path: c }], defaultRootId: 'b', controlRootId: 'a' }), { a, b, c });
    expect(opened.ok, opened.message).toBe(true); const workspaceId = opened.activeWorkspaceId;
    const created = await win.evaluate(async workspaceId => (window as any).api.sessions.create({ workspaceId, rootId: 'b', runtime: 'fixture-cli', force: true, name: 'CLI scope' }), workspaceId);
    sessionId = created.id;
    await expect.poll(() => readRecords().length, { timeout: 20_000 }).toBeGreaterThan(0);
    const start = readRecords()[0]; expect(start.cwd).toBe(b); expect(start.dirs).toEqual([a, c]);
    for (const dir of [a, b, c]) expect(start.prompt).toContain(JSON.stringify(dir));
    expect(start.prompt).toContain('fixture-cli-direct-conduct-rule');
    expect(start.prompt).toContain("Reply in the user's requested language.");
    expect(start.prompt).toContain('MUSTER_STATUS_URL');
    expect(start.prompt).toContain('GET MUSTER_TOOL_URL');
    expect(start.prompt).toContain('GET MUSTER_TOOL_URL to read tool names and schemas.');
    expect(start.prompt).toContain('Read/write directories:');
    expect(start.prompt).toContain('Use fenced `mermaid` blocks in Markdown deliverables');
    expect(start.prompt).toContain('If available, use host.ui.render when filtering');
    expect(start.prompt).toContain('Use host.memory.journal for decisions, findings, or handoffs worth revisiting.');
    expect(start.prompt).not.toMatch(/HOST(?:-EXT)?\.md|managed-rules/);
    for (const name of ['HOST.md', 'HOST-EXT.md']) expect(fs.existsSync(path.join(a, '.muster', name))).toBe(false);
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(testInfo.outputPath('cli-first-input-brief.txt'), start.prompt);
    await expect.poll(() => readRecords().find(row => row.kind === 'tool-catalog')).toMatchObject({
      anonymous: 401, invalid: 401, status: 200, schema: 'object', callOk: true
    });
    if (scenario === 'first-prompt') return;
    // Real renderer → preload → main process → captured PTY: a non-paste runtime
    // receives the file instruction and the child reads the original multiline draft.
    await win.evaluate(async id => (window as any).api.sessions.select(id), sessionId);
    const cli = win.locator('.cli-session-view.is-shown');
    const terminal = cli.locator('.terminal-wrap');
    await expect(terminal).toBeVisible();
    const terminalBefore = await terminal.boundingBox();
    expect(terminalBefore).not.toBeNull();
    const rightClickPrevented = await terminal.evaluate(element => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(rightClickPrevented).toBe(false);
    await expect(cli.locator('.term-scan-mask')).toHaveCount(0);
    // 生产 xterm 的空白格：提前松手只预览，长按到阈值才正式开合。
    const screenBox = await terminal.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const blankPoint = { x: screenBox!.x + screenBox!.width * 0.12, y: screenBox!.y + screenBox!.height * 0.25 };
    const holdDown = async () => { await win.mouse.move(blankPoint.x, blankPoint.y); await win.mouse.down(); };
    const dialogForHold = cli.locator('.cli-composer-dialog');
    const capsuleForHold = cli.locator('.cli-composer-capsule-shell');
    await holdDown();
    await expect(cli).toHaveAttribute('data-hold-phase', 'charging');
    await expect(dialogForHold.locator('.cli-composer-state-icon')).toHaveAttribute('data-state', 'expand');
    await expect(dialogForHold.locator('.cli-composer-state-icon')).toHaveClass(/is-charging/);
    await expect.poll(() => dialogForHold.locator('.cli-composer-panel-charge').evaluate(el => {
      const transform = getComputedStyle(el).transform;
      return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
    })).toBeLessThan(0.9999);
    await win.mouse.up();
    await expect(cli).not.toHaveAttribute('data-hold-phase', /.+/);
    await expect(cli.getByRole('button', { name: '展开输入框' })).toBeVisible();
    await holdDown();
    await expect(cli).toHaveAttribute('data-hold-phase', 'committed');
    await expect(dialogForHold.locator('.cli-composer-state-icon')).toHaveAttribute('data-state', 'shrink');
    await expect(dialogForHold.locator('.cli-composer-state-icon')).not.toHaveClass(/is-charging/);
    await win.mouse.up();
    await expect(cli.getByRole('dialog', { name: '输入框' })).toBeVisible();
    await holdDown();
    await expect(cli).toHaveAttribute('data-hold-phase', 'charging');
    await expect(capsuleForHold.locator('.cli-composer-state-icon')).toHaveAttribute('data-state', 'shrink');
    await expect.poll(() => cli.locator('.cli-composer-capsule-charge').evaluate(el => {
      const transform = getComputedStyle(el).transform;
      return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
    })).toBeLessThan(0.9999);
    await win.mouse.up();
    await expect(cli.getByRole('dialog', { name: '输入框' })).toBeVisible();
    await holdDown();
    await expect(cli).toHaveAttribute('data-hold-phase', 'committed');
    await expect(capsuleForHold.locator('.cli-composer-state-icon')).toHaveAttribute('data-state', 'expand');
    await win.mouse.up();
    await expect(cli.getByRole('button', { name: '展开输入框' })).toBeVisible();
    await win.evaluate(async id => (window as any).api.pty.input(id, 'FIXTURE_SUGGEST\r'), sessionId);
    const capsule = cli.getByRole('button', { name: '展开输入框' });
    const capsuleShell = cli.locator('.cli-composer-capsule-shell');
    await expect(capsule).toHaveClass(/has-suggestions/);
    const expandIcon = capsule.locator('.cli-composer-expand-icon');
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => expandIcon.evaluate(el => getComputedStyle(el).animationName)).toBe('cli-composer-breathe');
    await cli.getByRole('button', { name: '识屏' }).click();
    await expect(cli.locator('.term-scan-mask')).toBeVisible();
    await expect(capsule).toBeVisible();
    await cli.getByRole('button', { name: '关闭识屏' }).click();
    await expect(cli.locator('.term-scan-mask')).toHaveCount(0);
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => expandIcon.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await holdDown();
    await expect(cli).toHaveAttribute('data-hold-phase', 'charging');
    await expect.poll(() => dialogForHold.locator('.cli-composer-panel-charge').evaluate(el => getComputedStyle(el).transform)).toBe('none');
    await win.mouse.up();
    await expect(capsule).toBeVisible();
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    const handle = cli.getByRole('button', { name: '拖动输入框' });
    const panelBox = await cli.boundingBox(), handleBox = await handle.boundingBox();
    expect(panelBox).not.toBeNull(); expect(handleBox).not.toBeNull();
    await win.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await win.mouse.down();
    await win.mouse.move(panelBox!.x + 10, panelBox!.y + panelBox!.height / 2, { steps: 8 });
    await win.mouse.up();
    await expect(capsule).toBeVisible(); // 拖动松手不能误触展开
    await expect.poll(async () => Math.abs((await capsuleShell.boundingBox())!.x - panelBox!.x - 8)).toBeLessThan(2);
    const snapped = await capsuleShell.boundingBox();
    await expect(dialogForHold).toHaveAttribute('data-morph-active', 'false');
    // 真实 Chromium 在缩放开始的帧取外壳透明度，防止重新退化成两个独立淡入淡出的面板。
    await dialogForHold.evaluate(el => {
      el.addEventListener('transitionrun', event => {
        if (event.target !== el || (event as TransitionEvent).propertyName !== 'transform') return;
        el.setAttribute(`data-morph-opacity-${el.getAttribute('data-mp-stage')}`, getComputedStyle(el).opacity);
      });
    });
    await capsule.click();
    const editor = cli.locator('.composer-editable');
    await expect(editor).toBeVisible();
    await expect.poll(async () => Number(await dialogForHold.getAttribute('data-morph-opacity-in'))).toBeGreaterThan(0.8);
    await expect(capsuleShell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const dialog = cli.getByRole('dialog', { name: '输入框' });
    await expect.poll(async () => Math.abs((await dialog.boundingBox())!.width - (panelBox!.width - 16))).toBeLessThan(2);
    await expect.poll(async () => {
      const box = (await dialog.boundingBox())!;
      return Math.abs(box.y + box.height / 2 - (snapped!.y + snapped!.height / 2));
    }).toBeLessThan(2);
    const terminalAfterOpen = await terminal.boundingBox();
    expect(terminalAfterOpen?.width).toBe(terminalBefore?.width);
    expect(terminalAfterOpen?.height).toBe(terminalBefore?.height);
    const expandedHandle = dialog.getByRole('button', { name: '拖动输入框' });
    const toolbarButtons = ['识屏', '收起输入框', '拖动输入框', '发送'].map(name => dialog.getByRole('button', { name }));
    const toolbarBoxes = await Promise.all(toolbarButtons.map(button => button.boundingBox()));
    expect(toolbarBoxes.every(Boolean)).toBe(true);
    const centers = toolbarBoxes.map(box => box!.y + box!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    for (let i = 1; i < toolbarBoxes.length; i++) expect(toolbarBoxes[i - 1]!.x).toBeLessThan(toolbarBoxes[i]!.x);
    const expandedHandleBox = await expandedHandle.boundingBox(), dialogBeforeDrag = await dialog.boundingBox();
    expect(expandedHandleBox).not.toBeNull(); expect(dialogBeforeDrag).not.toBeNull();
    await win.mouse.move(expandedHandleBox!.x + expandedHandleBox!.width / 2, expandedHandleBox!.y + expandedHandleBox!.height / 2);
    await win.mouse.down();
    await win.mouse.move(expandedHandleBox!.x + expandedHandleBox!.width / 2, expandedHandleBox!.y + expandedHandleBox!.height / 2 - 40, { steps: 5 });
    await win.mouse.up();
    await expect.poll(async () => (await dialog.boundingBox())!.y).toBeLessThan(dialogBeforeDrag!.y - 10);
    await terminal.click({ position: { x: 10, y: 10 } });
    await expect(dialog).toBeVisible(); // 点击终端空白不自动收起
    await expect.poll(() => dialog.evaluate(el => Number(getComputedStyle(el).opacity))).toBeCloseTo(1, 2);
    await editor.focus();
    await expect.poll(() => dialog.evaluate(el => Number(getComputedStyle(el).opacity))).toBeCloseTo(1, 2);
    const minEditor = await editor.evaluate(el => {
      const css = getComputedStyle(el);
      return { height: Number.parseFloat(css.minHeight), line: Number.parseFloat(css.lineHeight),
        padding: Number.parseFloat(css.paddingTop) + Number.parseFloat(css.paddingBottom) };
    });
    expect(Math.abs(minEditor.height - (minEditor.line * 2 + minEditor.padding))).toBeLessThan(2);
    const emptyEditorHeight = (await editor.boundingBox())!.height;
    const multiline = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    await editor.fill(multiline);
    await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(emptyEditorHeight + 60);
    await editor.fill('');
    await expect.poll(async () => Math.abs((await editor.boundingBox())!.height - emptyEditorHeight)).toBeLessThan(2);
    const resizeHandle = dialog.getByRole('button', { name: '拖动左侧边缘调整宽度（左右方向键微调）' });
    await expect(resizeHandle).toHaveCSS('cursor', 'col-resize');
    const beforeResize = (await dialog.boundingBox())!, resizeBox = (await resizeHandle.boundingBox())!;
    await win.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await win.mouse.down();
    await win.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2 - 60, { steps: 4 });
    expect(Math.abs((await dialog.boundingBox())!.width - beforeResize.width)).toBeLessThan(2);
    expect(Math.abs((await dialog.boundingBox())!.height - beforeResize.height)).toBeLessThan(2);
    await win.mouse.move(resizeBox.x + resizeBox.width / 2 + 120, resizeBox.y + resizeBox.height / 2 - 60, { steps: 6 });
    await win.mouse.up();
    const afterResize = (await dialog.boundingBox())!;
    expect(afterResize.width).toBeLessThan(beforeResize.width - 100);
    expect(Math.abs(afterResize.x + afterResize.width - beforeResize.x - beforeResize.width)).toBeLessThan(2);
    const rightResizeHandle = dialog.getByRole('button', { name: '拖动右侧边缘调整宽度（左右方向键微调）' });
    await expect(rightResizeHandle).toHaveCSS('cursor', 'col-resize');
    const rightResizeBox = (await rightResizeHandle.boundingBox())!;
    await win.mouse.move(rightResizeBox.x + rightResizeBox.width / 2, rightResizeBox.y + rightResizeBox.height / 2);
    await win.mouse.down();
    await win.mouse.move(rightResizeBox.x + rightResizeBox.width / 2 - 60, rightResizeBox.y + rightResizeBox.height / 2, { steps: 5 });
    const rightNarrowed = (await dialog.boundingBox())!;
    expect(rightNarrowed.width).toBeLessThan(afterResize.width - 50);
    expect(Math.abs(rightNarrowed.x - afterResize.x)).toBeLessThan(2);
    await win.mouse.move(rightResizeBox.x + rightResizeBox.width / 2, rightResizeBox.y + rightResizeBox.height / 2, { steps: 5 });
    await win.mouse.up();
    await expect.poll(async () => Math.abs((await dialog.boundingBox())!.width - afterResize.width)).toBeLessThan(2);
    const resizedEmptyEditorHeight = (await editor.boundingBox())!.height;
    await editor.fill(multiline);
    await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(resizedEmptyEditorHeight + 60);
    await editor.fill(Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
    await expect.poll(() => editor.evaluate(el => getComputedStyle(el).maxHeight)).toBe('240px');
    await expect.poll(() => editor.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    await editor.fill('');
    await expect.poll(async () => Math.abs((await editor.boundingBox())!.height - resizedEmptyEditorHeight)).toBeLessThan(2);
    const movedHandle = (await expandedHandle.boundingBox())!;
    await win.mouse.move(movedHandle.x + movedHandle.width / 2, movedHandle.y + movedHandle.height / 2);
    await win.mouse.down();
    await win.mouse.move(movedHandle.x + movedHandle.width / 2 - 60, movedHandle.y + movedHandle.height / 2, { steps: 5 });
    await win.mouse.up();
    await expect.poll(async () => (await dialog.boundingBox())!.x).toBeLessThan(afterResize.x - 40);
    await terminal.click({ position: { x: 10, y: 10 } });
    await dialog.getByRole('button', { name: '收起输入框' }).click();
    await expect.poll(async () => Number(await dialogForHold.getAttribute('data-morph-opacity-out'))).toBeGreaterThan(0.8);
    await expect(dialogForHold).toHaveAttribute('data-morph-active', 'false');
    await expect.poll(() => capsuleShell.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await expect(cli.getByRole('button', { name: '展开输入框' })).toBeVisible();
    const terminalAfterClose = await terminal.boundingBox();
    expect(terminalAfterClose?.width).toBe(terminalBefore?.width);
    expect(terminalAfterClose?.height).toBe(terminalBefore?.height);
    await cli.getByRole('button', { name: '展开输入框' }).click();
    await expect.poll(async () => Math.abs((await dialog.boundingBox())!.width - afterResize.width)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await editor.boundingBox())!.height - resizedEmptyEditorHeight)).toBeLessThan(2);
    await expect(cli.getByRole('button', { name: '继续检查' })).toBeVisible();
    const previousSuggestion = await win.evaluate(async id =>
      (await (window as any).api.sessions.list()).sessions.find((s: { id: string }) => s.id === id)?.cliSuggestedReplies?.messageId, sessionId);
    expect(previousSuggestion).toBeTruthy();
    await dialog.getByRole('button', { name: '清除本轮建议' }).click();
    await expect(cli.locator('.composer-ghost-suggestion')).toHaveCount(0);
    await expect.poll(() => win.evaluate(async id =>
      (await (window as any).api.sessions.list()).sessions.find((s: { id: string }) => s.id === id)?.cliSuggestedReplies ?? null, sessionId)).toBeNull();
    await win.evaluate(async id => (window as any).api.pty.input(id, 'FIXTURE_SUGGEST\r'), sessionId);
    await expect.poll(() => win.evaluate(async id =>
      (await (window as any).api.sessions.list()).sessions.find((s: { id: string }) => s.id === id)?.cliSuggestedReplies?.messageId ?? '', sessionId)).not.toBe('');
    const nextSuggestion = await win.evaluate(async id =>
      (await (window as any).api.sessions.list()).sessions.find((s: { id: string }) => s.id === id)?.cliSuggestedReplies?.messageId, sessionId);
    expect(nextSuggestion).not.toBe(previousSuggestion);
    await expect(cli.getByRole('button', { name: '继续检查' })).toBeVisible();
    await dialog.getByRole('button', { name: '识屏' }).click();
    await expect(cli.locator('.term-scan-mask')).toBeVisible();
    await editor.click(); // 命中测试：识屏遮罩不能覆盖输入框
    await editor.fill('识屏时仍能输入');
    await expect(editor).toHaveText('识屏时仍能输入');
    await dialog.getByRole('button', { name: '关闭识屏' }).click();
    await expect(cli.locator('.term-scan-mask')).toHaveCount(0);
    // 截图前若渲染帧迟迟不来，也要在超时后恢复输入框并退回简化遮罩。
    await dialog.getByRole('button', { name: '识屏' }).evaluate(button => {
      (window as any).__scanTestRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      (button as HTMLButtonElement).click();
    });
    try {
      await expect.poll(() => cli.getAttribute('class')).toContain('is-scan-capturing');
      await expect.poll(() => cli.getAttribute('class'), { timeout: 5_000 }).not.toContain('is-scan-capturing');
    } finally {
      await win.evaluate(() => { window.requestAnimationFrame = (window as any).__scanTestRaf; delete (window as any).__scanTestRaf; });
    }
    await expect(cli.locator('.term-scan-mask')).toBeVisible();
    await expect(editor).toBeVisible();
    await dialog.getByRole('button', { name: '关闭识屏' }).click();
    await expect(cli.locator('.term-scan-mask')).toHaveCount(0);
    // 切走会话时立即取消进行中的截图；再次打开时输入框不应残留隐藏状态。
    await dialog.getByRole('button', { name: '识屏' }).evaluate(button => {
      (window as any).__scanTestRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      (button as HTMLButtonElement).click();
    });
    try {
      await expect.poll(() => cli.getAttribute('class')).toContain('is-scan-capturing');
      await win.evaluate(async id => (window as any).api.sessions.deselect(id), sessionId);
      await expect.poll(() => win.evaluate(id => {
        const wrap = document.querySelector(`[data-session-id="${id}"]`);
        const host = wrap?.closest('.cli-session-view');
        return !host || (!host.classList.contains('is-shown') && !host.classList.contains('is-scan-capturing'));
      }, sessionId)).toBe(true);
    } finally {
      await win.evaluate(() => { window.requestAnimationFrame = (window as any).__scanTestRaf; delete (window as any).__scanTestRaf; });
    }
    await win.evaluate(async id => (window as any).api.sessions.select(id), sessionId);
    await expect(editor).toBeVisible();
    await expect(cli.locator('.term-scan-mask')).toHaveCount(0);
    await editor.fill('');
    await expect(cli.getByRole('button', { name: '继续检查' })).toBeVisible();
    await editor.focus();
    await editor.press('Shift+Tab');
    await expect(cli.locator('.composer-ghost-suggestion')).toHaveText('整理结果');
    await editor.press('Tab');
    await expect(editor).toHaveText('整理结果');
    await editor.fill('首行\n第二行，完整保留');
    await cli.getByRole('button', { name: '收起输入框' }).click();
    await cli.getByRole('button', { name: '展开输入框' }).click();
    await expect(editor).toHaveText('首行\n第二行，完整保留');
    await editor.press('Enter');
    await expect.poll(() => readRecords().find(row => row.kind === 'composer')?.contents, { timeout: 20_000 })
      .toBe('首行\n第二行，完整保留');
    await expect(editor).toBeEmpty();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '收起输入框' })).toBeVisible();
    const priorComposerCount = readRecords().filter(row => row.kind === 'composer').length;
    await cli.locator('.cli-composer input[type="file"]').setInputFiles({
      name: 'fixture image.png', mimeType: 'image/png', buffer: Buffer.from('image fixture bytes')
    });
    await expect(cli.getByRole('button', { name: '点击查看大图' })).toBeVisible();
    await editor.fill('请查看截图');
    await editor.press('Enter');
    await expect.poll(() => readRecords().filter(row => row.kind === 'composer').length, { timeout: 20_000 })
      .toBeGreaterThan(priorComposerCount);
    const attachmentMessage = readRecords().filter(row => row.kind === 'composer').at(-1)!.contents as string;
    const metadata = JSON.parse(attachmentMessage.match(/\[Attachment metadata\]\n([^\n]+)/)![1]);
    expect(metadata.name).toBe('fixture image.png');
    expect(metadata.processing).toContain('path-only');
    expect(fs.readFileSync(metadata.sourcePath, 'utf8')).toBe('image fixture bytes');
    await expect(editor).toBeEmpty();
    await expect(dialog).toBeVisible();
    // 以下步骤检查终端滚轮，需要先由用户手动收起输入区。
    await dialog.getByRole('button', { name: '收起输入框' }).click();
    const workspace = () => win.evaluate(async id => (await (window as any).api.workspaces.list()).workspaces.find((w: { id: string }) => w.id === id), workspaceId);
    const removeC = async () => {
      const ws = await workspace();
      return win.evaluate(async ({ id, ws }) => (window as any).api.workspaces.update(id, {
        roots: ws.roots.filter((root: { id: string }) => root.id !== 'c'), expectedRootsRevision: ws.rootsRevision
      }), { id: workspaceId, ws });
    };
    const blocked = await removeC(); expect(blocked.ok).toBe(false);
    expect(blocked.rootDependencies.some((dep: { rootId: string; kind: string; sessionId: string }) => dep.rootId === 'c' && dep.kind === 'session' && dep.sessionId === sessionId)).toBe(true);
    const ws = await workspace();
    const added = await win.evaluate(async ({ id, ws, d }) => (window as any).api.workspaces.update(id, {
      roots: [...ws.roots, { id: 'd', path: d }], expectedRootsRevision: ws.rootsRevision
    }), { id: workspaceId, ws, d });
    expect(added.ok, added.message).toBe(true);
    // Mail only wakes an idle CLI. Complete startup before the fixture emits its real status hook.
    await win.evaluate(async id => (window as any).api.pty.input(id, 'FIXTURE_IDLE\r'), sessionId);
    await expect.poll(() => readRecords().some(row => row.kind === 'idle' && row.ok)).toBe(true);
    await expect.poll(async () => win.evaluate(async id =>
      (await (window as any).api.sessions.list()).sessions.find((s: { id: string }) => s.id === id)?.lifecycle, sessionId)).toBe('idle');
    const mail = await win.evaluate(async id => (window as any).api.sessions.sendMessage({ sessionId: id, text: 'verify captured source folders' }), sessionId);
    expect(mail.ok, mail.message).toBe(true); expect(mail.receipt).toBe('stored');
    await expect.poll(() => readRecords().filter(row => row.kind === 'mail-wake').length).toBe(1);
    const wake = readRecords().find(row => row.kind === 'mail-wake').text;
    expect(wake).toContain('宿主收信提醒'); expect(wake).toContain('host.mail.read');
    expect(wake).not.toContain('verify captured source folders'); expect(wake).not.toContain(JSON.stringify(d));
    expect(readRecords()[0].dirs).toEqual([a, c]);
    // 真终端有回滚历史时，隐藏的 xterm 滚动条不占宽；滚轮仍能改变历史位置。
    await win.evaluate(async id => (window as any).api.pty.input(id, 'FIXTURE_SCROLL\r'), sessionId);
    await expect.poll(() => readRecords().some(row => row.kind === 'scroll-output')).toBe(true);
    const scrollbar = terminal.locator('.xterm-scrollable-element > .xterm-scrollbar.xterm-vertical');
    const slider = scrollbar.locator('.xterm-slider');
    await expect(scrollbar).toHaveClass(/xterm-invisible/);
    await expect(scrollbar).toHaveCSS('width', '0px');
    await expect.poll(() => slider.evaluate(el => Number.parseFloat((el as HTMLElement).style.top) || 0)).toBeGreaterThan(10);
    const atBottom = await slider.evaluate(el => Number.parseFloat((el as HTMLElement).style.top));
    const screen = (await terminal.locator('.xterm-screen').boundingBox())!;
    await win.mouse.move(screen.x + screen.width * 0.25, screen.y + screen.height * 0.25);
    await win.mouse.wheel(0, -800);
    await expect.poll(() => slider.evaluate(el => Number.parseFloat((el as HTMLElement).style.top))).toBeLessThan(atBottom - 2);
    await expect(scrollbar).toHaveClass(/xterm-invisible/);
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), sessionId);
    await expect.poll(async () => (await removeC()).ok, { timeout: 20_000 }).toBe(true);
    expect((await workspace()).roots.some((root: { id: string }) => root.id === 'c')).toBe(false);
    expect(readRecords().filter(row => row.kind === 'start')).toHaveLength(1);
  } finally {
    fs.writeFileSync(path.join(fixture, 'electron-output.log'), appOutput.join(''));
    if (sessionId) { const win = await app.firstWindow().catch(() => undefined); await win?.evaluate(async id => (window as any).api.sessions.setArchived(id, true), sessionId).catch(() => {}); }
    await app.close().catch(() => {});
  }
}
