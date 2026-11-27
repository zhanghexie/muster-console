/**
 * 真 Electron 首装链路：本机检测 → 真实模型设置 → 工作区/会话 → 工作台导览 → 回复与恢复。
 *
 * 隔离方式：不能用 dev sandbox（setupDevSandbox 会无条件注入 3 个 demo 工作区），
 * 因此走 MUSTER_NO_SANDBOX=1，通过测试入口先设置 Electron appData 和 documents，
 * 并将 HOME / USERPROFILE 指向临时目录，覆盖三个平台的产品数据及推荐工作区路径。
 * 任何交互前用 app.evaluate 校验真实路径，避免误碰开发者本机数据。
 *
 * 运行：npm run build && npx playwright test test/e2e/zero-workspace-onboarding.spec.ts
 */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const project = path.resolve(__dirname, '../..');

test('真实设置连接模型、实际入口建区建会话、导览完成并收发，删空后恢复', async ({}, info) => {
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(project, '.tmp', 'zero-ws-e2e-'));
  const appData = path.join(tmpRoot, 'AppData', 'Roaming');
  const localAppData = path.join(tmpRoot, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  // ExtensionExportService 构造时读 app.getPath('documents')；USERPROFILE 被重定向后
  // 必须把 Documents 一起建出来，否则启动链会在扩展系统装配处抛错、IPC 注册不全。
  const documents = path.join(tmpRoot, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  const entry = path.join(tmpRoot, 'first-run.cjs');
  fs.writeFileSync(entry, `
    const { app } = require('electron');
    app.setPath('appData', ${JSON.stringify(appData)});
    app.setPath('documents', ${JSON.stringify(documents)});
    app.setAppPath(${JSON.stringify(project)});
    require(${JSON.stringify(path.join(project, 'out', 'main', 'index.js'))});
  `);

  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')
  );
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_SANDBOX', 'MUSTER_DEV',
    'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_DEV_MOBILE_WS', 'MUSTER_NO_SANDBOX'
  ]) delete env[key];
  env.MUSTER_NO_SANDBOX = '1';
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.USERPROFILE = tmpRoot;
  env.HOME = tmpRoot;
  env.XDG_CONFIG_HOME = appData;
  env.XDG_DATA_HOME = localAppData;
  env.XDG_STATE_HOME = localAppData;
  env.CODEX_HOME = path.join(tmpRoot, '.codex');
  env.CLAUDE_CONFIG_DIR = path.join(tmpRoot, '.claude');
  env.PI_CODING_AGENT_DIR = path.join(tmpRoot, '.pi', 'agent');
  env.MUSTER_WEB = '1';
  env.MUSTER_WEB_HOST = '127.0.0.1';
  env.MUSTER_INSTANCE_ID = path.basename(tmpRoot);

  const launch = () => _electron.launch({
    executablePath: require('electron'),
    // 该 CI/沙箱环境的 Windows GPU 子进程会 0xC0000005 崩溃并触发 FATAL，
    // 必须把 GPU 完全关掉，否则窗口一创建整个 Electron 就退出。
    args: [
      entry,
      '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox',
      '--disable-gpu-compositing', '--disable-software-rasterizer',
      '--disable-dev-shm-usage', '--use-gl=disabled'
    ],
    cwd: tmpRoot,
    env
  });

  const requests: Array<{ path?: string; keyAccepted: boolean; stream: boolean; model?: string }> = [];
  const reply = '收到，这是第一条测试回复。';
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        object: 'list', data: [{ id: 'onboarding-model', object: 'model' }]
      }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const keyAccepted = req.headers.authorization === 'Bearer onboarding-fixture-key';
    requests.push({ path: req.url, keyAccepted, stream: body.stream === true, model: body.model });
    if (!keyAccepted) { res.writeHead(401).end('Invalid key onboarding-fixture-invalid'); return; }
    if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (delta: { content?: string }, finish_reason: string | null): string => `data: ${JSON.stringify({
      id: 'onboarding-probe', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta, finish_reason }]
    })}\n\n`;
    res.end(event({ content: reply }, null) + event({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    // 安全闸：所有落盘路径必须在临时目录内，否则立刻停止，不执行任何写操作。
    const paths = await app.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      appData: electronApp.getPath('appData')
    }));
    expect(path.resolve(paths.userData).startsWith(path.resolve(tmpRoot))).toBe(true);
    expect(path.resolve(paths.appData).startsWith(path.resolve(tmpRoot))).toBe(true);

    let win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    // React 树提交早于主进程启动链收口：等 IPC 通道真正可用再取快照，
    // 若始终等不到说明启动链被中断，正好把问题暴露出来而不是误报成功能失败。
    await expect.poll(async () => {
      try { await win.evaluate(() => window.api.workspaces.list()); return true; }
      catch { return false; }
    }, { timeout: 45_000, intervals: [200, 500, 1000] }).toBe(true);

    const initial = await win.evaluate(() => window.api.workspaces.list());
    const config = await win.evaluate(() => window.api.config.get());
    expect(initial.workspaces).toHaveLength(0);
    expect(initial.activeWorkspaceId).toBe('');
    expect(config.workspaces).toHaveLength(0);
    expect(config.openai).toMatchObject({ baseUrl: '', apiKey: '', model: '' });
    expect(config.llm).toMatchObject({ providers: [], activeProviderId: '', activeModelId: '' });
    const navigation = await win.evaluate(() => window.api.workbench.navigation());
    expect(navigation).toMatchObject({ workspaceId: '', nodes: [] });
    await expect(win.locator('.ext-nav-error')).toHaveCount(0);
    expect(initial.recommendedName).toBe('muster 默认工作区');
    expect(path.resolve(initial.recommendedRoot).startsWith(path.resolve(tmpRoot))).toBe(true);
    expect(fs.existsSync(initial.recommendedRoot)).toBe(false);

    expect(config.locale).toBe('system');
    await win.evaluate(() => window.api.config.update({ locale: 'zh-CN' }));
    await expect(win.getByRole('heading', { name: '检测本机 AI 工具' })).toBeVisible();
    await expect(win.locator('.app-shell .chrome-bar')).toBeVisible();
    const initialDialog = await win.locator('.setup-dialog').evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect();
      return { backdrop: getComputedStyle(dialog, '::backdrop').backdropFilter,
        horizontalOffset: Math.abs(bounds.left + bounds.width / 2 - innerWidth / 2),
        verticalOffset: Math.abs(bounds.top + bounds.height / 2 - innerHeight / 2) };
    });
    expect(initialDialog.backdrop).toMatch(/blur\(/);
    expect(initialDialog.horizontalOffset).toBeLessThan(8);
    expect(initialDialog.verticalOffset).toBeLessThan(8);
    await expect(win.locator('.create-ws-modal')).toHaveCount(0);
    const shot = async (name: string): Promise<void> => { await win.screenshot({ path: info.outputPath(name), animations: 'disabled' }); };
    const checkGuideCard = async (): Promise<void> => {
      const surfaces = await win.locator('.setup-layout').evaluate(card => {
        const style = getComputedStyle(card);
        return { background: getComputedStyle(card.parentElement!).backgroundColor, card: style.backgroundColor,
          border: style.borderTopStyle };
      });
      expect(surfaces.card).not.toBe('rgba(0, 0, 0, 0)');
      expect(surfaces.card).not.toBe(surfaces.background);
      expect(surfaces.border).toBe('solid');
    };
    await checkGuideCard();
    await shot('01-本机检测-深色.png');
    await win.getByRole('button', { name: '检测本机工具', exact: true }).click();
    await expect(win.getByRole('button', { name: '重新检测' })).toBeVisible({ timeout: 45_000 });
    await shot('02-本机检测结果-深色.png');
    await win.getByRole('button', { name: '继续', exact: true }).click();
    await win.getByRole('button', { name: '去模型设置', exact: true }).click();
    let settings = win.getByRole('dialog', { name: '设置' });
    await expect(settings).toBeVisible();
    const providerSection = settings.locator('[data-settings-item="agent-provider"]');
    await expect(providerSection.locator('.llm-provider-choice')).toHaveCount(0);
    await expect(providerSection.locator('.llm-provider[data-provider-id]')).toHaveCount(0);
    await expect(providerSection).toHaveClass(/\bis-settings-flash\b/);
    const locatorStyle = await providerSection.evaluate(section => {
      const heading = section.querySelector('.s-sec-h h2')!;
      const marker = getComputedStyle(heading, '::before');
      return { background: getComputedStyle(section).backgroundColor, markerWidth: marker.inlineSize, markerColor: marker.backgroundColor };
    });
    expect(locatorStyle.background).toBe('rgba(0, 0, 0, 0)');
    expect(locatorStyle.markerWidth).toBe('2px');
    expect(locatorStyle.markerColor).not.toBe('rgba(0, 0, 0, 0)');
    await shot('02a-模型设置标题定位.png');
    const initialWindow = await app.browserWindow(win);
    const full = await initialWindow.evaluate(window => ({ size: window.getContentSize(), min: window.getMinimumSize() }));
    await initialWindow.evaluate(window => { window.setMinimumSize(460, 480); window.setContentSize(688, 680); });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBeLessThanOrEqual(688);
    await settings.getByRole('button', { name: '＋ 添加供应商', exact: true }).click();
    // DeepSeek remains available as a preset; first launch must not configure it for the user.
    await expect(settings.locator('.llm-add-menu-item').filter({ has: win.getByText('DeepSeek', { exact: true }) })).toBeEnabled();
    await settings.getByRole('button', { name: '添加自定义供应商', exact: true }).click();
    const provider = settings.locator('.llm-provider[data-provider-id="custom"]');
    await expect(provider.locator('.llm-badge-default-active')).toHaveText('默认服务商');
    const manualAdd = provider.getByRole('button', { name: '＋ 添加模型', exact: true });
    const keyInput = provider.locator('[data-settings-item="agent-api-key"] input');
    const modelGuide = win.locator('[data-setup-coachmark]');
    await expect(modelGuide).toContainText('2 / 4');
    await expect(keyInput).toHaveAttribute('aria-describedby', /.+/);
    await expect(keyInput).toBeInViewport({ ratio: 1 });
    await shot('02a-填写连接配置.png');
    await expect(manualAdd).not.toHaveAttribute('aria-describedby', /.+/);
    await provider.getByLabel('Base URL', { exact: true }).fill(baseUrl);
    await keyInput.fill('onboarding-fixture-key');
    await expect(modelGuide).toContainText('2 / 4');
    await expect(keyInput).toHaveAttribute('aria-describedby', /.+/);
    await modelGuide.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(modelGuide).toContainText('3 / 4');
    await expect(keyInput).not.toHaveAttribute('aria-describedby', /.+/);
    await expect(manualAdd).toHaveAttribute('aria-describedby', /.+/);
    await expect(manualAdd).toBeInViewport({ ratio: 1 });
    await provider.getByRole('button', { name: '刷新目录', exact: true }).click();
    const catalogAdd = provider.getByRole('button', { name: '从目录添加（1）', exact: true });
    await expect(catalogAdd).toHaveAttribute('aria-describedby', /.+/);
    await expect(catalogAdd).toBeInViewport({ ratio: 1 });
    await expect(manualAdd).not.toHaveAttribute('aria-describedby', /.+/);
    await shot('02b-模型引导优先目录.png');
    await catalogAdd.click();
    const catalogPicker = settings.getByRole('dialog', { name: '从目录添加', exact: true });
    await expect(catalogPicker).toBeInViewport({ ratio: 1 });
    await expect(catalogPicker.getByRole('button', { name: 'onboarding-model' })).toBeVisible();
    await expect(catalogPicker.getByRole('searchbox', { name: '搜索模型' })).toBeFocused();
    await shot('02c-模型目录浮层.png');
    await catalogPicker.getByRole('button', { name: 'onboarding-model' }).click();
    await expect(catalogPicker).toBeHidden();
    const modelRow = provider.locator('.llm-model-row-item').filter({ hasText: 'onboarding-model' });
    await expect(modelRow).toHaveClass(/\bis-active\b/);
    const modelDialog = settings.locator('.llm-model-dialog');
    await keyInput.fill('onboarding-fixture-invalid');
    await provider.getByRole('button', { name: '测试连通性', exact: true }).click();
    const failureTip = win.locator('.app-tip.is-error').filter({ hasText: 'HTTP 401' });
    await expect(failureTip).toBeVisible();
    await expect(failureTip).not.toContainText('onboarding-fixture-invalid');
    expect(requests).toEqual([{ path: '/v1/chat/completions', keyAccepted: false, stream: false, model: 'onboarding-model' }]);
    await keyInput.fill('onboarding-fixture-key');
    await provider.getByRole('button', { name: '测试连通性', exact: true }).click();
    await expect(provider.getByRole('status').filter({ hasText: '连通测试成功' })).toBeVisible();
    await expect(failureTip).toBeHidden();
    await manualAdd.click();
    await modelDialog.locator('.llm-dialog-field input').first().fill('onboarding-secondary');
    await modelDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(modelDialog).toBeHidden();
    await expect(modelRow).toHaveClass(/\bis-active\b/);
    // A successful draft connection test does not replace a saved API Key.
    await keyInput.fill('');
    await settings.locator('.settings-savebar').getByRole('button', { name: /^保存/ }).click();
    await expect.poll(() => win.evaluate(async () => (await window.api.config.get()).llm?.activeModelId)).toBe('onboarding-model');
    const connected = await win.evaluate(() => window.api.config.get());
    expect(connected.llm?.providers.map(item => item.id)).toEqual(['custom']);
    expect(connected.llm?.activeProviderId).toBe('custom');
    expect(connected.llm?.providers[0].apiKey).toBe('');
    await settings.getByRole('button', { name: /^返回引导/ }).click();
    await expect(settings).toBeHidden();
    const missingKeyNotice = win.getByRole('alert').filter({ hasText: '默认供应商还没填写 API Key。请填写并保存后继续。' });
    await expect(missingKeyNotice).toHaveText('默认供应商还没填写 API Key。请填写并保存后继续。');
    await expect(win.getByRole('heading', { name: '在工作台创建工作区' })).toHaveCount(0);
    await win.getByRole('button', { name: '去模型设置', exact: true }).click();
    await expect(settings).toBeVisible();
    const keyRow = provider.locator('[data-settings-item="agent-api-key"]');
    await expect(keyRow).toHaveClass(/\bis-settings-flash\b/);
    await expect(keyInput).toBeInViewport({ ratio: 1 });
    await expect(keyInput).toHaveValue('');
    await keyInput.fill('onboarding-fixture-key');
    await settings.locator('.settings-savebar').getByRole('button', { name: /^保存/ }).click();
    await expect.poll(() => win.evaluate(async () => (await window.api.config.get()).llm?.providers[0].apiKey)).toBe('onboarding-fixture-key');
    await settings.getByRole('button', { name: /^返回引导/ }).click();
    await expect(settings).toBeHidden();
    await expect(win.getByRole('heading', { name: '在工作台创建工作区' })).toBeVisible();
    await expect(missingKeyNotice).toHaveCount(0);
    await shot('03-真实设置返回工作台引导.png');

    expect(await win.evaluate(() => window.api.themes.activate('light'))).toMatchObject({ ok: true });
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    const coachmark = win.locator('[data-setup-coachmark]');
    const spotlight = win.locator('[data-setup-spotlight]');
    await expect(coachmark).toBeVisible();
    await expect(spotlight).toBeVisible();
    const workspaceAdd = win.locator('button[data-setup-target="workspace"]');
    await win.mouse.move(400, 80);
    await expect(workspaceAdd).toBeInViewport({ ratio: 1 });
    await expect(workspaceAdd).toHaveCSS('opacity', '1');
    await expect(workspaceAdd).toHaveText('+');
    // Use physical pointer coordinates: blocked controls must not wait for actionability.
    const blockedBoard = win.locator('button[data-setup-target="global-board"]:visible');
    const blockedBounds = await blockedBoard.boundingBox();
    expect(blockedBounds).not.toBeNull();
    await win.mouse.click(blockedBounds!.x + blockedBounds!.width / 2, blockedBounds!.y + blockedBounds!.height / 2);
    await win.keyboard.press('Control+Shift+G');
    await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(settings).toBeHidden();
    await expect(win.getByRole('dialog', { name: '全局看板', exact: true })).toHaveCount(0);
    await expect(coachmark.getByRole('heading', { name: '在工作台创建工作区', exact: true })).toBeVisible();
    await expect(spotlight).toBeVisible();
    await shot('05-工作台高亮建区入口.png');
    await workspaceAdd.click();
    const workspaceDialog = win.getByRole('dialog', { name: '新建工作区' });
    await expect(workspaceDialog).toBeVisible();
    await expect(workspaceDialog.locator('.create-ws-path-row input')).toHaveValue(initial.recommendedRoot);
    await expect(workspaceDialog.getByRole('button', { name: '一键填入' })).toHaveCount(0);
    expect(fs.existsSync(initial.recommendedRoot)).toBe(false);
    await shot('05b-工作台新建工作区.png');
    await workspaceDialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(win.getByRole('heading', { name: '打开第一条会话' })).toBeVisible();
    expect(fs.statSync(initial.recommendedRoot).isDirectory()).toBe(true);
    const created = await win.evaluate(() => window.api.config.get());
    expect(created.workspaces).toHaveLength(1);
    expect(created.workspaces[0].name).toBe('我的工作区');
    expect(created.llm?.activeModelId).toBe('onboarding-model');
    expect(created.llm?.providers.find(item => item.id === 'custom')?.models.map(item => item.id))
      .toEqual(['onboarding-model', 'onboarding-secondary']);
    // No work session exists yet: the real board must show its complete empty artwork and copy.
    await win.locator('[data-setup-coachmark]').getByRole('button', { name: '稍后继续', exact: true }).click();
    await expect(win.getByRole('button', { name: '继续新手引导', exact: true })).toBeVisible();
    const boardToggle = win.locator('button[data-setup-target="global-board"]:visible');
    await boardToggle.click();
    const emptyBoard = win.getByRole('dialog', { name: '全局看板', exact: true });
    await expect(emptyBoard).toBeVisible();
    await expect(emptyBoard.getByText('所有工作区都还没有工作会话', { exact: true })).toBeVisible();
    const emptyArtwork = emptyBoard.locator('.board-empty');
    const artwork = await emptyArtwork.evaluate(empty => {
      const bounds = empty.getBoundingClientRect();
      const logo = empty.querySelector('svg')!.getBoundingClientRect();
      const content = [...empty.querySelectorAll('svg, p')].map(element => element.getBoundingClientRect());
      return { width: logo.width, height: logo.height, contained: content.every(rect =>
        rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 &&
        rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1) };
    });
    expect(artwork.width).toBeGreaterThanOrEqual(55);
    expect(artwork.height).toBeGreaterThanOrEqual(55);
    expect(artwork.contained).toBe(true);
    await shot('06a-窄窗空看板完整标志.png');
    await boardToggle.click();
    await expect(emptyBoard).toBeHidden();
    await win.getByRole('button', { name: '继续新手引导', exact: true }).click();
    await expect(win.getByRole('heading', { name: '打开第一条会话' })).toBeVisible();
    const leftDrawerToggle = () => win.locator('button[data-setup-target="left-sidebar"]:visible');
    await expect(leftDrawerToggle()).toBeInViewport({ ratio: 1 });
    await shot('06-窄窗先打开左栏.png');
    await win.getByRole('button', { name: '稍后继续', exact: true }).click();
    await expect(win.locator('[data-setup-coachmark]')).toHaveCount(0);
    await win.getByRole('button', { name: '继续新手引导', exact: true }).click();
    await expect(win.getByRole('heading', { name: '打开第一条会话' })).toBeVisible();
    await win.evaluate(() => { void window.api.app.quit(); }).catch(() => {});
    await app.close();
    app = await launch();
    win = await app.firstWindow();
    await expect(win.locator('[data-setup-coachmark]')).toBeVisible({ timeout: 60_000 });
    settings = win.getByRole('dialog', { name: '设置' });
    const resumedWindow = await app.browserWindow(win);
    await resumedWindow.evaluate(window => { window.setMinimumSize(460, 480); window.setContentSize(688, 680); });
    await expect(win.locator('html')).toHaveClass(/\bis-narrow\b/);
    await leftDrawerToggle().click();
    const resumedSessionEntry = win.locator('button[data-setup-target="session"]:visible');
    await expect(resumedSessionEntry).toBeInViewport({ ratio: 1 });
    await shot('06b-重启续办会话.png');
    await resumedSessionEntry.click();
    const taskDialog = win.getByRole('dialog', { name: '新建任务' });
    const createSession = taskDialog.getByRole('button', { name: '新建空白', exact: true });
    await expect(createSession).toBeEnabled();
    await createSession.click();
    await expect(taskDialog).toBeHidden();
    const tourCoachmark = win.locator('[data-setup-coachmark]');
    const tour = [
      ['left-sidebar', '开合左侧栏'], ['right-sidebar', '开合右侧栏'],
      ['virtual-screen', '切换虚拟屏'], ['global-board', '使用全局看板'], ['theme', '设置主题']
    ] as const;
    for (const [target, heading] of tour) {
      await expect(tourCoachmark.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      // 上一步沿真实状态机回退，再前进；不能依赖完成会话后自动结束引导。
      if (target === 'right-sidebar') {
        await tourCoachmark.getByRole('button', { name: '上一步', exact: true }).click();
        await expect(tourCoachmark.getByRole('heading', { name: '开合左侧栏', exact: true })).toBeVisible();
        await tourCoachmark.getByRole('button', { name: '下一步', exact: true }).click();
        await expect(tourCoachmark.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      }
      const targetButton = win.locator(`[data-setup-target="${target}"]:visible`).first();
      if (target === 'virtual-screen') {
        await expect(tourCoachmark.getByText('宽窗口中可以体验虚拟屏。', { exact: true })).toBeVisible();
        await resumedWindow.evaluate(window => window.setContentSize(1250, 760));
        await expect.poll(() => win.evaluate(() => innerWidth)).toBe(1250);
        const rightToggle = win.locator('button[data-setup-target="right-sidebar"]:visible');
        await expect(rightToggle).toHaveCount(1);
        if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') await rightToggle.click();
        const peek = win.locator('[data-h-page][data-h-peek]');
        await expect(peek).toHaveCount(1);
        await expect.poll(() => win.locator('.h-strip').evaluate(strip =>
          strip.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
        const previousPeek = await peek.getAttribute('data-h-page');
        const point = await peek.evaluate(element => {
          const page = element.getBoundingClientRect();
          const work = document.querySelector('.work-area')!.getBoundingClientRect();
          const coach = document.querySelector('.setup-coachmark-card')!.getBoundingClientRect();
          const left = Math.max(0, page.left, work.left);
          const right = Math.min(innerWidth, page.right, work.right);
          const x = (left + right) / 2;
          const top = Math.max(0, page.top, work.top);
          const bottom = Math.min(innerHeight, page.bottom, work.bottom);
          const y = [bottom - 36, top + 72, (top + bottom) / 2].find(candidate =>
            candidate > top && candidate < bottom &&
            !(x >= coach.left && x <= coach.right && candidate >= coach.top && candidate <= coach.bottom));
          if (right <= left || y === undefined) throw new Error('No exposed virtual-screen point outside coachmark');
          return { x, y };
        });
        await win.mouse.click(point.x, point.y);
        await expect(peek).toHaveAttribute('data-h-page', previousPeek === 'git' ? 'terminal' : 'git');
        await shot('tour-virtual-screen-wide-switched.png');
        await resumedWindow.evaluate(window => window.setContentSize(688, 680));
        await expect.poll(() => win.evaluate(() => innerWidth)).toBe(688);
        await expect(tourCoachmark.getByText('宽窗口中可以体验虚拟屏。', { exact: true })).toBeVisible();
      } else {
        await expect(targetButton).toBeInViewport();
        await expect(win.locator('[data-setup-spotlight]')).toBeVisible();
      }
      await shot(`tour-${target}.png`);
      if (target === 'left-sidebar' || target === 'right-sidebar') {
        const before = await targetButton.getAttribute('aria-pressed');
        await targetButton.click();
        if (before !== null) await expect(targetButton).not.toHaveAttribute('aria-pressed', before);
        await targetButton.click();
      }
      if (target === 'theme') {
        await targetButton.click();
        await expect(settings.getByRole('button', { name: '外观', exact: true })).toHaveAttribute('aria-current', 'page');
        await expect(tourCoachmark.getByRole('heading', { name: '选择喜欢的主题' })).toBeVisible();
        await settings.locator('.theme-grid [data-theme-id="dark"]').click();
        await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
        await shot('tour-theme-settings.png');
        await settings.getByRole('button', { name: /^返回引导/ }).click();
        await expect(tourCoachmark.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      }
      if (target === 'global-board') {
        await targetButton.click();
        const board = win.getByRole('dialog', { name: '全局看板', exact: true });
        await expect(board).toBeVisible();
        const views = board.locator('[data-setup-target="global-board-views"]');
        await expect(views).toBeInViewport({ ratio: 1 });
        await expect(tourCoachmark).toBeVisible();
        const statusView = views.getByRole('tab', { name: '状态', exact: true });
        const freeView = views.getByRole('tab', { name: '自由', exact: true });
        await freeView.click();
        await expect(freeView).toHaveAttribute('aria-selected', 'true');
        await expect(statusView).toHaveAttribute('aria-selected', 'false');
        await shot('tour-global-board-free.png');
        await statusView.click();
        await expect(statusView).toHaveAttribute('aria-selected', 'true');
        await shot('tour-global-board-status.png');
      }
      await tourCoachmark.getByRole('button', { name: '下一步', exact: true }).click();
      if (target === 'global-board') {
        await expect(win.getByRole('dialog', { name: '全局看板', exact: true })).toBeHidden();
        await expect(tourCoachmark.getByRole('heading', { name: '设置主题', exact: true })).toBeVisible();
      }
    }
    await expect(win.getByRole('heading', { name: '准备就绪', exact: true })).toBeVisible();
    // 远程访问是完成页里的可选入口，打开真实设置再返回仍保留完成页。
    await expect(win.getByRole('heading', { name: '稍后设置', exact: true })).toBeVisible();
    await win.getByRole('button', { name: '设置 → 远程访问 → 用网址打开', exact: true }).click();
    await expect(settings.getByRole('button', { name: '远程访问', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(settings.locator('[data-settings-item="webaccess-url"]')).toBeVisible();
    const gateway = await win.evaluate(() => window.api.webAccess.status());
    const remoteUrl = new URL(gateway.urls[0]);
    remoteUrl.hostname = '127.0.0.1';
    expect((await fetch(remoteUrl)).ok).toBe(true);
    await settings.getByRole('button', { name: /^返回工作台/ }).click();
    await expect(win.getByRole('heading', { name: '准备就绪', exact: true })).toBeVisible();
    await expect(win.getByText('已配置默认模型', { exact: true })).toBeVisible();
    await expect(win.getByText('已创建工作区', { exact: true })).toBeVisible();
    await expect(win.getByText('已打开第一条会话', { exact: true })).toBeVisible();
    await shot('06c-准备就绪.png');
    await win.getByRole('button', { name: '开始使用集序', exact: true }).click();
    await expect(win.locator('[data-setup-coachmark]')).toHaveCount(0);
    await expect(win.locator('.drawer-scrim')).not.toHaveClass(/\bis-shown\b/);
    const conversation = win.locator('.agent-chat-view.is-shown');
    await expect(conversation.locator('.composer-editable')).toBeVisible();
    const sessions = await win.evaluate(() => window.api.sessions.list());
    expect(sessions.sessions.filter(session => session.workspaceId === created.activeWorkspaceId && session.runtime === 'pi')).toHaveLength(1);
    expect(requests.map(request => request.stream)).toEqual([false, false]);
    await expect(conversation.locator('.composer-editable')).toBeFocused();
    await conversation.locator('.composer-editable').fill('你好，Muster');
    await conversation.getByRole('button', { name: '发送', exact: true }).click();
    await expect(conversation.locator('.chat-msg.assistant').getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(requests.at(-1)).toMatchObject({ stream: true, model: 'onboarding-model', keyAccepted: true });
    await expect(win.locator('.ext-nav-error')).toHaveCount(0);
    await shot('07-第一条回复.png');
    await resumedWindow.evaluate((window, geometry) => {
      window.setMinimumSize(geometry.min[0], geometry.min[1]);
      window.setContentSize(geometry.size[0], geometry.size[1]);
    }, full);

    // The empty snapshot is broadcast before the renderer has committed its file-view cleanup.
    // Check the actual close result as well as the page that follows it.
    const closed = await win.evaluate(id => window.api.workspaces.close(id), created.activeWorkspaceId);
    expect(closed).toMatchObject({ ok: true });
    await expect(win.getByRole('heading', { name: '为会话选一个工作目录' })).toBeVisible();
    await expect(win.getByRole('navigation', { name: '初始化进度' })).toHaveCount(0);
    const emptied = await win.evaluate(() => window.api.config.get());
    expect(emptied.workspaces).toHaveLength(0);
    expect(emptied.activeWorkspaceId).toBe('');
    await expect(win.locator('.ext-nav-error')).toHaveCount(0);
    await shot('08-删空后创建入口.png');

    await win.evaluate(() => { void window.api.app.quit(); }).catch(() => {});
    await app.close();
    app = await launch();
    win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await expect.poll(async () => {
      try { await win.evaluate(() => window.api.config.get()); return true; }
      catch { return false; }
    }, { timeout: 45_000, intervals: [200, 500, 1000] }).toBe(true);
    await expect(win.getByRole('heading', { name: '为会话选一个工作目录' })).toBeVisible();
    await expect(win.getByRole('navigation', { name: '初始化进度' })).toHaveCount(0);
    const rebooted = await win.evaluate(() => window.api.config.get());
    expect(rebooted.workspaces).toHaveLength(0);
    expect(rebooted.activeWorkspaceId).toBe('');
    await shot('09-删空重启.png');
  } finally {
    await app?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
