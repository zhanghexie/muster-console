import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('virtual-screen grip lets a mode preview turn into a resize and keeps the capsule visible', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const workspace = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox/userData');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'control-demo',
    workspaces: [{ id: 'control-demo', name: '虚拟屏验收', path: workspace, accentOff: true }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `vs-controls-${process.pid}` };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const main = page.locator('.main-view');
    const seam = page.locator('.pane-split-hit');
    const grip = page.getByRole('button', { name: '虚拟屏操作' });
    const menu = page.locator('.split-mode-menu');
    const capsule = page.locator('.split-menu-resize');
    const html = page.locator('html');
    const settle = async () => {
      await page.locator('.h-strip').evaluate(async el => {
        const animations = el.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
        await Promise.allSettled(animations.map(animation => animation.finished));
      });
    };
    const hold = async (along: number) => {
      const box = (await seam.boundingBox())!;
      await seam.hover({ position: { x: box.width / 2, y: box.height * along } });
      await expect(grip.locator('.split-expand-grip')).toHaveAttribute('data-mp-stage', 'in');
      const button = (await grip.boundingBox())!;
      const x = button.x + button.width / 2;
      const y = button.y + button.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect(menu).toHaveAttribute('data-mp-stage', 'in');
      await expect(menu).toHaveCSS('opacity', '1');
      return { x, y };
    };

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 760));
    await page.locator('.app-shell').waitFor();
    expect(await page.evaluate(() => localStorage.getItem('muster.hSwitchMode'))).toBeNull();
    await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    await expect(main).toHaveClass(/\bh-git\b/);
    await settle();
    await page.evaluate(() => {
      document.addEventListener('transitionrun', event => {
        const element = event.target as HTMLElement;
        if (!element.matches('.split-mode-menu')) return;
        const html = document.documentElement;
        html.dataset.testMenuTransition = [html.dataset.testMenuTransition, event.propertyName].join(' ');
        if (event.propertyName !== 'transform') return;
        const entering = element.dataset.mpStage === 'in';
        const transition = element.getAnimations().find(animation =>
          animation instanceof CSSTransition && animation.transitionProperty === 'transform'
        );
        const effect = transition?.effect;
        if (!(effect instanceof KeyframeEffect)) return;
        const collapsed = effect.getKeyframes().at(entering ? 0 : -1)?.transform;
        if (typeof collapsed !== 'string') return;
        const { a, d } = new DOMMatrixReadOnly(collapsed);
        if (a < 0.5 && d < 0.5) {
          html.dataset[entering ? 'testMenuExpand' : 'testMenuShrink'] = JSON.stringify({
            collapsed, duration: effect.getTiming().duration,
            easing: getComputedStyle(element).transitionTimingFunction
          });
        }
      });
    });

    const middle = await hold(.5);
    await expect(menu).toHaveCount(1);
    await expect(menu.locator('[aria-checked="true"]')).toHaveText('鼠标点击切屏');
    await expect(main).not.toHaveClass(/is-reshaping/);
    await expect(html).toHaveAttribute('data-test-menu-transition', /opacity/);
    await expect(html).toHaveAttribute('data-test-menu-expand', /scale|matrix/);
    await settle();
    await page.screenshot({
      clip: { x: middle.x - 165, y: middle.y - 135, width: 330, height: 270 },
      path: info.outputPath('after-dark.png')
    });
    await page.mouse.up();
    await expect(menu).toHaveCount(0);
    await page.mouse.move(10, 16);

    const choosing = await hold(.5);
    const hover = menu.locator('[data-mode="hover"]');
    const row = (await hover.boundingBox())!;
    await page.mouse.move(choosing.x, row.y + row.height / 2, { steps: 4 });
    await expect(hover).toHaveClass(/is-armed/);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('muster.hSwitchMode'))).toBe('hover');
    await expect(menu).toHaveCount(0);

    await page.mouse.move(10, 16);
    await page.evaluate(() => window.api.themes.activate('light'));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(800, 600);
      window.setSize(900, 680);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900);
    await expect(html).toHaveAttribute('data-theme', 'light');
    await settle();
    const top = await hold(.02);
    const upperMenu = (await menu.boundingBox())!;
    const narrowSeam = (await seam.boundingBox())!;
    expect(upperMenu.y).toBeGreaterThanOrEqual(narrowSeam.y);
    expect(upperMenu.y + upperMenu.height).toBeLessThanOrEqual(narrowSeam.y + narrowSeam.height);
    await settle();
    await page.screenshot({
      clip: { x: top.x - 165, y: Math.max(0, top.y - 35), width: 330, height: 210 },
      path: info.outputPath('after-light-compact.png')
    });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('inert', '');
    await page.mouse.up();
    await page.mouse.move(10, 16);
    await expect(menu).toHaveCount(0);

    await page.evaluate(() => { delete document.documentElement.dataset.testMenuExpand; });
    const start = await hold(.5);
    const expansion = await html.getAttribute('data-test-menu-expand');
    expect(expansion).toBeTruthy();
    const click = menu.locator('[data-mode="click"]');
    const clickBox = (await click.boundingBox())!;
    const clickY = clickBox.y + clickBox.height / 2;
    await page.mouse.move(start.x, clickY, { steps: 4 });
    await page.mouse.move(start.x + 28, clickY, { steps: 3 });
    await expect(click).toHaveClass(/is-armed/);
    await expect(main).not.toHaveClass(/is-reshaping/);
    await page.evaluate(() => { delete document.documentElement.dataset.testMenuShrink; });
    await page.mouse.move(start.x + 28, start.y, { steps: 4 });
    await expect(main).toHaveClass(/is-reshaping/);
    await page.mouse.move(start.x + 48, start.y, { steps: 3 });
    await expect(html).toHaveAttribute('data-test-menu-shrink', expansion!);
    await expect(menu).toHaveCount(0);
    await expect(capsule).toHaveAttribute('data-mp-stage', 'in');
    await expect(capsule).toHaveAttribute('data-direction', 'right');
    await expect.poll(async () => (await seam.boundingBox())!.x).toBeGreaterThan(start.x + 40);
    const capsuleBox = (await capsule.boundingBox())!;
    const seamBox = (await seam.boundingBox())!;
    expect(capsuleBox.x + capsuleBox.width / 2).toBeCloseTo(seamBox.x + seamBox.width / 2, 0);
    await page.screenshot({
      clip: { x: capsuleBox.x - 90, y: capsuleBox.y - 78, width: 248, height: 180 },
      path: info.outputPath('resizing-light.png')
    });
    await page.keyboard.press('Escape');
    await page.mouse.move(10, 16);
    await page.mouse.up();
    await expect(main).not.toHaveClass(/is-reshaping/);
    await expect.poll(async () => (await seam.boundingBox())!.x + (await seam.boundingBox())!.width / 2).toBeCloseTo(start.x, 0);

    const quick = await hold(.5);
    const focus = menu.locator('[data-mode="focus"]');
    const focusBox = (await focus.boundingBox())!;
    await page.mouse.move(quick.x, focusBox.y + focusBox.height / 2, { steps: 4 });
    await expect(focus).toHaveClass(/is-armed/);
    const readRatio = () => page.evaluate(async () => (await window.api.workspaceFile.get()).config.hGitRatio);
    const originalRatio = await readRatio();
    // 强制最后一次移动和松手落在同一帧，覆盖尚未渲染就保存宽度的路径。
    await grip.evaluate((button, { x, y }) => {
      const pointer = { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y };
      button.dispatchEvent(new PointerEvent('pointermove', { ...pointer, buttons: 1 }));
      button.dispatchEvent(new PointerEvent('pointerup', pointer));
    }, { x: quick.x + 40, y: quick.y });
    await page.mouse.up();
    await expect.poll(readRatio).not.toBe(originalRatio);
    await expect.poll(async () => (await seam.boundingBox())!.x).toBeGreaterThan(quick.x + 35);
    await expect(main).toHaveClass(/\bh-git\b/);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.mouse.move(10, 16);
    await grip.focus();
    await grip.press('Enter');
    await expect(menu).toHaveCSS('transition-property', 'none');
    await expect(capsule).toHaveCSS('transition-property', 'none');
    await expect(menu.getByRole('menuitemradio', { name: '鼠标悬浮切屏' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitemradio', { name: '关闭虚拟屏' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(main).toHaveClass(/is-focus/);
    await expect(menu).toHaveCount(0);
    await expect(capsule).toHaveCount(0);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 680));
    await expect(html).toHaveClass(/is-narrow/);
    await expect(grip).toHaveCount(0);
  } finally {
    await app.close();
  }
});
