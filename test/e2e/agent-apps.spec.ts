/** Real app, production tool executor + IPC + phone; only the model server is deterministic. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHANNEL_APP_ID, defineRecordApp } from '../../src/shared/agentApps';
import { migrateHostToolName } from '../../src/shared/hostToolNames';
import { toApiName } from '../../src/main/capabilities/catalog/api';

const appsToolName = toApiName(migrateHostToolName('apps.run').name);
type ModelMessage = { role: string; content?: unknown; tool_call_id?: string };
type ModelRequest = { messages?: ModelMessage[]; tools?: { function?: { name?: string } }[] };
type ToolTurn = { marker: string; callId: string; args: Record<string, unknown>; sent?: boolean; error?: string; receipt?: string };

function modelText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}

test('未知应用由模型工具安装、执行、自动展示；手动编辑与模型读回同一数据', async () => {
  test.setTimeout(115_000);
  const root = path.resolve(__dirname, '../..'), tmpRoot = path.join(root, '.tmp'); fs.mkdirSync(tmpRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(tmpRoot, 'agent-apps-e2e-'));
  const captures = path.join(root, '.tmp/ui-captures/agent-apps-correction'); fs.mkdirSync(captures, { recursive: true });
  const data = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(data, { recursive: true });
  const project = path.join(fixture, 'work'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: project, activeWorkspaceId: 'phone-test', workspaces: [{ id: 'phone-test', name: '应用实验室', path: project }], mcp: { enabled: false, servers: [] } }));
  let nextTool: ToolTurn | undefined;
  const toolResults: string[] = [];
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', bytes => { body += bytes; }); req.on('end', () => {
      const request = JSON.parse(body) as ModelRequest;
      requestCount++;
      const last = request.messages?.at(-1);
      const turn = nextTool;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'phone-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (turn?.sent && last?.role === 'tool' && last.tool_call_id === turn.callId) {
        turn.receipt = modelText(last.content);
        toolResults.push(turn.receipt);
        chunk({ content: '应用操作已结束。' }); chunk({}, 'stop');
      } else if (turn && !turn.sent && last?.role === 'user' && modelText(last.content).includes(turn.marker)) {
        const advertised = request.tools?.flatMap(tool => tool.function?.name ? [tool.function.name] : []) ?? [];
        if (!advertised.includes(appsToolName)) {
          turn.error = `Scheduler did not declare ${appsToolName}. Advertised tools: ${advertised.join(', ') || '(none)'}`;
          chunk({ content: '应用工具未就绪。' }); chunk({}, 'stop');
        } else {
          turn.sent = true;
          chunk({ tool_calls: [{ index: 0, id: turn.callId, type: 'function', function: { name: appsToolName, arguments: JSON.stringify(turn.args) } }] });
          chunk({}, 'tool_calls');
        }
      } else { chunk({ content: '就绪。' }); chunk({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `phone-test-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1200, 900); });
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async baseUrl => window.api.config.update({ openai: { baseUrl, apiKey: 'fixture', model: 'mock' }, llm: { activeProviderId: 'phone-test', activeModelId: 'mock', providers: [{ id: 'phone-test', name: 'Phone test', enabled: true, api: 'openai-completions', baseUrl, apiKey: 'fixture', models: [{ id: 'mock', name: 'Mock' }] }] } }), `http://127.0.0.1:${port}/v1`);
    const { activeWorkspaceId: ws } = await win.evaluate(() => window.api.workspaces.list()); expect(ws).toBeTruthy();
    const startMotion = async () => win.evaluate(() => {
      const probe = { frames: [] as Record<string, unknown>[], running: true };
      (window as any).__phoneMotion = probe;
      const sample = () => {
        if (!probe.running) return;
        const sheet = document.querySelector('.agent-phone-panel');
        const outgoing = document.querySelector('.ap-scene[data-active="false"][data-app="home"] .ap-tile');
        const incoming = document.querySelector('.ap-scene[data-active="true"]');
        const heading = incoming?.querySelector('.ap-heading');
        probe.frames.push({
          sheetStage: sheet?.getAttribute('data-mp-stage'), sheetY: sheet?.getBoundingClientRect().y,
          sheetTransform: sheet ? getComputedStyle(sheet).transform : '',
          outgoingTransform: outgoing ? getComputedStyle(outgoing).transform : '',
          outgoingOpacity: outgoing ? Number(getComputedStyle(outgoing).opacity) : 0,
          incomingTransform: heading ? getComputedStyle(heading).transform : '',
          incomingBackground: incoming ? getComputedStyle(incoming).backgroundColor : '',
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const finishMotion = async () => {
      await win.waitForFunction(() => (window as any).__phoneMotion.frames.length >= 55);
      return win.evaluate(() => { const probe = (window as any).__phoneMotion; probe.running = false; return probe.frames as Array<{ sheetStage?: string; sheetY?: number; sheetTransform: string; outgoingTransform: string; outgoingOpacity: number; incomingTransform: string; incomingBackground: string }>; });
    };
    await win.getByRole('button', { name: '对话', exact: true }).first().click();
    await expect(win.getByRole('button', { name: '打开手机应用', exact: true })).toBeVisible();
    await win.getByRole('button', { name: '打开记忆子系统', exact: true }).click();
    await startMotion();
    await win.locator('.agent-phone-toggle').click();
    const phone = win.getByRole('region', { name: /的手机$/ });
    await expect(phone).toBeVisible();
    await win.screenshot({ path: path.join(captures, 'sheet-enter.png') });
    const enterMotion = await finishMotion();
    await expect(phone.locator('.ap-panel-toolbar')).toHaveCount(0);
    expect(enterMotion.some(frame => frame.sheetStage === 'in' && (frame.sheetY ?? 0) > enterMotion.at(-1)!.sheetY! + 20)).toBe(true);
    const box = await phone.boundingBox(), schedulerBox = await win.locator('.agent-float-panel').boundingBox();
    expect(box!.width).toBeCloseTo(310, 0);
    expect(box!.x).toBeGreaterThanOrEqual(schedulerBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(schedulerBox!.x + schedulerBox!.width);
    expect(box!.x + box!.width / 2).toBeCloseTo(schedulerBox!.x + schedulerBox!.width / 2, 0);
    const appearance = await phone.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, shadow: getComputedStyle(node).boxShadow, border: getComputedStyle(node).borderWidth }));
    expect(appearance).toEqual({ background: 'rgba(0, 0, 0, 0)', shadow: 'none', border: '0px' });
    const hardware = phone.getByRole('navigation', { name: '手机导航' });
    await expect(hardware.getByRole('button')).toHaveCount(3);
    await expect(hardware.locator('svg,img')).toHaveCount(0);
    const device = await phone.locator('.ap-device').boundingBox();
    const keyPoints = [.187, .5, .813].map(x => ({ x: device!.x + device!.width * x, y: device!.y + device!.height * .921 }));
    expect(await win.evaluate(points => points.map(p => document.elementFromPoint(p.x, p.y)?.closest('button')?.getAttribute('aria-label')), keyPoints)).toEqual(['返回', '手机主页', '手机搜索']);
    const transparentKey = async () => {
      expect(await hardware.getByRole('button', { name: '手机搜索', exact: true }).evaluate(button => {
        const style = getComputedStyle(button);
        return { children: button.childElementCount, background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, border: style.borderWidth };
      })).toEqual({ children: 0, background: 'rgba(0, 0, 0, 0)', image: 'none', shadow: 'none', border: '0px' });
    };
    await transparentKey();
    await win.mouse.move(keyPoints[2].x, keyPoints[2].y); await transparentKey();
    await win.mouse.down(); await transparentKey(); await win.mouse.up();
    await expect(phone.getByRole('textbox', { name: '搜索应用内容' })).toBeVisible();
    await phone.screenshot({ path: path.join(captures, 'hardware-search.png') });
    await win.mouse.click(keyPoints[0].x, keyPoints[0].y);
    await expect(phone.getByRole('textbox', { name: '搜索应用内容' })).toHaveCount(0);
    await hardware.getByRole('button', { name: '手机搜索', exact: true }).focus(); await win.keyboard.press('Enter');
    await expect(phone.getByRole('textbox', { name: '搜索应用内容' })).toBeVisible();
    await win.mouse.click(keyPoints[0].x, keyPoints[0].y);
    await win.mouse.move(device!.x - 10, device!.y);
    await phone.screenshot({ path: path.join(captures, 'hardware-home.png') });
    await expect(win.locator('[data-agent-purpose="dispatch"]')).toHaveAttribute('aria-hidden', 'false');
    const dispatchInput = win.locator('[data-agent-purpose="dispatch"] [contenteditable="true"]').first();
    await dispatchInput.click({ position: { x: 8, y: 8 } }); await dispatchInput.fill('手机打开时仍可输入给 AI');
    await expect(dispatchInput).toBeFocused(); await expect(phone).toBeVisible();
    await dispatchInput.fill('');
    await startMotion(); await phone.getByRole('button', { name: '返回', exact: true }).click();
    await win.screenshot({ path: path.join(captures, 'sheet-exit.png') });
    const exitMotion = await finishMotion();
    expect(exitMotion.some(frame => frame.sheetStage === 'out' && (frame.sheetY ?? 0) > box!.y + 10)).toBe(true);
    await expect(phone).toHaveCount(0);
    await win.locator('.agent-phone-toggle').click();
    await expect(phone.getByRole('heading', { name: '我的应用' })).toBeVisible();
    await expect(phone.getByRole('button', { name: /继续跟随/ })).toHaveCount(0);
    const tool = async (args: Record<string, unknown>, approveAppName?: string): Promise<unknown> => {
      const turn: ToolTurn = { marker: randomUUID(), callId: `call_${randomUUID().replaceAll('-', '')}`, args };
      nextTool = turn;
      const context = `${appsToolName} ${String(args.action)}${args.commandId ? `/${String(args.commandId)}` : ''}`;
      const accepted = await win.evaluate(({ ws, marker }) => window.api.chat.send(`执行应用验收 ${marker}`, ws), { ws: ws!, marker: turn.marker });
      expect(accepted.accepted, accepted.error).toBe(true);
      if (approveAppName) {
        const approval = win.getByRole('dialog', { name: 'App 审批需要人工处理' });
        await expect.poll(async () => turn.error || turn.receipt !== undefined || await approval.isVisible(),
          { timeout: 25_000, message: `${context} awaiting approval or tool result` }).toBeTruthy();
        if (await approval.isVisible()) {
          await expect(approval).toContainText(approveAppName);
          await approval.getByRole('button', { name: '确认执行', exact: true }).click();
        }
      }
      await expect.poll(() => turn.error || turn.receipt !== undefined, { timeout: 25_000, message: `${context} waiting for ${turn.callId}` }).toBeTruthy();
      expect(turn.error, context).toBeUndefined();
      let receipt: { ok?: boolean; result?: unknown; error?: string };
      try { receipt = JSON.parse(turn.receipt ?? ''); }
      catch (error) { throw new Error(`${context} returned a non-JSON tool result: ${turn.receipt ?? '(missing)'}`, { cause: error }); }
      expect(receipt, `${context} returned ${turn.receipt}`).toMatchObject({ ok: true });
      await expect.poll(async () => (await win.evaluate(ws => window.api.chat.state(ws), ws!)).busy, { timeout: 10_000 }).toBe(false);
      nextTool = undefined;
      return receipt.result;
    };
    expect(await tool({ action: 'call', appId: CHANNEL_APP_ID, commandId: 'channels' })).toMatchObject({ channels: [] });
    const globalChannelId = await win.evaluate(async () => {
      const created = await window.api.messaging.call('channels', 'create', { name: '模型绑定验收' });
      if (!created.ok) throw Error('Could not create the global Channel fixture');
      return (created.value as { id: string }).id;
    });
    expect(await tool({ action: 'call', appId: CHANNEL_APP_ID, commandId: 'catalog' })).toMatchObject({ channelCatalog: [
      { id: globalChannelId, name: '模型绑定验收', sourceCount: 0, bound: false }
    ] });
    expect(await tool({ action: 'call', appId: CHANNEL_APP_ID, commandId: 'bind', params: { channelId: globalChannelId } })).toMatchObject({ status: 'bound' });
    expect(await tool({ action: 'call', appId: CHANNEL_APP_ID, commandId: 'channels' })).toMatchObject({ channels: [{ id: globalChannelId }] });
    expect(await tool({ action: 'call', appId: CHANNEL_APP_ID, commandId: 'unbind', params: { channelId: globalChannelId } })).toMatchObject({ status: 'unbound' });
    expect(await tool({ action: 'call', appId: CHANNEL_APP_ID, commandId: 'channels' })).toMatchObject({ channels: [] });
    await phone.getByRole('button', { name: '手机主页' }).click();
    await expect(phone.getByRole('button', { name: 'Channel', exact: true })).toBeVisible();
    const definition = defineRecordApp({ id: 'field-notebook', name: '观察笔记', fields: [{ id: 'title', label: '标题', type: 'text', required: true }], titleField: 'title' });
    definition.views[0] = { ...definition.views[0], kind: 'custom', html: `<ma-text variant="heading" text="现场观察"></ma-text><ma-text name="record-title" bind="recordTitle" text="等待记录"></ma-text><script>app.onPresent(async p=>{const r=await app.query(p.entityId?{id:p.entityId}:{});maUi.set('recordTitle',r.record?.values.title||r.records?.[0]?.values.title||'还没有记录')});</script>` };
    expect(await tool({ action: 'install', definition }, definition.name)).toMatchObject({ id: definition.id });
    const apps = await win.evaluate(ws => window.api.agentApps.snapshot(ws), ws!); expect(apps.apps.some(a => a.definition.id === definition.id)).toBe(true);
    expect(await tool({ action: 'call', appId: definition.id, commandId: 'create', params: { values: { title: '第一条持久记录' } }, requestId: 'create-note-1' }))
      .toMatchObject({ record: { values: { title: '第一条持久记录' } } });
    const count = async () => (await win.evaluate(({ ws, id }) => window.api.agentApps.query(ws, { appId: id }), { ws: ws!, id: definition.id })).total;
    expect(await count()).toBe(1);
    await expect(phone).toBeVisible();
    const settled = async () => expect(phone.locator('.ap-scene[data-active="true"]')).toHaveAttribute('data-flight', 'idle');
    await expect(phone.locator('.ap-operation')).toHaveCount(0);
    await expect(phone.getByRole('heading', { name: '观察笔记', exact: true })).toBeVisible();
    // The workbench tooltip host consumes native title attributes after hover.
    const customFrame = phone.locator('.ap-scene[data-active="true"] .ap-custom').frameLocator('iframe');
    await expect(customFrame.getByText('第一条持久记录', { exact: true })).toBeVisible({ timeout: 10_000 });
    await settled(); await phone.screenshot({ path: path.join(captures, 'custom-dark.png') });
    await win.evaluate(() => window.api.themes.activate('light'));
    await expect.poll(() => win.locator('html').getAttribute('data-theme')).toBe('light');
    await expect.poll(async () => customFrame.locator('body').evaluate(node => getComputedStyle(node).color)).toBe(await phone.locator('.ap-screen').evaluate(node => getComputedStyle(node).color));
    await phone.screenshot({ path: path.join(captures, 'custom-light.png') });
    expect(await customFrame.locator('body').evaluate(node => getComputedStyle(node).scrollbarWidth)).toBe('none');
    await customFrame.getByText('第一条持久记录', { exact: true }).click();
    await expect(phone.getByRole('button', { name: /继续跟随/ })).toHaveCount(0);
    await win.evaluate(() => window.api.themes.activate('dark'));
    await expect.poll(() => win.locator('html').getAttribute('data-theme')).toBe('dark');
    await phone.getByRole('button', { name: /编辑/, exact: false }).click();
    await phone.getByRole('textbox', { name: '标题', exact: true }).fill('人工编辑后的同一条记录');
    await phone.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await win.evaluate(({ ws, id }) => window.api.agentApps.query(ws, { appId: id }), { ws: ws!, id: definition.id })).records?.[0]?.values.title).toBe('人工编辑后的同一条记录');
    await tool({ action: 'call', appId: definition.id, commandId: 'list' }); expect(toolResults.at(-1)).toContain('人工编辑后的同一条记录');
    await expect(customFrame.getByText('人工编辑后的同一条记录', { exact: true })).toBeVisible();
    await tool({ action: 'call', appId: 'tasks', commandId: 'create', params: { values: { title: 'AI 切到待办并创建的实际记录' } }, requestId: 'visible-task' });
    await expect(phone.getByRole('heading', { name: 'AI 切到待办并创建的实际记录', exact: true })).toBeVisible();
    await settled(); await win.screenshot({ path: path.join(captures, 'tool-task-detail.png') });
    await phone.getByRole('button', { name: '手机主页' }).click();
    for (const [pass, theme] of ['dark', 'light', 'dark', 'light'].entries()) {
      if (pass > 1) {
        await phone.getByRole('button', { name: /待办/ }).click(); await settled();
        await phone.getByRole('button', { name: '手机主页' }).click(); await settled();
      }
      await win.evaluate(id => window.api.themes.activate(id), theme);
      await expect.poll(() => win.locator('html').getAttribute('data-theme')).toBe(theme);
      await settled();
      await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const icons = await phone.locator('.ap-scene[data-active="true"] .ap-tile > span').evaluateAll(nodes => nodes.slice(0, 4).map(node => {
        const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const png = await win.screenshot({ path: path.join(captures, `home-${theme}.png`) });
      const iconPixels = await app.evaluate(({ nativeImage }, { png, icons, viewport }) => {
        const bitmap = nativeImage.createFromBuffer(Buffer.from(png, 'base64')), bytes = bitmap.toBitmap(), size = bitmap.getSize();
        const scaleX = size.width / viewport.width, scaleY = size.height / viewport.height;
        return icons.map(rect => {
          let white = 0;
          for (let y = Math.ceil(rect.y * scaleY); y < (rect.y + rect.height) * scaleY; y++) for (let x = Math.ceil(rect.x * scaleX); x < (rect.x + rect.width) * scaleX; x++) {
            const i = (y * size.width + x) * 4;
            if (bytes[i] > 230 && bytes[i + 1] > 230 && bytes[i + 2] > 230) white++;
          }
          return white;
        });
      }, { png: png.toString('base64'), icons, viewport });
      expect(iconPixels.every(count => count > 20), `${theme} tile icons must actually paint: ${iconPixels}`).toBe(true);
    }
    for (const [index, name] of ['项目摘录', '会议纪要', '资源登记'].entries()) {
      const extra = defineRecordApp({ id: `scroll-fixture-${index + 1}`, name,
        fields: [{ id: 'title', label: '标题', type: 'text', required: true }], titleField: 'title' });
      expect(await tool({ action: 'install', definition: extra }, extra.name)).toMatchObject({ id: extra.id });
    }
    // Product minimum window width remains 1100; narrow the real scheduler panel.
    await win.keyboard.press('Escape');
    await expect(phone).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1100, 800); });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(1100);
    await win.locator('.agent-panel-resizer').hover();
    const panelBox = await win.locator('.agent-float-panel').boundingBox();
    const handle = await win.locator('.agent-panel-resizer').boundingBox();
    await win.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await win.mouse.down();
    await win.mouse.move(panelBox!.x + 330, handle!.y + handle!.height / 2 - 360, { steps: 10 }); await win.mouse.up();
    await expect.poll(async () => (await win.locator('.agent-float-panel').boundingBox())!.width).toBeLessThan(390);
    await win.locator('.agent-phone-toggle').click(); await settled();
    await expect.poll(async () => { const b = await phone.boundingBox(); const v = win.viewportSize(); return b ? b.x >= 0 && b.y >= 0 && (!v || b.x + b.width <= v.width + 1) : false; }).toBe(true);
    const centeredPhone = await phone.boundingBox(), resizedPanel = await win.locator('.agent-float-panel').boundingBox();
    expect(centeredPhone!.x + centeredPhone!.width / 2).toBeCloseTo(resizedPanel!.x + resizedPanel!.width / 2, 0);
    expect(centeredPhone!.y + centeredPhone!.height / 2).toBeCloseTo(resizedPanel!.y + resizedPanel!.height / 2, 0);
    const homeScroll = phone.locator('.ap-scene[data-active="true"] .ap-home');
    await expect.poll(() => homeScroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await homeScroll.hover(); await win.mouse.wheel(0, 220);
    await expect.poll(async () => homeScroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await homeScroll.evaluate(node => ({ width: getComputedStyle(node).scrollbarWidth, webkit: getComputedStyle(node, '::-webkit-scrollbar').display }))).toEqual({ width: 'none', webkit: 'none' });
    await win.mouse.wheel(0, -400);
    await expect.poll(async () => homeScroll.evaluate(node => node.scrollTop)).toBe(0);
    await win.screenshot({ path: path.join(captures, 'home-narrow-light.png') });
    await startMotion();
    await phone.getByRole('button', { name: /待办/ }).click();
    await win.waitForFunction(() => (window as any).__phoneMotion.frames.some((frame: any) => frame.outgoingTransform.startsWith('matrix3d(') && frame.outgoingOpacity > .1 && frame.outgoingOpacity < .95));
    await win.screenshot({ path: path.join(captures, 'tile-flip.png') });
    const motion = await finishMotion();
    const motionEnvironment = await win.evaluate(() => ({ mode: document.documentElement.dataset.uiMotion, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, duration: getComputedStyle(document.querySelector('.ap-flight')!).transitionDuration }));
    fs.writeFileSync(path.join(captures, 'animation.json'), JSON.stringify({ enterMotion, exitMotion, motion, motionEnvironment }, null, 2));
    expect(motion.some(frame => frame.outgoingTransform.startsWith('matrix3d(') && frame.outgoingOpacity > .1 && frame.outgoingOpacity < .95)).toBe(true);
    expect(motion.some(frame => frame.incomingTransform.startsWith('matrix3d(')), JSON.stringify(motionEnvironment)).toBe(true);
    expect(motion.filter(frame => frame.outgoingOpacity > 0).every(frame => frame.incomingBackground === 'rgba(0, 0, 0, 0)')).toBe(true);
    await settled();
    await phone.getByRole('button', { name: /新增/ }).click();
    await phone.getByRole('textbox', { name: '要做什么' }).fill('在手机中创建的待办');
    await phone.getByRole('button', { name: '保存', exact: true }).click();
    await expect(phone.getByText('在手机中创建的待办', { exact: true })).toBeVisible();
    await settled(); await win.screenshot({ path: path.join(captures, 'tasks-narrow-light.png') });
    await tool({ action: 'call', appId: 'reminders', commandId: 'set', params: { values: { title: '检查任务运行结果', dueAt: new Date(Date.now() + 3600000).toISOString(), repeatMinutes: 30, note: '取消会停止提醒并保留记录；删除会移除记录。' } } });
    await expect(phone.getByRole('heading', { name: '检查任务运行结果', exact: true })).toBeVisible();
    await settled();
    const reminderRows = async () => (await win.evaluate(ws => window.api.agentApps.query(ws, { appId: 'reminders' }), ws!)).records!;
    const reminderId = (await reminderRows())[0].id;
    for (const [label, icon] of [['编辑提醒', 'edit'], ['取消提醒', 'reminder-off'], ['删除', 'delete']]) {
      const button = phone.getByRole('button', { name: label, exact: true });
      await expect(button.locator(`[data-phone-icon="${icon}"] svg`)).toBeVisible();
    }
    const actionPositions = await phone.locator('.ap-scene[data-active="true"] .ap-command-bar button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().y));
    expect(Math.max(...actionPositions) - Math.min(...actionPositions)).toBeLessThan(1);
    for (const theme of ['dark', 'light']) {
      await win.evaluate(id => window.api.themes.activate(id), theme);
      await expect.poll(() => win.locator('html').getAttribute('data-theme')).toBe(theme);
      await phone.screenshot({ path: path.join(captures, `reminder-actions-${theme}.png`) });
    }
    await phone.getByRole('button', { name: '编辑提醒', exact: true }).click();
    await settled();
    const formCancel = phone.getByRole('button', { name: '取消', exact: true });
    await formCancel.scrollIntoViewIfNeeded();
    await expect(formCancel.locator('[data-phone-icon="close"] svg')).toBeVisible();
    await expect(phone.getByRole('button', { name: '保存', exact: true }).locator('[data-phone-icon="save"] svg')).toBeVisible();
    await phone.screenshot({ path: path.join(captures, 'reminder-form-actions.png') });
    await formCancel.click(); await settled();
    await phone.getByRole('button', { name: '取消提醒', exact: true }).click();
    await expect(phone.locator('.ap-scene[data-active="true"] .ap-meta').filter({ hasText: /状态\s*已停用/ })).toBeVisible();
    expect((await reminderRows())[0]).toMatchObject({ id: reminderId, values: { enabled: false } });
    await expect(phone.getByRole('button', { name: '取消提醒', exact: true })).toHaveCount(0);
    await phone.screenshot({ path: path.join(captures, 'reminder-cancelled.png') });
    await phone.getByRole('button', { name: '删除', exact: true }).click();
    await expect(phone.locator('.ap-scene[data-active="true"] .ap-empty')).toContainText('这里还没有内容');
    expect(await reminderRows()).toHaveLength(0);
    await tool({ action: 'call', appId: 'reminders', commandId: 'set', params: { values: { title: '由 AI 删除的提醒', dueAt: new Date(Date.now() + 3600000).toISOString() } } });
    await expect(phone.getByRole('heading', { name: '由 AI 删除的提醒', exact: true })).toBeVisible();
    const modelReminder = (await reminderRows())[0];
    await tool({ action: 'call', appId: 'reminders', commandId: 'remove', params: { id: modelReminder.id, expectedRevision: modelReminder.revision } });
    await expect(phone.locator('.ap-scene[data-active="true"] .ap-empty')).toContainText('这里还没有内容');
    await expect(phone.getByRole('alert')).toHaveCount(0);
    expect(await reminderRows()).toHaveLength(0);
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await phone.getByRole('button', { name: '手机主页' }).click(); await settled();
    const channelEntry = phone.getByRole('button', { name: 'Channel', exact: true });
    await expect(channelEntry).toBeVisible();
    await channelEntry.click(); await settled();
    await expect(phone.getByRole('heading', { name: 'Channel', exact: true })).toBeVisible();
    await expect(phone.getByText('此工作区尚未绑定 Channel。先从全局目录选择要使用的 Channel。', { exact: true })).toBeVisible();
    await expect(phone.getByRole('button', { name: '绑定 Channel', exact: true })).toBeVisible();
    expect(await phone.locator('.ap-scene[data-mp-stage="in"] .ap-flight').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).transform === 'none'))).toBe(true);
    expect(await count()).toBe(1); expect(errors).toEqual([]);
    fs.writeFileSync(path.join(captures, 'evidence.json'), JSON.stringify({ fixture, platform: process.platform, tools: toolResults, requests: requestCount, animationSamples: motion, screenshots: ['custom-dark.png', 'custom-light.png', 'home-dark.png', 'home-light.png', 'home-narrow-light.png', 'tasks-narrow-light.png'] }, null, 2));
  } finally {
    await app.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
