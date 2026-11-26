import { _electron, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TURN_REVIEW_EVENT } from '../../src/renderer/src/chatSurface/turnReviewNavigation';

test('Core uses official reasoning options for a real session and the dispatcher', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  const workspace = path.join(info.outputDir, 'workspace');
  const workspaceId = 'catalog-e2e';
  const sessionId = randomUUID();
  const home = path.join(info.outputDir, 'home');
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.muster', 'workspace.json'), JSON.stringify({
    hVirtualScreen: true, hDock: 'terminal'
  }));
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const deepseek = { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions',
    apiKey: 'fixture-key', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] };
  const openai = { id: 'openai-responses', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses',
    apiKey: 'fixture-key', models: [{ id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' }] };
  const tokenPlan = { id: 'qwen-token-plan-cn', name: 'Qwen Token Plan CN', api: 'openai-completions', apiKey: 'fixture-key',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', models: [
      { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', reasoning: false },
      { id: 'qwen4-max-preview', name: 'qwen4-max-preview', reasoning: false }
    ] };
  const siliconflow = { id: 'siliconflow', name: '硅基流动', api: 'openai-completions', apiKey: 'fixture-key',
    baseUrl: 'https://api.siliconflow.cn/v1', models: [{ id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' }] };
  const cache = path.join(userData, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'core-reasoning-v2.json'), JSON.stringify({ catalog: {
    schemaVersion: 2, revision: '2026-11-19.1',
    pi: { deepseek: [{ id: 'deepseek-v4-pro', api: 'openai-completions', baseUrl: deepseek.baseUrl, reasoning: true }] },
    models: [{ providerId: siliconflow.id, baseUrl: siliconflow.baseUrl, protocol: siliconflow.api, modelId: siliconflow.models[0].id,
      reasoning: { format: 'siliconflow', effort: [], canDisable: false, budget: { min: 128, max: 32768 } },
      sources: ['https://docs.siliconflow.cn/docs/api/chat-completions-post'] }]
  } }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', defaultCwd: workspace, activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, name: 'Core catalog fixture', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] },
    llm: { activeProviderId: tokenPlan.id, activeModelId: tokenPlan.models[0].id, providers: [deepseek, openai, tokenPlan, siliconflow] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: sessionId, name: 'Core catalog fixture', type: 'terminal', launchKind: 'agent', runtime: 'pi',
    workspaceId, cwd: workspace, createdAt: Date.now(), lifecycle: 'idle'
  }]));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: sessionId, MUSTER_WEB: '0' });
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[name];
  const bootstrap = path.join(info.outputDir, 'electron-entry.cjs');
  // Provisioning and SDK discovery must use the fixture home, including on macOS and Linux.
  fs.writeFileSync(bootstrap, `
    const { app } = require('electron');
    const home = ${JSON.stringify(home)};
    require('node:os').homedir = () => home;
    require('node:module').syncBuiltinESMExports();
    app.setPath('home', home);
    app.setPath('appData', home);
    app.setAppPath(${JSON.stringify(project)});
    require(${JSON.stringify(path.join(project, 'out/main/index.js'))});
  `);
  const app = await _electron.launch({
    executablePath: require('electron'), cwd: info.outputDir, env,
    // Assert the bundled options independently of future publications.
    args: [bootstrap, '--disable-gpu', '--no-proxy-server', '--host-resolver-rules=MAP muster-model-catalog.pages.dev ~NOTFOUND, MAP pi.dev ~NOTFOUND']
  });
  try {
    const win = await app.firstWindow();
    const ready = await win.evaluate(() => window.api.app.bootWait());
    expect(ready.ok, ready.ok ? '' : ready.error).toBe(true);
    await win.locator('.app-shell').waitFor();
    const deepseek1017 = { providerId: tokenPlan.id, modelId: tokenPlan.models[0].id };
    const initialDispatch = await win.evaluate(([ws, model]) => window.api.agentSession.readHarnessPickerCatalog({
      requestId: 'initial-dispatch', dispatch: { workspaceId: ws }, model
    }), [workspaceId, deepseek1017] as const);
    expect(initialDispatch.ok, initialDispatch.ok ? '' : initialDispatch.error).toBe(true);
    if (!initialDispatch.ok) throw new Error(initialDispatch.error);
    expect(initialDispatch.catalog.parameters?.[0]?.descriptor.options.map(option => option.value)).toEqual(['low', 'high', 'max']);
    await win.evaluate(id => window.api.sessions.select(id), sessionId);
    await win.setViewportSize({ width: 1260, height: 840 });
    const composer = win.locator('.agent-chat-view:visible .agent-composer');
    const trigger = composer.locator('.agent-composer-model-trigger');
    const menu = win.locator('.agent-composer-model-menu');
    const group = menu.getByRole('radiogroup', { name: '思考强度' });
    const virtualScreen = win.locator('.main-view');
    const hoverRight = async () => {
      // Session selection briefly suppresses hover. Retry from the current page.
      await expect(async () => {
        await win.mouse.move(750, 60);
        await win.mouse.move(1150, 60);
        await expect(virtualScreen).toHaveClass(/\bh-git\b/, { timeout: 650 });
      }).toPass({ timeout: 5000 });
    };
    const leftPeekPoint = { x: 210, y: 500 };

    const row = win.locator(`[data-session-row="${sessionId}"]`);
    const contextMenu = win.locator('.ctx-menu');
    const trackMenuTravel = () => contextMenu.evaluateHandle(menu => {
      const strip = menu.closest('.h-strip')!;
      const menuStart = menu.getBoundingClientRect().left;
      const stripStart = strip.getBoundingClientRect().left;
      const result = { distance: 0 };
      const sample = () => {
        if (!menu.isConnected) return;
        const menuDelta = menu.getBoundingClientRect().left - menuStart;
        const stripDelta = strip.getBoundingClientRect().left - stripStart;
        if (Number(getComputedStyle(menu).opacity) > 0.15 && Math.abs(menuDelta - stripDelta) < 8) {
          result.distance = Math.max(result.distance, Math.abs(stripDelta));
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return result;
    });
    await row.click({ button: 'right' });
    await expect(contextMenu).toBeVisible();
    await expect(win.locator('.h-strip > .ctx-menu')).toHaveCSS('position', 'absolute');
    const leftMenuTravel = await trackMenuTravel();
    await hoverRight();
    await expect(contextMenu).toHaveCount(0);
    expect(await leftMenuTravel.evaluate(result => result.distance)).toBeGreaterThan(20);
    await win.screenshot({ path: info.outputPath('virtual-screen-right-menu-dismissed.png'), animations: 'disabled' });

    await win.evaluate(({ event, id }) => window.dispatchEvent(new CustomEvent(event, {
      detail: { target: { kind: 'gui', id, messageId: 'fixture-review' } }
    })), { event: TURN_REVIEW_EVENT, id: sessionId });
    const review = win.locator('.git-page .turn-review-panel');
    await expect(review).toBeVisible();
    const reviewLeft = (await review.boundingBox())!.x;
    await win.getByRole('button', { name: '标签页管理' }).click();
    await expect(contextMenu).toBeVisible();
    const rightMenuTravel = await trackMenuTravel();
    await expect(async () => {
      await win.mouse.click(leftPeekPoint.x, leftPeekPoint.y);
      await expect(virtualScreen).toHaveClass(/\bh-terminal\b/, { timeout: 650 });
    }).toPass({ timeout: 5000 });
    await expect(contextMenu).toHaveCount(0);
    expect(await rightMenuTravel.evaluate(result => result.distance)).toBeGreaterThan(20);
    await expect.poll(async () => (await review.boundingBox())?.x).toBeGreaterThan(reviewLeft + 200);
    await win.screenshot({ path: info.outputPath('virtual-screen-left-menu-dismissed.png'), animations: 'disabled' });

    await expect(trigger).toContainText('DeepSeek V4.1 Flash 1017');
    await trigger.click();
    await expect(group.getByRole('radio')).toHaveText(['跟随默认', 'low', 'high', 'max']);
    await expect(win.locator('.h-strip > .agent-composer-model-menu')).toBeVisible();
    await expect(menu).toHaveCSS('position', 'absolute');
    await win.screenshot({ path: info.outputPath('virtual-screen-model-open.png') });
    // Move the cursor without pressing a button, so outside-click cannot dismiss the popup.
    await hoverRight();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);
    await win.screenshot({ path: info.outputPath('virtual-screen-model-dismissed.png'), animations: 'disabled' });
    expect(await win.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('[data-h-peek]')?.getAttribute('data-h-page'), leftPeekPoint)).toBe('terminal');
    await win.mouse.click(leftPeekPoint.x, leftPeekPoint.y);
    await expect(virtualScreen).toHaveClass(/\bh-terminal\b/);
    await expect(menu).toHaveCount(0);
    await trigger.click();
    await expect(group.getByRole('radio')).toHaveText(['跟随默认', 'low', 'high', 'max']);
    await menu.screenshot({ path: info.outputPath('token-plan-1017.png'), animations: 'disabled' });
    await menu.getByRole('option', { name: 'qwen4-max-preview' }).click();
    await expect(group.getByRole('radio')).toHaveText(['跟随默认', '关闭', 'low', 'medium', 'xhigh']);
    await expect(menu.getByText('思考强度 · xhigh')).toBeVisible();
    await group.getByRole('radio', { name: 'medium' }).click();
    await expect(group.getByRole('radio', { name: 'medium' })).toBeChecked();
    for (const [theme, width] of [['dark', 1260], ['light', 780]] as const) {
      await win.setViewportSize({ width, height: 840 });
      await win.evaluate(id => window.api.themes.activate(id), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(group.getByRole('radio', { name: 'medium' })).toBeVisible();
      await menu.screenshot({ path: info.outputPath(`token-plan-reasoning-${theme}-${width}.png`), animations: 'disabled' });
    }
    await menu.getByRole('button', { name: '确认配置' }).click();
    await expect(menu).toBeHidden();
    const snapshot = () => win.evaluate(id => window.api.agentSession.getModelParameters(id), sessionId);
    expect((await snapshot())?.values.reasoning).toBe('medium');
    await trigger.click();
    await menu.getByRole('option', { name: 'DeepSeek V4 Pro' }).click();
    await expect(group.getByRole('radio')).toHaveText(['跟随默认', '关闭', 'low', 'high', 'max']);
    await expect(group.getByRole('radio', { name: '跟随默认' })).toBeChecked();
    await expect(menu.getByText('思考强度 · high')).toBeVisible();
    await menu.getByRole('option', { name: 'GPT-5.5 Pro' }).click();
    await expect(group.getByRole('radio')).toHaveText(['跟随默认', 'medium', 'high', 'xhigh']);
    await group.getByRole('radio', { name: 'xhigh' }).click();
    await expect(group.getByRole('radio', { name: 'xhigh' })).toBeChecked();
    await menu.getByRole('button', { name: '确认配置' }).click();
    await expect(menu).toBeHidden();
    expect((await snapshot())?.values.reasoning).toBe('xhigh');
    await trigger.click();
    await group.getByRole('radio', { name: '跟随默认' }).click();
    await menu.getByRole('button', { name: '确认配置' }).click();
    await expect(menu).toBeHidden();
    const restored = await snapshot();
    expect(restored?.values.reasoning).toBeUndefined();
    expect(restored?.controls[0]?.effectiveValue).toBe('high');

    await trigger.click();
    await menu.getByRole('option', { name: 'DeepSeek R1', exact: true }).click();
    await expect(group.getByRole('radio')).toHaveText(['跟随默认', '128 tokens', '16,448 tokens', '32,768 tokens']);
    await group.getByRole('radio', { name: '32,768 tokens' }).click();
    for (const [theme, width] of [['dark', 1260], ['light', 780]] as const) {
      await win.setViewportSize({ width, height: 840 });
      await win.evaluate(id => window.api.themes.activate(id), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(group.getByRole('radio', { name: '32,768 tokens' })).toBeChecked();
      await menu.screenshot({ path: info.outputPath(`siliconflow-budget-${theme}-${width}.png`), animations: 'disabled' });
    }
    await menu.getByRole('button', { name: '确认配置' }).click();
    await expect(menu).toBeHidden();
    expect((await snapshot())?.values.reasoning).toBe('budget-32768');

    const dispatch = await win.evaluate(ws => window.api.agentSession.readHarnessPickerCatalog({
      requestId: 'dispatch-catalog', dispatch: { workspaceId: ws },
      model: { providerId: 'openai-responses', modelId: 'gpt-5.5-pro' }
    }), workspaceId);
    expect(dispatch.ok, dispatch.ok ? '' : dispatch.error).toBe(true);
    if (!dispatch.ok) throw new Error(dispatch.error);
    expect(dispatch.catalog.parameters?.[0]?.descriptor.options.map(option => option.value)).toEqual(['medium', 'high', 'xhigh']);
    const saved = await win.evaluate(([ws, expected]) => window.api.chat.switchModel(
      { providerId: 'openai-responses', modelId: 'gpt-5.5-pro' }, ws, { expected, parameters: { reasoning: 'xhigh' } }
    ), [workspaceId, dispatch.catalog.commitStamp!] as const);
    expect(saved.ok, saved.error).toBe(true);
    expect((await win.evaluate(ws => window.api.chat.context(ws), workspaceId)).thinking.level).toBe('xhigh');
  } finally {
    await app.close();
  }
});
