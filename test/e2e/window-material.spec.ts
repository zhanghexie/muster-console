import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { virtualScreenPageKey } from '../../src/renderer/src/virtualScreenPagePreference';

const root = path.resolve(__dirname, '../..');
const requireNode = createRequire(__filename);
const captures = path.join(root, '.tmp/window-material/captures');

function expectedFrameMaterial() {
  if (process.platform === 'darwin') return 'vibrancy';
  return process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621 ? 'mica' : 'solid';
}

async function captureDesktop(app: ElectronApplication, page: Page, name: string) {
  await page.bringToFront();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.show(); win.moveTop(); win.focus();
  });
  await page.waitForTimeout(450); // DWM must compose the new material before capture.
  const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getBounds();
    const display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    } });
    const source = sources.find(s => s.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('No actual desktop composition capture');
    const size = source.thumbnail.getSize();
    const sx = size.width / display.size.width, sy = size.height / display.size.height;
    const image = source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x) * sx),
      y: Math.round((bounds.y - display.bounds.y) * sy), width: Math.round(bounds.width * sx),
      height: Math.round(bounds.height * sy) });
    const bitmap = image.toBitmap(), dimensions = image.getSize();
    let contentEdges = 0;
    // Text/icons produce sharp edges; a wallpaper-only window must fail visual acceptance.
    for (let y = 4; y < dimensions.height - 4; y += 2) for (let x = 4; x < dimensions.width - 4; x++) {
      const i = (y * dimensions.width + x) * 4;
      if (Math.abs(bitmap[i] - bitmap[i + 4]) + Math.abs(bitmap[i + 1] - bitmap[i + 5]) +
        Math.abs(bitmap[i + 2] - bitmap[i + 6]) > 100) contentEdges++;
    }
    const sample = (x: number, y: number, radiusY = 2) => {
      const rgb = [0, 0, 0]; let count = 0;
      for (let dy = -radiusY; dy <= radiusY; dy++) for (let dx = -2; dx <= 2; dx++) {
        const i = (Math.round((y + dy) * sy) * dimensions.width + Math.round((x + dx) * sx)) * 4;
        rgb[0] += bitmap[i + 2]; rgb[1] += bitmap[i + 1]; rgb[2] += bitmap[i]; count++;
      }
      return rgb.map(v => v / count);
    };
    return { png: image.toPNG().toString('base64'), contentEdges, samples: {
      header: sample(bounds.width - 150, 28), nativeButtons: sample(bounds.width - 130, 28),
      bottom: sample(bounds.width / 2, bounds.height - 3, 1), sidebar: sample(4, 350, 18)
    } };
  });
  await fs.writeFile(path.join(captures, name + '.png'), Buffer.from(capture.png, 'base64'));
  expect(capture.contentEdges, `${name}: desktop capture must contain the working UI`).toBeGreaterThan(150);
  return capture.samples;
}

async function launchFrameApp(instance: string) {
  await fs.mkdir(path.join(root, '.tmp/window-material'), { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(root, '.tmp/window-material/app-'));
  const userData = path.join(sandbox, '.dev-sandbox/userData');
  await fs.mkdir(userData, { recursive: true });
  // Seed a separate config, so the test neither resets another dev app nor inherits credentials.
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    activeWorkspaceId: 'demo-playground', themeId: 'dark', workspaces: [],
    workspace: path.join(sandbox, '.dev-sandbox/workspaces/demo-playground'),
    webAccess: { enabled: false }
  }));
  const env = { ...process.env } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT',
    'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX', 'MUSTER_DEV_MOBILE_WS']) delete env[key];
  env.MUSTER_SANDBOX = '1';
  env.MUSTER_INSTANCE_ID = `${instance}-e2e-${process.pid}`;
  const app = await electron.launch({ executablePath: requireNode('electron'), args: [root,
    '--force-device-scale-factor=1', ...(env.MICA_E2E_IN_PROCESS_GPU === '1' ? ['--in-process-gpu'] : [])],
    cwd: sandbox, env, timeout: 25_000 });
  return { app, sandbox };
}

