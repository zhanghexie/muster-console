import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('卡片碰边：左右分屏、上全屏、下关闭，与Snap选择器并行且可取消', async ({}, info) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..'), root = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'edge', workspaces: [{ id: 'edge', name: '边缘验收', path: root }],
    mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `pane-edges-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  let failurePage: import('@playwright/test').Page | undefined;
  try {
    const page = await app.firstWindow(); failurePage = page; page.setDefaultTimeout(5000); await page.locator('.app-shell').waitFor();
    await page.evaluate(() => localStorage.setItem('muster.hSwitchMode', 'click'));
    await page.reload(); await page.locator('.app-shell').waitFor();
    await page.evaluate(() => {
      const events: unknown[] = []; (window as any).__edgeEvents = events;
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur']) window.addEventListener(type, event => {
        const e = event as PointerEvent;
        events.push({ type, x: e.clientX, y: e.clientY, buttons: e.buttons, target: (e.target as HTMLElement)?.className,
          edge: document.querySelector('[data-testid="center-panel"]')?.getAttribute('data-edge-action') });
        if (events.length > 60) events.shift();
      }, true);
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 960));
    const ids = await page.evaluate(async cwd => {
      const options = { cwd, workspaceId: 'edge', runtime: 'pi', force: true };
      const a = await window.api.sessions.create({ ...options, name: '边缘会话甲' });
      const b = await window.api.sessions.create({ ...options, name: '边缘会话乙' });
      await window.api.sessions.select(a.id); return [a.id, b.id];
    }, root);
    await expect(page.getByTestId('center-pane-handle-0')).toHaveAttribute('aria-label', '边缘会话甲：分屏操作');
    const main = page.getByTestId('center-panel');
    await page.locator('.agent-chat-view.is-shown .composer-editable').fill('甲保留的草稿');
    const a = page.locator('.agent-chat-view').filter({ has: page.locator('.composer-editable', { hasText: '甲保留的草稿' }) });
    const nodeA = await a.elementHandle();
    await page.evaluate(id => window.api.sessions.select(id), ids[1]);
    await expect(page.getByTestId('center-pane-handle-0')).toHaveAttribute('aria-label', '边缘会话乙：分屏操作');
    await page.locator('.agent-chat-view.is-shown .composer-editable').fill('乙保留的草稿');
    const b = page.locator('.agent-chat-view').filter({ has: page.locator('.composer-editable', { hasText: '乙保留的草稿' }) });
    const nodeB = await b.elementHandle();
    const pair = async () => {
      await page.locator('.session-item').filter({ hasText: '边缘会话甲' }).click();
      await expect(page.getByTestId('center-pane-handle-0')).toHaveAttribute('aria-label', '边缘会话甲：分屏操作');
      await page.getByTestId('center-pane-handle-0').focus(); await page.keyboard.press('Control+\\');
      await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
      await page.locator('.session-item').filter({ hasText: '边缘会话乙' }).click();
      await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
      await expect(page.getByTestId('center-pane-handle-1')).toHaveAttribute('aria-label', '边缘会话乙：分屏操作');
    };
    await pair();
    const start = async (slot: number) => {
      const area = (await main.boundingBox())!, pane = (await page.getByTestId(`center-pane-${slot}`).boundingBox())!;
      const handle = page.getByTestId(`center-pane-handle-${slot}`);
      // Reveal through the supported keyboard path, then perform native mouse capture.
      await page.keyboard.press('Tab'); await handle.focus();
      await expect.poll(() => handle.evaluate(el => Number(getComputedStyle(el.closest('.center-split-pane-toolbar')!).opacity))).toBe(1);
      const grip = (await handle.boundingBox())!, x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      return { area, pane, grabX: x - pane.x, grabY: y - pane.y };
    };
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(id => window.api.themes.activate(id, { scope: 'workspace', workspaceId: 'edge' }), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const edge of ['left', 'right', 'fullscreen', 'close'] as const) {
        const { area, pane, grabX, grabY } = await start(1);
        const x = edge === 'left' ? area.x + grabX * .78 - 1 : edge === 'right'
          ? area.x + area.width - (pane.width - grabX) * .78 + 1 : area.x + area.width / 2;
        const y = edge === 'fullscreen' ? area.y + grabY * .32 - 1 : edge === 'close'
          ? area.y + area.height - (pane.height - grabY) * .78 + 1 : area.y + 120;
        if (edge === 'left' || edge === 'right') expect(Math.min(x - area.x, area.x + area.width - x)).toBeGreaterThan(18);
        await page.mouse.move(x, y); await expect(main).toHaveAttribute('data-edge-action', edge);
        await expect.poll(() => page.getByTestId('center-snap-preview').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
        await expect(page.locator('.center-drag-hint')).toHaveText({ left: '松开后左侧分屏', right: '松开后右侧分屏', fullscreen: '松开后全屏显示', close: '松开后关闭面板' }[edge]);
        await expect.poll(() => page.locator('.center-drag-hint').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await main.screenshot({ path: path.join(info.outputDir, `${theme}-${edge}-preview.png`) });
        if (edge === 'close') {
          await page.keyboard.press('Escape'); await page.mouse.up();
          await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
          const again = await start(1);
          await page.mouse.move(again.area.x + again.area.width / 2, again.area.y + again.area.height - (again.pane.height - again.grabY) * .78 + 1);
        }
        await page.mouse.up(); await expect(main).not.toHaveAttribute('data-edge-action', /.+/);
        if (edge === 'left' || edge === 'right') {
          await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
          const box = (await b.boundingBox())!;
          expect(box.x).toBeCloseTo(edge === 'left' ? area.x : area.x + area.width / 2, 0);
        } else if (edge === 'fullscreen') {
          await expect(b).toBeVisible(); await expect(a).toBeHidden();
          await expect(main).toHaveClass(/is-pane-fullscreen/);
          expect((await b.boundingBox())!.width).toBeCloseTo(await page.evaluate(() => innerWidth), 0);
          await page.keyboard.press('Escape');
          await expect(main).not.toHaveClass(/is-pane-fullscreen/);
          await pair();
        } else {
          await expect(a).toBeVisible(); await expect(b).toBeHidden();
          await pair();
        }
        expect(await nodeA!.evaluate(el => el.isConnected)).toBe(true);
        expect(await nodeB!.evaluate(el => el.isConnected)).toBe(true);
        await expect(a.locator('.composer-editable')).toHaveText('甲保留的草稿');
        await expect(b.locator('.composer-editable')).toHaveText('乙保留的草稿');
      }
      // Concrete picker cells still take precedence and can commit a layout.
      const { area } = await start(1);
      await page.mouse.move(area.x + area.width / 2, area.y + 120);
      await expect(page.getByTestId('center-snap-peek')).toBeVisible();
      const pickerNode = await page.getByTestId('center-snap-peek').elementHandle();
      await expect(page.getByTestId('center-snap-bar')).toHaveCount(0);
      await expect.poll(() => page.getByTestId('center-snap-peek').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
      await main.screenshot({ path: path.join(info.outputDir, `${theme}-snap-peek.png`) });
      await page.mouse.move(area.x + area.width / 2, area.y + 18);
      const cell = page.getByTestId('center-snap-cell-halves-1'); await expect(cell).toBeVisible();
      await expect.poll(() => page.getByTestId('center-snap-bar').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
      await expect.poll(() => page.locator('.center-snap-bar-position').evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(false);
      expect(await page.getByTestId('center-snap-bar').evaluate((el, original) => el === original, pickerNode)).toBe(true);
      await main.screenshot({ path: path.join(info.outputDir, `${theme}-snap-expanded.png`) });
      await page.mouse.move(area.x + area.width / 2, area.y + 4);
      await expect(main).toHaveAttribute('data-edge-action', 'fullscreen');
      await expect(page.getByTestId('center-snap-bar')).toHaveCount(0);
      await main.screenshot({ path: path.join(info.outputDir, `${theme}-snap-top-fullscreen.png`) });
      await page.mouse.move(area.x + area.width / 2, area.y + 18);
      await expect(cell).toBeVisible();
      await expect.poll(() => page.getByTestId('center-snap-bar').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
      await expect.poll(() => page.locator('.center-snap-bar-position').evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(false);
      const box = (await cell.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect(main).toHaveAttribute('data-snap-target', 'halves:1');
      await expect(main).not.toHaveAttribute('data-edge-action', /.+/);
      await page.mouse.up();
    }
    const rows = await page.evaluate(() => window.api.sessions.list());
    expect(rows.sessions.filter(row => ids.includes(row.id))).toHaveLength(2);
    expect(rows.sessions.filter(row => ids.includes(row.id)).some(row => row.archived)).toBe(false);
  } catch (error) {
    console.log(await failurePage?.evaluate(() => JSON.stringify({ events: (window as any).__edgeEvents,
      main: document.querySelector('[data-testid="center-panel"]')?.className,
      preview: document.querySelector('[data-testid="center-snap-preview"]')?.outerHTML })));
    await failurePage?.screenshot({ path: path.join(info.outputDir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); }).catch(() => {});
    await app.close();
  }
});
