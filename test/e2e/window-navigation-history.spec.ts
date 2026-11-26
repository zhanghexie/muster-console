import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('窗口历史：左侧虚拟屏与分屏回放、右侧内容与快捷键互不串栈', async ({}, info) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..'), fixture = info.outputDir;
  const root = path.join(fixture, 'workspace'), userData = path.join(fixture, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(root, 'first.txt'), 'First resource\n');
  fs.writeFileSync(path.join(root, 'second.txt'), 'Second resource\n');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'nav', workspaces: [{ id: 'nav', name: '导航验收', path: root, accentOff: true }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `navigation-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const output = path.join(project, 'output/window-navigation'); fs.mkdirSync(output, { recursive: true });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 920));
    await page.locator('.app-shell').waitFor();
    await page.evaluate(() => localStorage.setItem('muster.hSwitchMode', 'click'));
    await page.reload(); await page.locator('.app-shell').waitFor();
    const ids = await page.evaluate(async root => {
      const options = { runtime: 'pi', force: true, cwd: root, workspaceId: 'nav' };
      const a = await window.api.sessions.create({ ...options, name: '历史会话甲' });
      const b = await window.api.sessions.create({ ...options, name: '历史会话乙' });
      await window.api.sessions.select(a.id); return [a.id, b.id];
    }, root);
    expect(ids).toHaveLength(2);
    await page.keyboard.press('Escape');
    const handle = (slot: number) => page.getByTestId(`center-pane-handle-${slot}`);
    const leftBack = page.locator('.chrome-history-btn').nth(0), leftForward = page.locator('.chrome-history-btn').nth(1);
    const pane = page.locator('.right-workspace');
    const rightBack = pane.locator('.right-history button').nth(0), rightForward = pane.locator('.right-history button').nth(1);
    const screenshot = async (name: string) => {
      await page.mouse.move(750, 20);
      await page.locator('.h-strip').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      await page.screenshot({ path: path.join(output, name) });
    };
    await expect(handle(0)).toHaveAttribute('aria-label', '历史会话甲：分屏操作');
    await page.locator('.utility-feature-item').filter({ hasText: '定时任务' }).click();
    await expect(handle(0)).toHaveAttribute('aria-label', '定时任务：分屏操作');
    await expect(leftBack).toHaveAttribute('title', /可退 \d+ 步.*Alt\+←/);
    await leftBack.hover();
    await expect(page.getByRole('tooltip')).toContainText('Alt+←');
    await page.screenshot({ path: path.join(output, 'left-history-hint.png') });
    await leftBack.click(); await expect(handle(0)).toHaveAttribute('aria-label', '历史会话甲：分屏操作');
    await expect(leftForward).toHaveAttribute('title', /可进 \d+ 步.*Alt\+→/);
    await leftForward.click(); await expect(handle(0)).toHaveAttribute('aria-label', '定时任务：分屏操作');
    await leftBack.click(); await expect(handle(0)).toHaveAttribute('aria-label', '历史会话甲：分屏操作');
    await handle(0).focus(); await page.keyboard.press('Control+\\');
    await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
    await page.locator('.session-item').filter({ hasText: '历史会话乙' }).click();
    await expect(handle(1)).toHaveAttribute('aria-label', '历史会话乙：分屏操作');
    await page.locator('.utility-feature-item').filter({ hasText: '使用统计' }).click();
    await expect(handle(1)).toHaveAttribute('aria-label', '使用统计：分屏操作');
    await leftBack.click(); await expect(handle(1)).toHaveAttribute('aria-label', '历史会话乙：分屏操作');
    await expect(handle(0)).toHaveAttribute('aria-label', '历史会话甲：分屏操作');
    await screenshot('dark-split-restored.png');

    await leftBack.focus(); await page.keyboard.press('Control+Shift+\\');
    await expect(page.locator('.main-view')).toHaveClass(/h-git/);
    await pane.getByRole('tab', { name: '文件', exact: true }).click();
    const file = (name: string) => pane.locator(`.right-resource-page.is-shown .file-tree-row[title="${name}"]`);
    await file('first.txt').dblclick(); await file('second.txt').dblclick();
    const selected = pane.locator('.right-tab[aria-selected="true"]');
    await expect(selected).toContainText('second.txt');
    await expect(rightBack).toHaveAttribute('title', '撤销（可撤销 2 步） · Ctrl+Alt+←');
    await rightBack.hover();
    await expect(page.getByRole('tooltip')).toHaveText('撤销（可撤销 2 步） · Ctrl+Alt+←');
    await page.screenshot({ path: path.join(output, 'right-history-hint.png') });
    await leftBack.click(); await expect(page.locator('.main-view')).not.toHaveClass(/h-git/);
    await expect(handle(1)).toHaveAttribute('aria-label', '历史会话乙：分屏操作');
    await expect(selected).toContainText('second.txt');
    await leftForward.click(); await expect(page.locator('.main-view')).toHaveClass(/h-git/);
    await expect(selected).toContainText('second.txt');
    await rightBack.click(); await expect(selected).toContainText('first.txt');
    await expect(rightForward).toHaveAttribute('title', '重做（可重做 1 步） · Ctrl+Alt+→');
    await expect(page.locator('.main-view')).toHaveClass(/h-git/);
    // Alt+Arrow always controls the left history, even with the right workspace active.
    await rightBack.focus(); await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.main-view')).not.toHaveClass(/h-git/);
    await expect(selected).toContainText('first.txt');
    await page.keyboard.press('Alt+ArrowRight'); await expect(page.locator('.main-view')).toHaveClass(/h-git/);
    await page.keyboard.press('Control+Alt+ArrowRight'); await expect(selected).toContainText('second.txt');
    await expect(page.locator('.main-view')).toHaveClass(/h-git/); await expect(rightForward).toBeDisabled();
    await screenshot('dark-right-independent.png');
    await leftBack.click();
    await handle(1).press('Enter');
    await page.getByRole('menuitemcheckbox', { name: '收起此侧', exact: true }).click();
    await expect(page.getByTestId('center-panel')).not.toHaveClass(/is-split/);
    await leftBack.click(); await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
    await expect(handle(1)).toHaveAttribute('aria-label', '历史会话乙：分屏操作');
    await page.evaluate(async () => window.api.themes.activate('light'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await screenshot('light-split-restored.png');
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(640, 600); window.setSize(850, 760);
    });
    await expect(page.getByTestId('center-panel')).toHaveClass(/is-split-narrow/);
    await page.getByTestId('center-pane-switch-0').press('Enter');
    // Focus-only selection must keep the forward branch available in the narrow fallback too.
    await expect(leftForward).toBeEnabled();
    await leftForward.click(); await expect(page.getByTestId('center-panel')).not.toHaveClass(/is-split/);
    await leftBack.click(); await expect(page.getByTestId('center-panel')).toHaveClass(/is-split-narrow/);
    await expect(page.getByTestId('center-pane-switch-0')).toHaveAttribute('aria-pressed', 'true');
    await screenshot('light-narrow-split-restored.png');
    expect(errors).toEqual([]);
  } catch (error) {
    await (await app.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await app.close(); }
});