test('production frame combines raw Mica and one pure workspace tint across header, sidebar and edges', async () => {
  test.setTimeout(65_000);
  const material = expectedFrameMaterial();
  const supported = material === 'mica';
  await fs.mkdir(captures, { recursive: true });
  const { app } = await launchFrameApp('mica');
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.locator('.app-shell').waitFor({ timeout: 25_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 40, width: 1200, height: 780 }));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.nativeMaterial)).toBe(material);
    if (!supported) {
      if (material === 'solid') {
        expect(await page.locator('.app-shell').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      }
      return;
    }
    const chrome = await page.evaluate(() => window.api.app.setChromeTheme({ panel: '#202023', ink: '#ededee', appearance: 'dark' }));
    expect(chrome).toEqual({ ok: true, material: 'mica' });
    expect(await app.evaluate(({ nativeTheme, BrowserWindow }) => ({
      theme: nativeTheme.themeSource, background: BrowserWindow.getAllWindows()[0].getBackgroundColor()
    // Electron's getter deliberately omits alpha; the pure regression guards the setter value.
    }))).toEqual({ theme: 'dark', background: '#000000' });
    expect(await page.evaluate(() => [document.documentElement, document.body, document.getElementById('root')!]
      .map(el => getComputedStyle(el).backgroundColor))).toEqual(Array(3).fill('rgba(0, 0, 0, 0)'));
    const accent = async (enabled: boolean, color = '#8b7bff') => {
      await page.evaluate(async ({ enabled, color }) => {
        const { workspaceId } = await window.api.workspaceFile.get();
        await window.api.workspaces.update(workspaceId!, { accent: color, accentOff: !enabled });
      }, { enabled, color });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceMaterial)).toBe(enabled ? 'frosted' : 'solid');
      await expect.poll(() => page.evaluate(() => {
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.fillStyle = getComputedStyle(document.querySelector('.app-shell')!).backgroundColor;
        ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3];
      })).toBe(enabled ? 71 : 0);
    };
    await accent(false);
    const darkRaw = await captureDesktop(app, page, 'mica-dark-raw');
    await accent(true);
    const darkTint = await captureDesktop(app, page, 'mica-dark-purple');
    for (const key of ['header', 'bottom', 'sidebar'] as const) {
      const expected = darkRaw[key].map((v, i) => Math.round(v * .72 + [139, 123, 255][i] * .28));
      expect(darkTint[key].every((v, i) => Math.abs(v - expected[i]) <= 3), `${key}: pure tint over actual Mica`).toBe(true);
    }
    expect(darkTint.header.every((v, i) => Math.abs(v - darkTint.nativeButtons[i]) <= 3), 'native button strip must join the tinted header').toBe(true);
    await accent(true, '#ff8a5b');
    await captureDesktop(app, page, 'mica-dark-orange');
    await page.evaluate(async () => {
      const { workspaceId } = await window.api.workspaceFile.get();
      await window.api.themes.activate('light', { scope: 'workspace', workspaceId: workspaceId! });
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    expect(await page.evaluate(() => document.documentElement.dataset.nativeMaterial)).toBe('mica');
    await accent(false);
    const lightRaw = await captureDesktop(app, page, 'mica-light-raw');
    await accent(true);
    const lightTint = await captureDesktop(app, page, 'mica-light-purple');
    expect(lightTint.header.every((v, i) => Math.abs(v - lightTint.nativeButtons[i]) <= 3)).toBe(true);
    const patchLayout = async (patch: { hVirtualScreen: boolean; hDock: 'terminal' | 'git'; hTerminalRatio: number; hGitRatio: number; leftColumnWidth: number }) => {
      const { workspaceId } = await page.evaluate(() => window.api.workspaceFile.get());
      await page.evaluate(async ({ patch, workspaceId, pageKey }) => {
        const { leftColumnWidth, hDock, ...workspaceLayout } = patch;
        localStorage.setItem('muster.leftColumnWidth.v1', String(leftColumnWidth));
        localStorage.setItem(pageKey, hDock === 'git' ? 'right' : 'left');
        const result = await window.api.workspaceFile.patch(workspaceLayout, workspaceId);
        if (!result.ok) throw new Error('layout patch rejected');
      }, { patch, workspaceId, pageKey: virtualScreenPageKey(workspaceId) });
      // Reload exercises workspace layout hydration and the separately stored global sidebar width.
      await page.reload();
      await page.locator('.app-shell').waitFor();
      if (patch.hDock === 'git') await expect(page.locator('.main-view')).toHaveClass(/h-git/);
      else await expect(page.locator('.main-view')).not.toHaveClass(/h-git/);
      await expect.poll(() => page.locator('.sessions-column').evaluate(el => el.getBoundingClientRect().width)).toBe(patch.leftColumnWidth);
      await expect.poll(() => page.locator('.h-strip').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41))
        .toBeCloseTo(patch.hVirtualScreen && patch.hDock === 'git' ? 1200 * (1 - patch.hTerminalRatio - patch.hGitRatio) : 0, 0);
    };
    await patchLayout({ hVirtualScreen: true, hDock: 'git', hTerminalRatio: .75, hGitRatio: .5, leftColumnWidth: 480 });
    const geometry = await page.locator('.h-strip').evaluate(el => {
      const css = getComputedStyle(el);
      const side = el.querySelector('.sessions-column')!.getBoundingClientRect();
      return { offset: new DOMMatrixReadOnly(css.transform).m41, sidebarRight: side.right,
        background: getComputedStyle(el.closest('.main-view')!).backgroundColor };
    });
    expect(geometry.offset).toBeLessThan(0);
    expect(geometry.sidebarRight).toBeGreaterThan(100); // Git primary still leaves part of the sidebar visible.
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    await captureDesktop(app, page, 'mica-light-partial-sidebar');
    await patchLayout({ hVirtualScreen: true, hDock: 'git', hTerminalRatio: .5, hGitRatio: .5, leftColumnWidth: 300 });
    const halfLayout = await page.locator('.h-strip').evaluate(el => {
      return { offset: new DOMMatrixReadOnly(getComputedStyle(el).transform).m41,
        backdrop: getComputedStyle(el, '::before').content };
    });
    expect(halfLayout.offset).toBeCloseTo(0, 0);
    expect(halfLayout.backdrop).toBe('none');
    await captureDesktop(app, page, 'mica-light-small-ratios');
    await patchLayout({ hVirtualScreen: false, hDock: 'terminal', hTerminalRatio: .875, hGitRatio: .75, leftColumnWidth: 300 });
    // Exercise the actual drag state; native cards remain opaque throughout.
    const resizer = await page.getByRole('separator', { name: '调节左栏宽度' }).boundingBox();
    expect(resizer).toBeTruthy();
    await page.mouse.move(resizer!.x + resizer!.width / 2, resizer!.y + 120);
    await page.mouse.down();
    await page.mouse.move(resizer!.x + 24, resizer!.y + 120);
    await expect(page.locator('.main-view')).toHaveClass(/is-left-resizing/);
    expect(await page.locator('.terminal-page').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await page.mouse.up();
    await page.locator('.chrome-sessions-toggle').click();
    await expect(page.locator('.main-view')).toHaveClass(/sessions-hidden/);
    await expect(page.locator('.sessions-float')).toHaveCSS('visibility', 'hidden');
    await captureDesktop(app, page, 'mica-light-folded');
    await page.mouse.move(300, 360);
    await page.mouse.move(20, 360);
    await page.locator('.sessions-hot-ghost').waitFor();
    await page.locator('.sessions-hot-ghost').hover();
    await expect(page.locator('.main-view')).toHaveClass(/sessions-peek/);
    await expect(page.locator('.sessions-float')).toHaveCSS('visibility', 'visible');
    await captureDesktop(app, page, 'mica-light-peek');
    await page.locator('.chrome-sessions-toggle').click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    await expect(page.locator('.settings-page')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    for (const selector of ['.app-shell > .chrome-bar', '.app-shell > .main-view']) {
      await expect(page.locator(selector)).toHaveCSS('opacity', '0');
      await expect(page.locator(selector)).toHaveCSS('pointer-events', 'none');
      await expect(page.locator(selector)).toHaveAttribute('inert', '');
    }
    await captureDesktop(app, page, 'mica-light-settings');
    await page.locator('.settings-back').click();
    await expect(page.locator('.settings-page')).toHaveCount(0);
    await expect(page.locator('.main-view')).toBeVisible();
    for (const selector of ['.app-shell > .chrome-bar', '.app-shell > .main-view']) {
      await expect(page.locator(selector)).toHaveCSS('opacity', '1');
      await expect(page.locator(selector)).not.toHaveAttribute('inert');
    }
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(390, 600); win.setSize(780, 650);
    });
    await expect(page.locator('html')).toHaveClass(/is-narrow/);
    expect(await page.locator('.h-strip').evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
    await captureDesktop(app, page, 'mica-light-narrow');
    expect(pageErrors).toEqual([]);
    await fs.writeFile(path.join(captures, 'observations.json'), JSON.stringify({ supported, darkRaw, darkTint, lightRaw, lightTint, geometry, halfLayout, pageErrors }, null, 2));
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});

