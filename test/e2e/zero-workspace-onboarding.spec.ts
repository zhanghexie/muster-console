/**
 * 真 Electron 首装链路：本机检测 → Key 验证 → 浏览器访问 → 工作区 → 第一条会话与回复。
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

test('首次设置真实连接模型和网关，重启后续办并创建会话，删空回到工作区入口', async ({}, info) => {
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
    const navigation = await win.evaluate(() => window.api.workbench.navigation());
    expect(navigation).toMatchObject({ workspaceId: '', nodes: [] });
    await expect(win.locator('.ext-nav-error')).toHaveCount(0);
    expect(initial.recommendedName).toBe('muster 默认工作区');
    expect(path.resolve(initial.recommendedRoot).startsWith(path.resolve(tmpRoot))).toBe(true);
    expect(fs.existsSync(initial.recommendedRoot)).toBe(false);

    expect(config.locale).toBe('system');
    await win.evaluate(() => window.api.config.update({ locale: 'zh-CN' }));
    await expect(win.getByRole('heading', { name: '检测本机 AI 工具' })).toBeVisible();
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
    const providers = win.getByRole('combobox', { name: '模型供应商' });
    await providers.click();
    await win.getByRole('option', { name: '自定义供应商', exact: true }).click();
    await win.getByLabel('接口地址').fill(baseUrl);
    await win.getByLabel('模型 ID').fill('onboarding-model');
    await win.getByLabel('API Key', { exact: true }).fill('onboarding-fixture-invalid');
    await win.getByRole('button', { name: '测试并保存' }).click();
    const error = win.getByRole('alert').filter({ hasText: 'HTTP 401' });
    await expect(error).toContainText('••••');
    await expect(error).not.toContainText('onboarding-fixture-invalid');
    expect(requests).toEqual([{ path: '/v1/chat/completions', keyAccepted: false, stream: false, model: 'onboarding-model' }]);
    const remained = await win.evaluate(async () => (await window.api.config.get()).llm?.activeModelId);
    expect(remained).not.toBe('onboarding-model');

    expect(await win.evaluate(() => window.api.themes.activate('light'))).toMatchObject({ ok: true });
    const initialWindow = await app.browserWindow(win);
    const full = await initialWindow.evaluate(window => ({ size: window.getContentSize(), min: window.getMinimumSize() }));
    await initialWindow.evaluate(window => { window.setMinimumSize(460, 480); window.setContentSize(688, 680); });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBeLessThanOrEqual(688);
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await checkGuideCard();
    await win.getByLabel('API Key', { exact: true }).fill('onboarding-fixture-key');
    const submitModel = win.getByRole('button', { name: '测试并保存' });
    await expect(submitModel).toBeInViewport({ ratio: 1 });
    await shot('03-连接模型-浅色窄窗.png');
    await submitModel.click();
    await expect(win.getByRole('heading', { name: '在手机或另一台电脑上继续' })).toBeVisible();
    await expect(win.getByRole('img', { name: '网页访问二维码' })).toHaveCount(0);
    await shot('04-远程访问-浅色窄窗.png');
    await win.getByRole('button', { name: '显示连接方式' }).click();
    const qr = win.getByRole('img', { name: '网页访问二维码' });
    const url = new URL(await win.evaluate(async () => (await window.api.webAccess.status()).urls[0]));
    if (url.hostname === '127.0.0.1') {
      await expect(win.getByText('当前地址仅可在这台电脑上打开')).toBeVisible();
    } else {
      await expect(qr).toBeVisible();
      expect(await qr.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    }
    url.hostname = '127.0.0.1';
    expect((await fetch(url)).ok).toBe(true);
    await win.getByRole('button', { name: '稍后连接', exact: true }).click();

    const workspaceGuide = win.getByRole('region', { name: '在工作台创建工作区' });
    await expect(workspaceGuide).toBeVisible();
    const resumeRemote = win.getByRole('button', { name: '设置 → 远程访问 → 用网址打开' });
    await expect(resumeRemote).toBeVisible();
    await resumeRemote.click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await expect(settings.getByRole('button', { name: '远程访问', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(settings.locator('[data-settings-item="webaccess-url"]')).toBeVisible();
    await settings.getByRole('button', { name: /返回工作台/ }).click();
    await expect(settings).toBeHidden();

    const workspaceAdd = win.locator('button[data-setup-target="workspace"]');
    await win.mouse.move(400, 80);
    await expect(workspaceAdd).toBeInViewport({ ratio: 1 });
    await expect(workspaceAdd).toHaveCSS('opacity', '1');
    await expect(workspaceAdd).toHaveText('+');
    await expect(workspaceAdd).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(workspaceAdd).toHaveCSS('box-shadow', /inset/);
    const guidedAddSize = await workspaceAdd.evaluate(button => [getComputedStyle(button).width, getComputedStyle(button).height]);
    await shot('05-工作台高亮建区入口.png');
    await workspaceAdd.click();
    const workspaceDialog = win.getByRole('dialog', { name: '新建工作区' });
    await expect(workspaceDialog).toBeVisible();
    await expect(workspaceDialog.locator('.create-ws-path-row input')).toHaveValue(initial.recommendedRoot);
    await expect(workspaceDialog.getByRole('button', { name: '一键填入' })).toHaveCount(0);
    expect(fs.existsSync(initial.recommendedRoot)).toBe(false);
    await shot('05b-工作台新建工作区.png');
    await workspaceDialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(win.getByRole('heading', { name: '打开第一条会话' })).toBeFocused();
    const ordinaryWorkspaceAdd = win.locator('.agent-ws-add-btn[title="新建工作区"]');
    expect(await ordinaryWorkspaceAdd.evaluate(button => [getComputedStyle(button).width, getComputedStyle(button).height])).toEqual(guidedAddSize);
    expect(fs.statSync(initial.recommendedRoot).isDirectory()).toBe(true);
    const created = await win.evaluate(() => window.api.config.get());
    expect(created.workspaces).toHaveLength(1);
    expect(created.workspaces[0].name).toBe('我的工作区');
    expect(created.llm?.activeModelId).toBe('onboarding-model');
    await win.getByRole('button', { name: '显示左侧栏' }).click();
    let newSessionEntry = win.locator('button[data-setup-target="session"]');
    await expect(newSessionEntry).toBeInViewport({ ratio: 1 });
    await expect(newSessionEntry).toBeFocused();
    await expect(newSessionEntry).toHaveText('＋');
    await expect(newSessionEntry).toHaveCSS('width', '28px');
    await shot('06a-窄窗展开真实会话栏.png');
    await initialWindow.evaluate((window, geometry) => {
      window.setMinimumSize(geometry.min[0], geometry.min[1]);
      window.setContentSize(geometry.size[0], geometry.size[1]);
    }, full);
    await win.evaluate(() => { void window.api.app.quit(); }).catch(() => {});
    await app.close();
    app = await launch();
    win = await app.firstWindow();
    newSessionEntry = win.locator('button[data-setup-target="session"]');
    await expect(win.getByRole('heading', { name: '打开第一条会话' })).toBeVisible({ timeout: 60_000 });
    await expect(win.getByRole('button', { name: '设置 → 远程访问 → 用网址打开' })).toBeVisible();
    await win.getByRole('button', { name: '稍后创建会话' }).click();
    await expect(win.getByRole('heading', { name: '继续设置', exact: true })).toBeFocused();
    await win.getByRole('button', { name: '左栏 → 工作会话 → ＋' }).click();
    await expect(newSessionEntry).toBeInViewport({ ratio: 1 });
    await expect(newSessionEntry).toBeFocused();
    await expect(newSessionEntry).toHaveText('＋');
    await expect(newSessionEntry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(newSessionEntry).toHaveCSS('box-shadow', /inset/);
    await shot('06-第一条会话-重启续办.png');
    expect(await win.evaluate(() => window.api.themes.activate('dark'))).toMatchObject({ ok: true });
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    await shot('06c-第一条会话-深色宽窗.png');
    await win.getByRole('button', { name: '稍后创建会话' }).click();
    const continuation = win.getByRole('region', { name: '继续设置' });
    await expect(continuation.getByRole('button', { name: '设置 → 远程访问 → 用网址打开' })).toBeVisible();
    await shot('06d-续办卡片的关闭入口.png');
    await continuation.getByRole('button', { name: '关闭设置引导' }).click();
    await expect(win.getByTestId('center-panel')).toBeFocused();
    await expect(win.locator('.workbench-setup-guide')).toHaveCount(0);
    await expect(win.getByText('还没有选中会话', { exact: true })).toBeVisible();
    await shot('06e-关闭后回到工作台.png');
    await win.evaluate(() => { void window.api.app.quit(); }).catch(() => {});
    await app.close();
    app = await launch();
    win = await app.firstWindow();
    await expect(win.getByText('还没有选中会话', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('.workbench-setup-guide')).toHaveCount(0);
    const resumedWindow = await app.browserWindow(win);
    await resumedWindow.evaluate(window => { window.setMinimumSize(460, 480); window.setContentSize(688, 680); });
    await win.getByRole('button', { name: '会话', exact: true }).click();
    const sessionHeader = win.locator('.sessions-column .panel-header.sub').filter({ hasText: '工作会话' });
    await sessionHeader.hover();
    await sessionHeader.getByRole('button', { name: '新建任务', exact: true }).click();
    const taskDialog = win.getByRole('dialog', { name: '新建任务' });
    const createSession = taskDialog.getByRole('button', { name: '新建空白', exact: true });
    await expect(createSession).toHaveClass('git-btn');
    await expect(createSession).toBeEnabled();
    await shot('06b-标准新建任务表单.png');
    await createSession.click();
    await expect(taskDialog).toBeHidden();
    await expect(win.locator('.drawer-scrim')).not.toHaveClass(/\bis-shown\b/);
    const conversation = win.locator('.agent-chat-view.is-shown');
    await expect(conversation.locator('.composer-editable')).toBeVisible();
    const sessions = await win.evaluate(() => window.api.sessions.list());
    expect(sessions.sessions.filter(session => session.workspaceId === created.activeWorkspaceId && session.runtime === 'pi')).toHaveLength(1);
    expect(requests.map(request => request.stream)).toEqual([false, false]);
    await conversation.locator('.composer-editable').click();
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

    expect(await win.evaluate(() => window.api.themes.activate('dark'))).toMatchObject({ ok: true });
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    const chat = win.locator('.agent-ws-stack-item.is-active .agent-notify-chat');
    await chat.click();
    const float = win.locator('.agent-float-panel.is-open');
    await expect(float).toBeVisible();
    const checkHeight = async (): Promise<void> => {
      await expect.poll(() => float.evaluate(el => Math.abs((el as HTMLElement).offsetHeight - Math.min(520, innerHeight * 2 / 3, innerHeight - 48)))).toBeLessThanOrEqual(1);
    };
    await checkHeight();
    await float.screenshot({ path: info.outputPath('scheduler-dark.png') });
    expect(await win.evaluate(() => window.api.themes.activate('light'))).toMatchObject({ ok: true });
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    const browserWindow = await app.browserWindow(win);
    const original = await browserWindow.evaluate(window => ({ size: window.getContentSize(), min: window.getMinimumSize() }));
    await browserWindow.evaluate(window => { window.setMinimumSize(640, 480); window.setContentSize(820, 560); });
    await expect.poll(() => win.evaluate(() => innerHeight)).toBeLessThanOrEqual(560);
    await checkHeight();
    await float.screenshot({ path: info.outputPath('scheduler-light-narrow.png') });
    await browserWindow.evaluate((window, { size, min }) => {
      window.setMinimumSize(min[0], min[1]);
      window.setContentSize(size[0], size[1]);
    }, original);
    await chat.click();
    await expect(float).toBeHidden();

    const tools = win.locator('.utility-library-toggle');
    await win.evaluate(() => window.api.extensionCatalog.trust({ scope: 'global', extensionId: 'daily-report', mode: 'trusted-persistent' }));
    if ((await tools.getAttribute('aria-expanded')) !== 'true') await tools.click();
    await win.getByRole('treeitem', { name: '工作日报' }).click();
    const frame = win.frameLocator('.ext-panel iframe');
    const todo = frame.locator('#todoText');
    await expect.poll(async () => await todo.isVisible() ? 'report ready' : await win.locator('.ext-panel').textContent()).toBe('report ready');
    await expect(frame.locator('.d-date')).toHaveText(/\d{4}-\d{2}-\d{2}/);
    await shot('workspace-extension.png');

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
