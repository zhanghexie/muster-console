/** Real Pi tool -> transcript -> iframe -> host state/actions, plus real SDK stdin and browser guest. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const project = path.resolve(__dirname, '../..');
test('会话交互 UI：自然滚动、组件联动、状态恢复、Pi/SDK 上下文与网页区', async () => {
  test.setTimeout(145000);
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'ui-widget-native-'));
  const workspace = path.join(fixture, 'workspace'), userData = path.join(fixture, '.dev-sandbox/userData');
  const bin = path.join(fixture, 'bin'), sdkHome = path.join(fixture, 'sdk-home'), ledger = path.join(fixture, 'sdk-input.json');
  for (const dir of [workspace, userData, bin, sdkHome]) fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(workspace, 'app-server'), `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;console.log(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{model:'fixture',displayName:'Fixture',isDefault:true,supportedReasoningEfforts:['medium'],defaultReasoningEffort:'medium'}],nextCursor:null}:m.method==='config/read'?{config:{model:'fixture'}}:{}}));});`);
  fs.writeFileSync(path.join(fixture, 'exec'), `const fs=require('node:fs');let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.env.UI_WIDGET_SDK_INPUT,text);for(const e of [{type:'thread.started',thread_id:'widget-fixture-thread'},{type:'item.completed',item:{id:'message',type:'agent_message',text:'SDK received state.'}},{type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}])console.log(JSON.stringify(e));});`);
  const fragment = fs.readFileSync(path.join(project, 'docs/prototypes/intelligent-ui/composed-demo.fragment.html'), 'utf8') + fs.readFileSync(path.join(project, 'docs/prototypes/intelligent-ui/convenience-demo.fragment.html'), 'utf8');
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      const request = JSON.parse(body); requests.push(request);
      const last = request.messages.at(-1), text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'widget', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (last.role === 'user' && text.includes('fixture-ui-create')) {
        chunk({ tool_calls: [{ index: 0, id: 'render-widget', type: 'function', function: { name: 'ui_render', arguments: JSON.stringify({ title: '发布方案比较', html: fragment }) } }] }); chunk({}, 'tool_calls');
      } else {
        let output = '选择已收到。';
        if (last.role === 'tool') {
          try { const parsed = JSON.parse(text), result = parsed.result ?? parsed; if (result.markdown) output = `可以筛选并选择方案：\n\n${result.markdown}\n\n选好后可保留参数继续讨论。`; }
          catch { output = text; }
        }
        chunk({ content: output }); chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'widgets', workspace, workspaces: [{ id: 'widgets', path: workspace, name: '交互内容验收' }],
    openai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-only', model: 'mock' },
    mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const originalPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  Object.assign(env, { PATH: bin + path.delimiter + originalPath, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(fixture), CODEX_HOME: sdkHome, UI_WIDGET_SDK_INPUT: ledger });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const priorClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  const errors: string[] = []; app.process().stderr?.on('data', data => errors.push(String(data)));
  const shots = path.join(project, '.tmp/ui-captures/ui-widget-native'); fs.mkdirSync(shots, { recursive: true });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 45000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 1000));
    await win.evaluate(async baseUrl => window.api.config.update({ openai: { baseUrl, apiKey: 'fixture-only', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    const session = await win.evaluate(async () => { const created = await window.api.sessions.create({ runtime: 'pi', name: '交互内容验收', guiMode: 'auto' }); await window.api.sessions.select(created.id); return created; });
    const sid = session.id, selector = `.chat-list[data-session-id="${sid}"]`;
    const chat = win.locator(selector), frameElement = chat.locator('iframe.ma-ui-frame');
    const content = win.frameLocator(selector + ' iframe.ma-ui-frame');
    const reveal = async (target: import('@playwright/test').Locator, top = 300) => {
      const rectangle = await target.boundingBox(), viewport = await chat.boundingBox();
      expect(rectangle).toBeTruthy(); expect(viewport).toBeTruthy();
      await chat.evaluate((node, offset) => node.scrollTop += offset, rectangle!.y - viewport!.y - top);
    };
    const editor = win.locator('.agent-chat-view').filter({ visible: true }).getByRole('textbox');
    await editor.click(); await editor.pressSequentially('fixture-ui-create'); await editor.press('Enter');
    await expect(frameElement).toHaveCount(1, { timeout: 25000 });
    await expect(content.getByLabel('预算（万元）')).toHaveValue('80');
    await expect(chat.locator('.ma-ui-card.is-loading')).toHaveCount(0);
    await expect.poll(() => frameElement.evaluate(node => Number.parseFloat((node as HTMLElement).style.height))).toBeGreaterThan(1100);
    await content.getByLabel('预算（万元）').fill('90');
    await chat.evaluate(node => node.scrollTop = 0);
    const inputBox = await content.getByLabel('预算（万元）').boundingBox(); expect(inputBox).toBeTruthy();
    const scrollBefore = await chat.evaluate(node => node.scrollTop);
    await win.mouse.move(inputBox!.x + 20, inputBox!.y + 10); await win.mouse.wheel(0, 160);
    await expect.poll(() => chat.evaluate(node => node.scrollTop)).toBeGreaterThan(scrollBefore + 80);
    await expect(content.getByLabel('预算（万元）')).toHaveValue('90');
    expect(await content.locator('html').evaluate(node => node.scrollTop)).toBe(0);
    await content.getByLabel('状态', { exact: true }).selectOption('可用');
    await expect(content.locator('#plans-table tbody tr')).toHaveCount(4);
    await reveal(content.getByRole('button', { name: '选择 方案 C', exact: true }));
    await content.locator('html').evaluate(() => {
      const witness = { events: [] as unknown[], changes: [] as unknown[] };
      (window as any).__maWidgetWitness = witness;
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
        const target = event.target as HTMLElement;
        witness.events.push({ type, target: target.outerHTML.slice(0, 250), selected: (window as any).maUi.get('selected') });
      }, true);
      (window as any).maUi.subscribe((state: any) => witness.changes.push({ selected: state.values.selected, restored: state.restored }));
    });
    await content.getByRole('button', { name: '选择 方案 C', exact: true }).click();
    await expect(content.locator('ma-text[bind="selected.name"]')).toHaveText('方案 C').catch(async error => {
      console.error('selection witness:', await content.locator('html').evaluate(() => (window as any).__maWidgetWitness));
      await chat.screenshot({ path: path.join(shots, 'selection-failure.png') }); throw error;
    });
    await expect(content.locator('#total .ma-text-value')).toHaveText('240.00 元');
    await reveal(content.getByRole('radio', { name: '九折', exact: true }));
    await content.getByRole('radio', { name: '九折', exact: true }).click();
    await expect(content.locator('#total .ma-text-value')).toHaveText('216.00 元');
    const todo = content.getByRole('checkbox', { name: '实施', exact: true }); await reveal(todo); await todo.check();
    await expect(todo).toBeChecked();
    await expect(content.locator('#phase-list li').nth(1)).toHaveAttribute('data-status', 'done');
    await expect(content.locator('#phase-list progress')).toHaveAttribute('value', '100');
    await expect(content.locator('#comparison .ma-sort-button')).toHaveCount(0);
    await expect(content.locator('#environment tbody th')).toHaveCount(4);
    const bottomAction = content.getByRole('button', { name: '加入输入框', exact: true });
    // A long iframe has its own viewport; scrollIntoView inside it cannot reveal the outer chat's clipped portion.
    const targetBox = await bottomAction.boundingBox(), chatBox = await chat.boundingBox();
    expect(targetBox).toBeTruthy(); expect(chatBox).toBeTruthy();
    await chat.evaluate((node, offset) => node.scrollTop += offset, targetBox!.y - chatBox!.y - 280);
    const bottomBox = await bottomAction.boundingBox(); expect(bottomBox).toBeTruthy();
    expect(bottomBox!.y).toBeGreaterThan(chatBox!.y);
    expect(bottomBox!.y + bottomBox!.height).toBeLessThan(chatBox!.y + chatBox!.height - 140);
    const bottomScroll = await chat.evaluate(node => node.scrollTop);
    await win.mouse.move(bottomBox!.x + 5, bottomBox!.y + 5); await win.mouse.wheel(0, -160);
    await expect.poll(() => chat.evaluate(node => node.scrollTop)).toBeLessThan(bottomScroll - 80);
    await reveal(content.getByRole('button', { name: /投入\/万元，排序/ }));
    await content.getByRole('button', { name: /投入\/万元，排序/ }).click();
    await content.locator('#plans-table').getByRole('button', { name: '复制', exact: true }).first().click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('方案 E');
    await expect(content.locator('#plans-table ma-button').first().getByRole('status')).toHaveText('已复制');
    const artifact = path.join(userData, 'agent-sessions', sid, 'ui', '01-ui.inline.html');
    await expect.poll(() => fs.existsSync(artifact + '.state.json')).toBe(true);
    const saved = () => JSON.parse(fs.readFileSync(artifact + '.state.json', 'utf8'));
    await expect.poll(() => saved().state.modelContent?.selected?.name).toBe('方案 C');
    await expect.poll(() => saved().state.modelContent?.total).toBe(216);
    await expect.poll(() => saved().state.modelContent?.completed).toContain('build');
    expect(saved().state.modelContent.showNotes).toBeUndefined();
    const fold = chat.getByRole('button', { name: '收起', exact: true }); await fold.scrollIntoViewIfNeeded();
    const anchor = await fold.boundingBox(); await fold.click();
    await expect(chat.getByRole('button', { name: '展开', exact: true })).toBeVisible();
    const after = await chat.getByRole('button', { name: '展开', exact: true }).boundingBox();
    expect(Math.abs(after!.y - anchor!.y)).toBeLessThan(3);
    await win.evaluate(async () => { const another = await window.api.sessions.create({ runtime: 'pi', name: '其他会话' }); await window.api.sessions.select(another.id); });
    await win.evaluate(async id => window.api.sessions.select(id), sid);
    await expect(chat.getByRole('button', { name: '展开', exact: true })).toBeVisible();
    await chat.getByRole('button', { name: '展开', exact: true }).click();
    await expect(content.getByLabel('预算（万元）')).toHaveValue('90');
    await expect(content.getByLabel('状态', { exact: true })).toHaveValue('可用');
    await expect(content.locator('ma-text[bind="selected.name"]')).toHaveText('方案 C');
    await expect(content.getByRole('radio', { name: '九折', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(content.locator('#total .ma-text-value')).toHaveText('216.00 元');
    await expect(content.getByRole('checkbox', { name: '实施', exact: true })).toBeChecked();
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async theme => window.api.themes.activate(theme), theme);
      for (const width of [780, 390]) {
        await chat.evaluate((node, width) => { const surface = node.closest<HTMLElement>('.chat-surface-view')!; surface.style.width = width + 'px'; surface.style.maxWidth = width + 'px'; surface.style.flex = '1 1 0'; }, width);
        await expect.poll(() => content.locator('html').getAttribute('data-theme')).toBe(theme);
        await chat.evaluate(node => node.scrollTop = 0);
        await chat.screenshot({ path: path.join(shots, `${theme}-${width}.png`) });
        await content.getByLabel('单价', { exact: true }).scrollIntoViewIfNeeded();
        const convenienceBox = await content.locator('#total').boundingBox(), viewport = await chat.boundingBox();
        await chat.evaluate((node, offset) => node.scrollTop += offset, convenienceBox!.y - viewport!.y - 300);
        await chat.screenshot({ path: path.join(shots, `convenience-${theme}-${width}.png`) });
        await reveal(content.locator('#phase-list'), 100);
        await chat.screenshot({ path: path.join(shots, `lists-${theme}-${width}.png`) });
        const widthNow = await content.locator('ma-chart svg').evaluate(node => Number(node.getAttribute('viewBox')?.split(' ')[2]));
        expect(widthNow).toBeLessThan(width); expect(widthNow).toBeGreaterThan(160);
        if (width === 390) expect(await content.locator('ma-grid').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).gridTemplateColumns.split(' ').length === 1))).toBe(true);
        const hostFont = await chat.evaluate(node => getComputedStyle(node).getPropertyValue('--font-body').trim());
        expect(await content.locator('html').evaluate(node => getComputedStyle(node).getPropertyValue('--fs-body').trim())).toBe(hostFont);
      }
    }
    await editor.click(); await editor.pressSequentially('保留已有草稿。');
    await reveal(content.getByRole('button', { name: '加入输入框', exact: true }));
    await content.getByRole('button', { name: '加入输入框', exact: true }).click();
    await expect(editor).toContainText('保留已有草稿。'); await expect(editor).toContainText('方案 C');
    await editor.press('Enter');
    await expect.poll(() => JSON.stringify(requests.at(-1)?.messages.filter((m: any) => m.role === 'user').at(-1))).toContain('<ui-widget-state>');
    const actualUser = JSON.stringify(requests.at(-1).messages.filter((m: any) => m.role === 'user').at(-1));
    expect(actualUser).toContain('方案 C'); expect(actualUser).not.toContain('privateContent');
    const sdkSession = await win.evaluate(async () => { const created = await window.api.sessions.create({ runtime: 'codex-gui', name: 'SDK 状态验收', guiMode: 'auto' }); await window.api.sessions.select(created.id); return created; });
    const sdkArtifact = path.join(userData, 'agent-sessions', sdkSession.id, 'ui', '01-state.inline.html');
    fs.mkdirSync(path.dirname(sdkArtifact), { recursive: true }); fs.copyFileSync(artifact, sdkArtifact);
    await win.evaluate(async ({ file, id }) => { await window.api.uiWidgets.save(file, { modelContent: { selected: 'SDK_CHOICE' }, privateContent: { secret: 'PRIVATE_ONLY' } }); await window.api.agentSession.send(id, 'receive public choice'); }, { file: sdkArtifact, id: sdkSession.id });
    await expect.poll(() => fs.existsSync(ledger), { timeout: 20000 }).toBe(true);
    const sdkInput = fs.readFileSync(ledger, 'utf8'); expect(sdkInput).toContain('SDK_CHOICE'); expect(sdkInput).not.toContain('PRIVATE_ONLY');
    // CLI-style artifact opening uses the actual browser partition/preload; no synthetic iframe.
    const browser = await win.evaluate(async file => window.api.browser.open({ url: 'muster-ext://f/' + encodeURIComponent(file.replace(/\\/g, '/')) }), artifact);
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getType() === 'webview' && w.getURL().startsWith('muster-ext://')).length)).toBe(1);
    const guestReady = () => app.evaluate(({ webContents }) => { const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().startsWith('muster-ext://')); return guest?.executeJavaScript('!!window.__maUiHost && window.maUi?.version === 2'); });
    await expect.poll(guestReady).toBe(true);
    const guestState = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().startsWith('muster-ext://'))!.executeJavaScript('maUi.whenReady().then(()=>({budget:maUi.get("budget"),selected:maUi.get("selected").name}))'));
    expect(guestState).toEqual({ budget: 90, selected: '方案 C' });
    expect(browser.id).toBeTruthy();
    console.log(`ui native screenshots: ${shots}`);
  } catch (error) { console.error(errors.slice(-12).join('\n')); throw error; }
  finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), priorClipboard).catch(() => {}); await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
