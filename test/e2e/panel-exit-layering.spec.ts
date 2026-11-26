import { test, expect, type Page } from './fixtures/electron';

test.use({ isolatedSandbox: true });

async function sampleExit(page: Page, overlay: string, sheet: string) {
  await page.keyboard.press('Escape');
  return page.locator(overlay).evaluate(async (root, selector) => {
    const panel = root.querySelector<HTMLElement>(selector)!;
    const backdrop = root.querySelector(':scope > .backdrop-blur-overlay') ?? root;
    // Pin the actual CSS transitions while the presence timer is paused.
    const body = document.body;
    const underlayTransitions = body.getAnimations({ subtree: true }).filter(animation =>
      animation.effect instanceof KeyframeEffect
      && animation.effect.target === body
      && animation.effect.pseudoElement === '::before'
    );
    const transitions = [...new Set([root, panel, backdrop])]
      .flatMap(element => element.getAnimations()).concat(underlayTransitions)
      .filter(animation => animation instanceof CSSTransition);
    for (const transition of transitions) transition.pause();
    await Promise.all(transitions.map(transition => transition.ready));
    for (const transition of transitions) {
      transition.currentTime = Number(transition.effect!.getTiming().duration) * 0.45;
    }
    const rect = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, (Math.max(0, rect.top) + rect.bottom) / 2);
    return {
      panelOpacity: Number(getComputedStyle(panel).opacity) * Number(getComputedStyle(root).opacity),
      backdropOpacity: Number(getComputedStyle(backdrop).opacity),
      blur: getComputedStyle(backdrop).backdropFilter,
      backdropRoot: getComputedStyle(body).willChange,
      backdropUnderlayOpacity: Number(getComputedStyle(body, '::before').opacity),
      top: rect.top,
      bottom: rect.bottom,
      interceptsPointer: !!hit?.closest(selector)
    };
  }, sheet);
}

test('虚拟屏双页上的顶栏面板保持实底和磨砂，退场后释放合成层', async ({ appCtx }, info) => {
  test.setTimeout(45_000);
  const { win, app } = appCtx;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 960));
  await win.emulateMedia({ reducedMotion: 'no-preference' });
  await win.evaluate(async () => {
    const { workspaceId } = await window.api.workspaceFile.get();
    if (!workspaceId) throw new Error('No active test workspace');
    const layout = await window.api.workspaceFile.patch({
      hVirtualScreen: true, hTerminalRatio: 0.787, hDock: 'terminal', focusMode: false
    }, workspaceId);
    if (!layout.ok) throw new Error('Could not enable the virtual screen layout');
  });
  await win.reload();
  await expect(win.locator('.main-view.h-vs-on.h-terminal .browser-page')).toBeInViewport();
  const html = win.locator('html');
  await expect(html).toHaveAttribute('data-native-material', /^(vibrancy|mica|solid)$/);
  if (process.platform === 'darwin') await expect(html).toHaveAttribute('data-native-material', 'vibrancy');
  const backdropRoot = await html.getAttribute('data-native-material') === 'vibrancy' ? 'opacity' : 'auto';
  const blur = 'blur(16px) saturate(1.2)';
  const body = win.locator('body');
  const underlay = () => body.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { displayed: style.content !== 'none', opacity: Number(style.opacity) };
  });
  await expect(body).toHaveCSS('will-change', 'auto');
  await win.clock.install();
  const panels = [
    { name: 'monitor', overlay: '.process-monitor-overlay', sheet: '.process-monitor-sheet',
      open: () => win.locator('.chrome-process-monitor-btn').click() },
    { name: 'search', overlay: '.quick-open-mask', sheet: '.quick-open',
      open: () => win.locator('.chrome-search-btn').click() },
    { name: 'feedback', overlay: '.feedback-overlay', sheet: '.feedback-modal', open: async () => {
      await win.locator('.chrome-bar').getByRole('button', { name: /^(设置|Settings)$/ }).click();
      await win.locator('.settings-nav').getByRole('button', { name: /^(关于|About)$/ }).click();
      await win.locator('.feedback-settings-actions button').first().click();
    } },
    { name: 'board', overlay: '.g-board-overlay', sheet: '.g-board-sheet',
      open: () => win.locator('.chrome-gboard-btn').click() }
  ];

  for (const { name, overlay, sheet, open } of panels) {
    await test.step(name, async () => {
      await open();
      const panel = win.locator(sheet);
      await expect(panel).toHaveCSS('transform', 'none');
      await expect(win.locator(`${overlay} .mp-scrim-layer`)).toHaveCSS('backdrop-filter', blur);
      await expect(body).toHaveCSS('will-change', backdropRoot);
      await expect.poll(underlay).toEqual({ displayed: backdropRoot === 'opacity', opacity: 1 });
      const openTop = (await panel.boundingBox())!.y;
      await win.clock.pauseAt(await win.evaluate(() => Date.now()) + 200);
      try {
        const frame = await sampleExit(win, overlay, sheet);
        expect(frame.top).toBeLessThan(openTop);
        expect(frame.bottom).toBeGreaterThan(0);
        expect(frame.panelOpacity).toBe(1);
        expect(frame.backdropOpacity).toBeGreaterThan(0);
        expect(frame.backdropOpacity).toBeLessThan(1);
        expect(frame.blur).toBe(blur);
        expect(frame.backdropRoot).toBe(backdropRoot);
        if (backdropRoot === 'opacity') {
          expect(frame.backdropUnderlayOpacity).toBeCloseTo(frame.backdropOpacity);
        }
        expect(frame.interceptsPointer).toBe(false);
        await win.waitForTimeout(70); // Let the compositor paint the pinned frame.
        await win.screenshot({ path: info.outputPath(`${name}-closing.png`), animations: 'allow' });
      } finally {
        await win.clock.resume();
      }
      await expect(win.locator(`${overlay} .mp-scrim-layer`)).toHaveCount(0);
      await expect(body).toHaveCSS('will-change', 'auto');
      await expect.poll(underlay).toEqual({ displayed: false, opacity: 1 });
      if (name === 'feedback') {
        await win.locator('.settings-back').click();
        await expect(win.locator('.settings-page')).toBeHidden();
      }
    });
  }
});