test('scheduler chat and image viewer use the shared glass backdrop', async ({}, info) => {
  test.setTimeout(50_000);
  const { app, sandbox } = await launchFrameApp('scheduler-backdrop');
  const material = expectedFrameMaterial();
  try {
    const page = await app.firstWindow();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-native-material', material);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 780));
    await page.evaluate(async () => {
      const { workspaceId } = await window.api.workspaceFile.get();
      if (!workspaceId) throw new Error('No active test workspace');
      const layout = await window.api.workspaceFile.patch({ focusMode: true, focusRatio: .65 }, workspaceId);
      if (!layout.ok) throw new Error('Could not enable the side by side layout');
    });
    await page.reload();
    await expect(page.locator('.main-view')).toHaveClass(/is-focus/);
    const stack = page.locator('.left-ws-slot');
    const backdrop = page.locator('.agent-float-backdrop');
    const body = page.locator('body');
    const glassRoot = material === 'vibrancy' ? 'opacity' : 'auto';
    const glass = 'blur(16px) saturate(1.2)';
    const image = await fs.readFile(path.join(root, 'build', 'icon.png'));
    const surfaces = ['.sessions-column .utility-navigation', '.sessions-column .left-panel-scroll', '.terminal-page', '.git-page']
      .map(sel => page.locator(sel));
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(async theme => {
        const { workspaceId } = await window.api.workspaceFile.get();
        if (!workspaceId) throw new Error('No active test workspace');
        await window.api.workspaces.update(workspaceId, { accent: '#2ea6b6', accentOff: theme === 'dark' });
        await window.api.themes.activate(theme, { scope: 'workspace', workspaceId });
      }, theme);
      await expect(html).toHaveAttribute('data-theme', theme);
      await expect(html).toHaveAttribute('data-workspace-material', theme === 'dark' ? 'solid' : 'frosted');
      await expect(html).toHaveAttribute('data-native-material', material);
      await stack.getByRole('button', { name: /^(对话|Chat)$/ }).first().click();
      await expect(backdrop).toHaveAttribute('data-agent-backdrop-interactive', 'true');
      await expect(backdrop).toHaveCSS('backdrop-filter', glass);
      await expect(body).toHaveCSS('will-change', glassRoot);
      for (const surface of surfaces) {
        await expect(surface).toHaveCSS('filter', 'none');
      }
      await expect(stack).toHaveCSS('filter', 'none');
      await expect(stack.getByRole('button', { name: /^(收起|Collapse)$/ })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`scheduler-backdrop-${theme}.png`) });

      const composer = page.locator('.agent-float-panel .chat-input-shell');
      await composer.locator('input[type=file]').setInputFiles({ name: 'muster.png', mimeType: 'image/png', buffer: image });
      await composer.locator('.agent-composer-image-open').last().click();
      const viewer = page.locator('.md-mermaid-overlay[data-overlay-root]');
      const imageBackdrop = viewer.locator('.backdrop-blur-overlay.mp-scrim');
      await expect(viewer.locator('img')).toBeVisible();
      await expect(imageBackdrop).toHaveCSS('backdrop-filter', glass);
      await expect(imageBackdrop).toHaveCSS('opacity', '1');
      await expect(body).toHaveCSS('will-change', glassRoot);
      await page.screenshot({ path: info.outputPath(`image-backdrop-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(imageBackdrop).toHaveAttribute('data-mp-stage', 'out');
      await expect(viewer).toHaveCount(0);
      await expect(backdrop).toHaveAttribute('data-mp-stage', 'in');
      await expect(body).toHaveCSS('will-change', glassRoot);

      await backdrop.click({ position: { x: 8, y: 330 } });
      await expect(backdrop).toHaveAttribute('data-mp-stage', 'out');
      await expect(backdrop).toHaveCount(0);
      await expect(body).toHaveCSS('will-change', 'auto');
    }

    await stack.getByRole('button', { name: /^(对话|Chat)$/ }).first().click();
    await expect(body).toHaveCSS('will-change', glassRoot);
    await page.locator('.chrome-sessions-toggle').click();
    await expect(backdrop).toHaveCount(0);
    await expect(body).toHaveCSS('will-change', 'auto');
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('right virtual screen stops resizing at 50% and scopes the glass backdrop over Vibrancy', async () => {
  const { app, sandbox } = await launchFrameApp('virtual-screen-resize');
  try {
    const page = await app.firstWindow();
    await page.locator('.app-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 780));
    const { workspaceId } = await page.evaluate(() => window.api.workspaceFile.get());
    await page.evaluate(async ({ workspaceId, pageKey }) => {
      localStorage.setItem(pageKey, 'right');
      localStorage.setItem('muster.hSwitchMode', 'click');
      const layout = await window.api.workspaceFile.patch({
        hVirtualScreen: true, hTerminalRatio: .61, hGitRatio: .535, focusMode: false
      }, workspaceId);
      if (!layout.ok) throw new Error('Could not open the right virtual screen');
    }, { workspaceId, pageKey: virtualScreenPageKey(workspaceId) });
    await page.reload();

    const material = expectedFrameMaterial();
    const main = page.locator('.main-view.h-vs-on.h-git');
    const area = main.locator('.work-area');
    const sidebar = main.locator('.sessions-column');
    const card = main.locator('.ws-resize-card');
    const seam = main.locator('.pane-split-hit');
    const grip = main.getByRole('button', { name: /^(虚拟屏操作|Virtual screen controls)$/ });
    await expect(page.locator('html')).toHaveAttribute('data-native-material', material);
    await expect(area).toHaveCSS('will-change', 'auto');

    const startResize = async () => {
      const seamBox = (await seam.boundingBox())!;
      await seam.hover({ position: { x: seamBox.width / 2, y: seamBox.height / 2 } });
      await expect(grip.locator('.split-expand-grip')).toHaveAttribute('data-mp-stage', 'in');
      const box = (await grip.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect(main.locator('.split-mode-menu')).toHaveAttribute('data-mp-stage', 'in');
      await expect(area).toHaveCSS('will-change', 'auto');
      await page.mouse.move(x + 125, y, { steps: 12 });
      await expect(main).toHaveClass(/\bis-reshaping\b/);
      await expect(card).toHaveCSS('backdrop-filter', 'blur(16px) saturate(1.2)');
      await expect(area).toHaveCSS('will-change', material === 'vibrancy' ? 'opacity' : 'auto');
      await expect(page.locator('body')).toHaveCSS('will-change', 'auto');
      await expect(card.locator('.ws-resize-card-num')).toHaveText('50%');
    };

    const viewWidth = (await area.boundingBox())!.width;
    const terminalWidth = Math.round(viewWidth * .61);
    const initialX = viewWidth - terminalWidth - Math.round(viewWidth * .535);
    const halfWidth = Math.round(viewWidth / 2);
    const sidebarXAtHalfWidth = viewWidth - terminalWidth - halfWidth;
    const sidebarX = async () => (await sidebar.boundingBox())!.x;
    await expect.poll(sidebarX).toBeCloseTo(initialX, 0);
    await startResize();
    await expect.poll(sidebarX).toBeCloseTo(sidebarXAtHalfWidth, 0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.mouse.move(10, 16);
    await expect(card).toHaveCount(0);
    await expect(area).toHaveCSS('will-change', 'auto');
    await expect.poll(sidebarX).toBeCloseTo(initialX, 0);

    await startResize();
    await page.mouse.up();
    await expect(card).toHaveCount(0);
    await expect(area).toHaveCSS('will-change', 'auto');
    await expect.poll(sidebarX).toBeCloseTo(sidebarXAtHalfWidth, 0);
    await expect.poll(() => page.evaluate(async () => (await window.api.workspaceFile.get()).config.hGitRatio)).toBe(.5);

    await test.step('a workspace saved at 40% reopens at half width', async () => {
      const legacyLayout = await page.evaluate(id => window.api.workspaceFile.patch({ hGitRatio: .4 }, id), workspaceId);
      expect(legacyLayout).toMatchObject({ ok: true, config: { hGitRatio: .4 } });
      await page.reload();
      await expect(main.locator('.git-page')).toHaveCSS('width', `${halfWidth}px`);
      await expect.poll(sidebarX).toBeCloseTo(sidebarXAtHalfWidth, 0);
    });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
