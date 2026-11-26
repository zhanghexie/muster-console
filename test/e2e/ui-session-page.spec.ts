/** Real CLI PTY -> authenticated ui.render -> right workspace -> production GUI cards. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('CLI UI opens one shared page, retains state, and routes actions to its composer draft', async () => {
  test.setTimeout(100000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'cli-ui-page-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', workspace,
    activeWorkspaceId: 'ui-test', workspaces: [{ id: 'ui-test', path: workspace, name: 'CLI UI' }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const runtimeRoot = path.join(userData, 'agent-runtimes'); fs.mkdirSync(runtimeRoot);
  fs.cpSync(path.join(project, 'src/main/runtime/builtins/scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(project, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  registry.runtimes.push({ id: 'fixture-cli', label: 'CLI fixture', script: 'fixture-cli.mjs', enabled: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  const records = path.join(fixture, 'records.jsonl'), worker = path.join(fixture, 'cli.cjs');
  const expandedFragment = fs.readFileSync(path.join(project, 'docs/prototypes/intelligent-ui/expanded-demo.fragment.html'), 'utf8');
  fs.writeFileSync(worker, `const fs=require('node:fs');
const record=value=>fs.appendFileSync(${JSON.stringify(records)},JSON.stringify(value)+'\\n');
const tool=async(name,args)=>{const r=await fetch(process.env.MUSTER_TOOL_URL,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.MUSTER_SESSION_TOKEN},body:JSON.stringify({name,arguments:args})});const reply=await r.json();if(!reply.ok)throw Error(JSON.stringify(reply));return reply.result;};
const fragment='<ma-input name="budget" label="预算" type="number" value="80"></ma-input><ma-text expr="budget * 2" label="合计" variant="metric"></ma-text><ma-button label="继续分析" prompt="分析预算 {budget}"></ma-button>';
let first; let chain=Promise.resolve();
const expanded=${JSON.stringify(expandedFragment)};
async function command(text){try{if(text==='UI_FIRST'){first=await tool('ui.render',{title:'预算试算',html:fragment});record({kind:'first',result:first});}else if(text==='UI_SECOND'){record({kind:'second',result:await tool('ui.render',{title:'执行清单',html:'<ma-text text="第二份交互界面"></ma-text>',mode:'browser'})});}else if(text==='UI_UPDATE'){record({kind:'update',result:await tool('ui.render',{title:'预算试算（已更新）',html:fragment+'<ma-text text="更新成功"></ma-text>',update:first.link})});}}catch(e){record({kind:'error',error:String(e)});}}
const originalCommand=command;command=async text=>{if(text==='UI_EXPANDED'){try{record({kind:'expanded',result:await tool('ui.render',{title:'扩展交互控件',html:expanded})});}catch(e){record({kind:'error',error:String(e)});}}else await originalCommand(text);};
process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{record({kind:'input',text:data});for(const ch of data){if(ch==='\\r'||ch==='\\n'){const line=input.trim();input='';if(line.startsWith('UI_'))chain=chain.then(()=>command(line));}else input+=ch;}});
record({kind:'ready'});process.stdout.write('CLI fixture ready\\n');process.stdin.resume();`);
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-cli.mjs'), `import {randomUUID} from 'node:crypto';
export function pasteInput(){return true;}
export async function allocate(){return {sessionId:randomUUID()};}
export function resolveLaunch(){return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(worker)}]};}`);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(fixture) });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const read = (): any[] => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const shots = path.join(project, '.tmp/ui-captures/cli-ui-page'); fs.mkdirSync(shots, { recursive: true });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 45000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 1000));
    const session = await win.evaluate(async () => { const created = await window.api.sessions.create({ runtime: 'fixture-cli', name: 'CLI UI 验收' }); await window.api.sessions.select(created.id); return created; });
    await expect.poll(() => read().some(item => item.kind === 'ready')).toBe(true);
    const send = async (command: string, kind: string) => {
      const count = read().filter(item => item.kind === kind).length;
      await win.evaluate(({ id, text }) => window.api.pty.input(id, text + '\r'), { id: session.id, text: command });
      await expect.poll(() => read().filter(item => item.kind === kind).length, { timeout: 15000 }).toBeGreaterThan(count);
      expect(read().filter(item => item.kind === 'error')).toEqual([]);
      return read().filter(item => item.kind === kind).at(-1).result;
    };
    const first = await send('UI_FIRST', 'first');
    expect(first.presentation.opened).toBe(true); expect(first.usage).toContain('右侧浏览器');
    const page = win.locator('.ui-session-page').filter({ visible: true });
    await expect(page).toBeVisible();
    const cards = page.locator('.ma-ui-card'); await expect(cards).toHaveCount(1);
    const form = page.frameLocator('iframe'); await expect(form.getByLabel('预算', { exact: true })).toHaveValue('80');
    const waitForFramePresentation = async (card: import('@playwright/test').Locator, frame: import('@playwright/test').FrameLocator) => {
      await expect.poll(async () => {
        const expected = await frame.locator('#ma-ui-content').evaluate(node => Math.ceil(Math.max(node.scrollHeight, node.getBoundingClientRect().height)));
        return Math.abs(expected - await card.locator('iframe').evaluate(node => node.clientHeight));
      }).toBeLessThanOrEqual(1);
      await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await frame.locator('html').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    // The right work surface intentionally consumes its first physical click to activate.
    // Activate on empty space, then assert the actual button action reaches the CLI.
    await page.click({ position: { x: 5, y: 5 } });
    await expect.poll(() => win.locator('.browser-gesture-layer').evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
    await form.getByLabel('预算', { exact: true }).fill('95');
    await expect.poll(() => win.evaluate(async link => (await window.api.uiWidgets.read(link)).state.modelContent, first.link)).toMatchObject({ budget: 95 });
    await waitForFramePresentation(cards.first(), form);
    await form.getByRole('button', { name: '继续分析' }).click();
    await expect(form.locator('ma-button [role="status"]')).toHaveText('已加入输入框');
    const composer = win.locator('.cli-composer .composer-editable');
    await expect(composer).toHaveText('分析预算 95');
    expect(read().filter(item => item.kind === 'input').map(item => item.text).join('')).not.toContain('分析预算 95');
    await composer.fill('');
    const beforeFrame = await cards.first().locator('iframe').getAttribute('src');
    const second = await send('UI_SECOND', 'second');
    expect(second.presentation.tabId).toBe(first.presentation.tabId);
    await expect(cards).toHaveCount(2); expect(await cards.first().locator('iframe').getAttribute('src')).toBe(beforeFrame);
    await expect(page.frameLocator('iframe').first().getByLabel('预算', { exact: true })).toHaveValue('95');
    expect((await win.evaluate(() => window.api.browser.restore())).tabs.filter(tab => tab.url.startsWith('muster-ui:'))).toHaveLength(1);
    expect(await win.locator(`webview[data-tab-id="${first.presentation.tabId}"]`).count()).toBe(0);
    const updated = await send('UI_UPDATE', 'update'); expect(updated.version).toBe(2);
    await expect(cards).toHaveCount(2);
    await expect(page.frameLocator('iframe').first().getByText('更新成功')).toBeVisible();
    await expect(page.frameLocator('iframe').first().getByLabel('预算', { exact: true })).toHaveValue('95');
    for (const themeId of ['dark', 'light']) {
      await win.evaluate(async themeId => window.api.themes.activate(themeId), themeId);
      await expect.poll(() => page.frameLocator('iframe').first().locator('html').getAttribute('data-theme')).toBe(themeId);
      await page.screenshot({ path: path.join(shots, `${themeId}.png`) });
    }
    await page.evaluate(node => { node.style.width = '390px'; node.style.right = 'auto'; });
    await expect.poll(async () => (await page.boundingBox())?.width).toBe(390);
    await page.screenshot({ path: path.join(shots, 'narrow.png') });
    await cards.first().getByRole('button', { name: '收起' }).click();
    await expect(cards.first()).toHaveClass(/is-collapsed/);
    await cards.first().getByRole('button', { name: '展开' }).click();
    await expect(page.frameLocator('iframe').first().getByLabel('预算', { exact: true })).toHaveValue('95');
    await win.evaluate(async id => { await window.api.browser.close({ id }); }, first.presentation.tabId);
    await send('UI_SECOND', 'second');
    await expect.poll(async () => (await win.evaluate(() => window.api.browser.restore())).tabs.filter(tab => tab.url.startsWith('muster-ui:')).length).toBe(1);
    const expanded = await send('UI_EXPANDED', 'expanded');
    expect(expanded.warnings, 'The production author smoke must accept the compound controls').toBeUndefined();
    const expandedCard = page.locator('[data-ui-path]').last(), expandedUi = expandedCard.frameLocator('iframe');
    await page.click({ position: { x: 5, y: 5 } });
    await expect.poll(() => win.locator('.browser-gesture-layer').evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
    await expect(expandedUi.getByLabel('统计周期 · 开始日期')).toHaveValue('2026-10-01');
    await expandedUi.getByLabel('统计周期 · 开始日期').fill('2026-11-02');
    await expect(expandedUi.getByRole('alert')).toContainText('开始日期不能晚于结束日期');
    await expandedUi.getByLabel('统计周期 · 开始日期').fill('2026-10-02');
    await expandedUi.getByLabel('地区 · 大区').selectOption('east');
    await expandedUi.getByLabel('地区 · 城市').selectOption('sh');
    await expandedUi.locator('html').evaluate(() => {
      const log: unknown[] = []; (window as any).__expandedWitness = log;
      const push = (entry: unknown) => { log.push(entry); if (log.length > 80) log.shift(); };
      for (const type of ['pointerdown', 'pointerup', 'click', 'change']) document.addEventListener(type, event => {
        const target = event.target as HTMLInputElement;
        push({ type, target: target.id || target.tagName, checked: target.checked, team: (window as any).maUi.get('team'), time: performance.now() });
      }, true);
      (window as any).maUi.subscribe(() => push({ type: 'state', team: (window as any).maUi.get('team'), time: performance.now() }));
      window.addEventListener('message', event => { if (event.data?.__ma) push({ type: event.data.type, team: event.data.state?.modelContent?.team, revision: event.data.state?.revision, time: performance.now() }); });
    });
    await win.evaluate(() => {
      const log: unknown[] = []; (window as any).__expandedHostWitness = log;
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
        const pointer = event as PointerEvent, target = event.target as HTMLElement;
        log.push({ type, target: target.className || target.tagName, x: pointer.clientX, y: pointer.clientY, path: event.composedPath().slice(0, 4).map(node => (node as HTMLElement).className || (node as HTMLElement).tagName) });
      }, true);
    });
    await expandedUi.getByText('展开 产品团队', { exact: true }).click();
    // The new native details rows must be presented through the opaque iframe's
    // resize bridge before sending the next physical pointer action. DOM visibility
    // alone can precede Chromium's cross-frame hit-test update in Electron.
    await waitForFramePresentation(expandedCard, expandedUi);
    try { await expandedUi.getByRole('checkbox', { name: '研发', exact: true }).check(); }
    catch (error) {
      fs.writeFileSync(path.join(fixture, 'tree-click-witness.json'), JSON.stringify(await expandedUi.locator('html').evaluate(() => ({ events: (window as any).__expandedWitness, team: (window as any).maUi.get('team'), diagnostics: (window as any).maUi.getDiagnostics(), rect: document.getElementById('team-node-2')?.getBoundingClientRect().toJSON() })), null, 2));
      fs.writeFileSync(path.join(fixture, 'tree-host-witness.json'), JSON.stringify(await win.evaluate(() => ({ events: (window as any).__expandedHostWitness, gesture: Array.from(document.querySelectorAll('.browser-gesture-layer')).map(node => ({ events: getComputedStyle(node).pointerEvents, rect: node.getBoundingClientRect().toJSON() })), frames: Array.from(document.querySelectorAll('.ui-session-page iframe')).map(node => node.getBoundingClientRect().toJSON()) })), null, 2));
      await win.screenshot({ path: path.join(fixture, 'tree-click-failure.png') }); throw error;
    }
    await expandedUi.getByRole('table', { name: '项目列表', exact: true }).getByRole('button', { name: '选择 record-0', exact: true }).click();
    await expect(expandedUi.locator('#selection-tone')).toHaveAttribute('data-tone', 'success');
    await expandedUi.locator('#records').getByRole('button', { name: '下一页' }).click();
    await expect(expandedUi.locator('#records tbody')).toContainText('record-5');
    await expandedUi.getByLabel('搜索记录').fill('项目 119');
    await expect(expandedUi.locator('#records tbody tr')).toHaveCount(1);
    await expandedUi.getByLabel('导入本地数据').setInputFiles({ name: 'data.json', mimeType: 'application/json', buffer: Buffer.from('{"amount":7}') });
    await expect(expandedUi.locator('ma-file .ma-file-summary')).toContainText('data.json');
    await expect.poll(() => win.evaluate(async link => (await window.api.uiWidgets.read(link)).state.modelContent, expanded.link)).not.toHaveProperty('imported');
    await expandedUi.getByRole('checkbox', { name: '将已选文件内容提供给模型' }).check();
    await expect.poll(() => win.evaluate(async link => (await window.api.uiWidgets.read(link)).state.modelContent, expanded.link)).toMatchObject({ imported: [{ name: 'data.json', text: '{"amount":7}' }], region: ['east', 'sh'], team: ['engineering'], recordIds: ['record-0'] });
    const virtual = expandedUi.locator('#virtual-records .ma-table-virtual');
    await virtual.evaluate(node => { node.scrollTop = 16000; node.dispatchEvent(new Event('scroll')); });
    expect(await expandedUi.locator('#virtual-records tbody tr:not([aria-hidden])').count()).toBeLessThan(25);
    await expect(expandedUi.locator('#virtual-records tbody')).toContainText('virtual-396');
    await expect(expandedUi.locator('#read-only-count .ma-text-value')).toHaveText('3');
    await expect(expandedUi.locator('#read-only-sum .ma-text-value')).toHaveText('6');
    await expect(expandedUi.locator('#read-only-name .ma-text-value')).toHaveText('智能 AGENT');
    await expect(expandedUi.locator('#read-only-match .ma-text-value')).toHaveText('true');
    await expandedUi.getByLabel('名称包含', { exact: true }).fill('不存在');
    await expect(expandedUi.locator('#read-only-match .ma-text-value')).toHaveText('false');
    await expandedUi.locator('#read-only-demo').evaluate(node => { const value = JSON.parse(node.textContent!); value.rows.push({ id: 'd', label: '方案 D' }); node.textContent = JSON.stringify(value); });
    await expect(expandedUi.locator('#read-only-count .ma-text-value')).toHaveText('4');
    await expect(expandedUi.locator('#read-only-table tbody tr')).toHaveCount(4);
    const publicState = await win.evaluate(async link => (await window.api.uiWidgets.read(link)).state, expanded.link);
    expect(JSON.stringify(publicState)).not.toContain('readonly-only-marker');
    const expandedShots = path.join(project, '.tmp/ui-captures/ui-expanded'); fs.mkdirSync(expandedShots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await win.evaluate(theme => window.api.themes.activate(theme), theme);
      await expect.poll(() => expandedUi.locator('html').getAttribute('data-theme')).toBe(theme);
      await page.evaluate(node => { const card = node.querySelector('[data-ui-path]:last-child')!; node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top; });
      await page.screenshot({ path: path.join(expandedShots, theme + '-top.png') });
      await page.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.screenshot({ path: path.join(expandedShots, theme + '-bottom.png') });
    }
    await page.evaluate(node => { node.style.width = '390px'; node.style.right = 'auto'; });
    await page.evaluate(node => { const card = node.querySelector('[data-ui-path]:last-child')!; node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top; });
    await page.screenshot({ path: path.join(expandedShots, 'narrow-top.png') });
    await page.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.screenshot({ path: path.join(expandedShots, 'narrow-bottom.png') });
    await win.evaluate(async id => { const other = await window.api.sessions.create({ runtime: 'fixture-cli', name: '状态恢复' }); await window.api.sessions.select(other.id); await window.api.sessions.select(id); }, session.id);
    await expect(expandedUi.getByLabel('地区 · 城市')).toHaveValue('sh');
    await expect(expandedUi.getByRole('checkbox', { name: '研发', exact: true })).toBeChecked();
  } finally { await app.close(); }
});
