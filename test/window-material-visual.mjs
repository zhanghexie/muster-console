/**
 * Entire-frame Mica contract in Chromium with production layout CSS.
 * PNG alpha measures exposed native material: off = 0, on = 28% pure accent.
 * Reading cards/drawers stay opaque; this does not activate Electron/DWM.
 * Run: node test/window-material-visual.mjs
 * Negative controls: --baseline-double-overlay / --baseline-no-overlay
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { acquireTestLease } from './helpers/lease.mjs';
import { armProcessDeadline } from './helpers/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseLease = acquireTestLease(root);
const disarmDeadline = armProcessDeadline(Date.now() + 55_000, 'Whole-frame Mica pixel regression');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-material-'));
let browser;
try {
  const compile = createSharedCompiler(root, tmp);
  const { BUILTIN_THEMES } = await import(pathToFileURL(compile('shared/theme.ts')).href);
  const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
  const { WORKSPACE_ACCENTS } = await import(pathToFileURL(compile('shared/workspaceAccent.ts')).href);
  const { SOLID_LEVELS } = await import(pathToFileURL(compile('shared/frameBackdrop.ts')).href);
  assert.equal(SOLID_LEVELS.deep, 28, 'The approved native overlay uses the existing 28% setting');
  const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
  browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 });
  const grainRequests = [];
  page.on('request', request => {
    if (request.url().includes('frosted-grain.png')) grainRequests.push(request.url());
  });
  await page.route('https://www.oppo.com/**', route => route.abort());
  await page.route('http://material.test/**', route => route.abort());
  const cases = [
    { name: 'ordinary', workspace: 1200, git: 0, sidebar: 240, offset: 0 },
    { name: 'git-residual-sidebar', workspace: 1050, git: 480, sidebar: 480, offset: -330, dock: 'git' },
    { name: 'git-sidebar-offscreen', workspace: 1050, git: 800, sidebar: 240, offset: -650, dock: 'git' },
    { name: 'small-ratios-terminal-tail', workspace: 600, git: 480, sidebar: 240, offset: 0 },
    { name: 'small-ratios-git-leading-gap', workspace: 600, git: 480, sidebar: 240, offset: 120, dock: 'git' },
    { name: 'focus', workspace: 600, git: 600, sidebar: 240, offset: 0, focus: true },
    { name: 'left-resizing', workspace: 1200, git: 0, sidebar: 240, offset: 0, resizing: true },
    { name: 'virtual-screen-resizing', workspace: 1050, git: 800, sidebar: 240, offset: -650, reshaping: true, dock: 'git' },
    { name: 'folded', workspace: 1200, git: 0, sidebar: 240, offset: 0, folded: true },
    { name: 'folded-peek', workspace: 1200, git: 0, sidebar: 240, offset: 0, folded: true, peek: true },
    { name: 'narrow-left-drawer', workspace: 780, git: 0, sidebar: 240, offset: 0, narrow: true, width: 780 },
    { name: 'narrow-right-drawer', workspace: 780, git: 0, sidebar: 240, offset: 0, narrow: true, rightDrawer: true, width: 780 },
    { name: 'settings', workspace: 1200, git: 0, sidebar: 240, offset: 0, settings: true }
  ];
  let count = 0;
  for (const theme of BUILTIN_THEMES) for (const accent of [null, WORKSPACE_ACCENTS[0], WORKSPACE_ACCENTS[6]]) for (const scenario of cases) {
    const width = scenario.width ?? 1200;
    await page.setViewportSize({ width, height: 600 });
    await page.setContent(fixture(scenario, width));
    // Real ancestor positioning, clipping, visibility, cards and opacity.
    // Only leaf content and dimensions are fixture data.
    for (const file of ['base', 'chrome', 'left', 'side', 'agent-chat', 'float', 'responsive', 'settings', 'material']) {
      await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${file}.css`) });
    }
    if (process.argv.includes('--baseline-double-overlay')) {
      await page.addStyleTag({ content: "html[data-native-material='mica'] .main-view{background:var(--workspace-native-tint)}" });
    }
    if (process.argv.includes('--baseline-no-overlay')) {
      await page.addStyleTag({ content: "html[data-native-material='mica'] .app-shell{background:transparent}" });
    }
    const appearance = resolveAppearance(theme, { accent: accent ?? '#8b7bff', enabled: !!accent });
    await page.evaluate(({ theme, accent, narrow, cssVars }) => {
      const html = document.documentElement;
      html.dataset.nativeMaterial = 'mica';
      html.dataset.workspaceMaterial = accent ? 'frosted' : 'solid';
      html.dataset.theme = theme.appearance;
      html.classList.toggle('is-narrow', !!narrow);
      for (const [key, value] of Object.entries(cssVars)) html.style.setProperty(key, value);
    }, { theme, accent, narrow: scenario.narrow, cssVars: appearance.cssVars });
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().iterations))
        .map(animation => animation.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    const geometry = await page.evaluate(() => {
      const box = selector => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
        let effectiveOpacity = 1;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: Number(css.opacity),
          effectiveOpacity, visibility: css.visibility, pointerEvents: css.pointerEvents, transition: css.transitionProperty,
          radii: [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius] };
      };
      return {
        chrome: box('.chrome-bar'), view: box('.main-view'), strip: box('.h-strip'), center: box('.center-panel'), right: box('.side-tools-panel'),
        settings: box('.settings-sheet'), page: box('.terminal-page'), git: box('.git-page'), ghost: box('.nested-ghost'),
        underlay: box('.settings-underlay-marker'),
        surfaceImages: ['.app-shell', '.chrome-bar', '.main-view', '.ws-stage', '.git-page', '.settings-page',
          '.center-panel', '.side-tools-panel', '.settings-sheet', '.sessions-column .left-panel',
          '.chat-input-shell', '.agent-composer-qspanel'].flatMap(selector => {
          const el = document.querySelector(selector);
          if (!el) return [];
          const surfaces = [{ selector, image: getComputedStyle(el).backgroundImage }];
          if (selector === '.sessions-column .left-panel') {
            surfaces.push({ selector: selector + '::before', image: getComputedStyle(el, '::before').backgroundImage });
          }
          return surfaces;
        })
      };
    });
    const png = PNG.sync.read(await page.screenshot({ omitBackground: true }));
    const label = `${theme.id}/${accent ?? 'raw'}/${scenario.name}`;
    assert.equal(Math.round(geometry.view.y), 36, `${label}: production topbar geometry`);
    assert.equal(Math.round(geometry.view.height), 564, `${label}: main view geometry`);
    if (!scenario.narrow) assert.equal(Math.round(geometry.strip.x), scenario.offset + (scenario.peek ? scenario.sidebar : 0), `${label}: actual strip transform`);
    for (const surface of geometry.surfaceImages) assert.equal(surface.image, 'none', `${label}: ${surface.selector} has no background image`);
    assert.deepEqual(grainRequests, [], `${label}: removed grain asset is never requested`);
    if (scenario.resizing || scenario.reshaping) assert.equal(geometry.page.opacity, 1, `${label}: resizing cannot fade the center reading surface`);
    if (scenario.reshaping) assert.equal(geometry.git.opacity, 1, `${label}: resizing cannot fade the right reading surface`);

    if (scenario.settings) {
      assert.deepEqual(geometry.settings.radii, geometry.center.radii, `${label}: settings and session pages share one radius`);
      assert.deepEqual(geometry.settings.radii, Array(4).fill('4px'), `${label}: settings uses the inset Mica radius`);
      for (const [x, y] of [[100, 8], [100, 200], [100, 596], [106, 172]]) {
        framePixel(pixel(png, x, y), accent, `${label}: shared settings frame at ${x},${y}`);
      }
      for (const underlay of [geometry.chrome, geometry.view]) {
        assert.equal(underlay.opacity, 0, `${label}: settings hides each workbench parent`);
        assert.equal(underlay.pointerEvents, 'none', `${label}: parent pointer input is disabled`);
        assert.equal(underlay.transition, 'none', `${label}: underlay hides immediately`);
      }
      assert.equal(geometry.underlay.visibility, 'visible', `${label}: explicit-visible control remains meaningful`);
      assert.equal(geometry.underlay.opacity, 1, `${label}: descendant opacity is not rewritten`);
      assert.equal(geometry.underlay.effectiveOpacity, 0, `${label}: visible descendant cannot escape the parent opacity`);
      opaqueCard(png, geometry.settings, width, `${label}: settings reading card`);
      const lifecycle = await page.evaluate(() => {
        const shell = document.querySelector('.app-shell');
        const settings = document.querySelector('.settings-page');
        const parents = ['.chrome-bar', '.main-view'].map(selector => document.querySelector(selector));
        const retained = parents.map(parent => {
          const child = document.createElement('div');
          child.className = 'xfade is-shown';
          child.style.cssText = 'left:100px;top:100px;width:8px;height:8px;background:lime';
          parent.appendChild(child);
          return child;
        });
        // New page content and new live workbench descendants must not reveal
        // underlay text while settings remains mounted, including its exit.
        settings.appendChild(document.createElement('div'));
        // This fixture exercises production CSS only. Real inert ownership and
        // focus follow SettingsModal in component and Electron navigation tests.
        const opacity = () => parents.map(parent => Number(getComputedStyle(parent).opacity));
        const mounted = opacity();
        settings.remove();
        shell.classList.remove('has-settings-page');
        const unmounted = opacity();
        shell.appendChild(settings);
        shell.classList.add('has-settings-page');
        const reopened = opacity();
        return { mounted, unmounted, reopened,
          descendants: retained.map(child => ({ visibility: getComputedStyle(child).visibility, opacity: Number(getComputedStyle(child).opacity) })) };
      });
      assert.deepEqual(lifecycle, {
        mounted: [0, 0], unmounted: [1, 1], reopened: [0, 0],
        descendants: [{ visibility: 'visible', opacity: 1 }, { visibility: 'visible', opacity: 1 }]
      }, `${label}: parent compositing contains dynamic explicit-visible descendants and restores on unmount`);
    } else if (scenario.narrow) {
      // Shadows are legal surface decoration, so sample the bare band between
      // the open left drawer and offscreen right drawer for the frame contract.
      if (!scenario.rightDrawer) for (const y of [8, 40, 596]) {
        framePixel(pixel(png, Math.round((scenario.sidebar + width) / 2), y), accent, `${label}: bare narrow frame at y=${y}`);
      }
      const drawerX = scenario.rightDrawer ? width - 60 : 100;
      assert.equal(pixel(png, drawerX, 200)[3], 255, `${label}: drawer surface stays opaque`);
      if (scenario.rightDrawer) {
        assert.notDeepEqual(pixel(png, width - 60, 142).slice(0, 3), [255, 0, 255], `${label}: right drawer covers bright live underlay`);
      }
      opaqueCard(png, geometry.center, width, `${label}: narrow reading card`);
    } else {
      // Full-width exposed gutters catch solid top/bottom/backing, duplicated
      // overlays and small virtual-screen ratio gaps.
      for (let x = 2; x < width; x += 13) framePixel(pixel(png, x, 40), accent, `${label}: upper frame gutter x=${x}`);
      for (const x of [2, Math.floor(width / 2), width - 2]) {
        framePixel(pixel(png, x, 8), accent, `${label}: native topbar x=${x}`);
        framePixel(pixel(png, x, 596), accent, `${label}: native bottom frame x=${x}`);
      }
      opaqueCard(png, geometry.center, width, `${label}: center reading card`);
      opaqueCard(png, geometry.right, width, `${label}: right reading card`);
    }
    if (scenario.folded) {
      if (scenario.peek) assert.equal(geometry.ghost.visibility, 'visible', `${label}: retained sidebar content stays visible`);
      else {
        assert.equal(geometry.ghost.visibility, 'hidden', `${label}: folded explicit-visible descendants stop painting`);
        framePixel(pixel(png, 6, 42), accent, `${label}: closed sidebar does not leak through the frame`);
      }
    }
    count++;
  }
  console.log(`window-material-visual: OK (${count} whole-frame raw/tinted dark/light pixel cases, opaque cards/drawers, resize, peek, settings underlay)`);
} finally {
  try { await browser?.close(); }
  finally {
    assert.ok(tmp.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(tmp).startsWith('window-material-'));
    fs.rmSync(tmp, { recursive: true, force: true });
    disarmDeadline();
    releaseLease();
  }
}

function fixture(scenario, width) {
  const flow = !scenario.folded && !scenario.narrow;
  const sidebarWidth = flow ? scenario.sidebar : 0;
  const classNames = ['main-view', scenario.git ? 'h-vs-on' : 'h-vs-off', `h-${scenario.dock ?? 'terminal'}`,
    scenario.focus ? 'is-focus' : '', scenario.folded && !scenario.peek ? 'sessions-hidden' : '',
    scenario.peek ? 'sessions-peek' : '', scenario.resizing ? 'is-left-resizing' : '', scenario.reshaping ? 'is-reshaping' : ''].filter(Boolean).join(' ');
  const ghost = '<div class="xfade is-shown nested-ghost" style="position:absolute;left:4px;top:4px;width:8px;height:8px;background:lime"></div>';
  const left = `<div class="left-panel">${scenario.folded ? ghost : ''}</div>`;
  // Leave observable frame gutters; background/visibility/opacity are real CSS.
  const cardGeometry = 'width:calc(100% - 32px);height:calc(100% - 32px);margin:16px';
  return `<base href="http://material.test/"><div id="root"><div class="app-shell${scenario.settings ? ' has-settings-page' : ''}"><div class="chrome-bar"></div>
    <div class="${classNames}" style="--sessions-col-w:${scenario.sidebar}px">
      <div class="ws-stage"><div class="ws-rail ws-rail-idle"><div class="ws-pane ws-pane-live">
        <div class="work-area" style="width:${width}px">
          <div class="h-strip${scenario.git ? ' vs-axis' : ''}" style="width:${Math.max(scenario.workspace + scenario.git, width)}px;transform:translate3d(${scenario.offset}px,0,0)">
            <div class="h-page workspace-page" style="width:${scenario.workspace}px">
              ${flow || scenario.narrow ? `<div class="sessions-column${scenario.narrow && !scenario.rightDrawer ? ' is-drawer-open' : ''}" style="width:${scenario.sidebar}px">${left}</div>` : ''}
              <div class="terminal-page" style="width:${Math.max(scenario.workspace - sidebarWidth, 1)}px">
                <div class="center-panel" style="${cardGeometry}">
                  <div class="chat-input-shell" style="position:absolute;left:16px;bottom:16px;width:120px;height:24px"></div>
                  <div class="agent-composer-qspanel" style="position:absolute;right:16px;bottom:16px;width:120px;height:24px"></div>
                </div>
              </div>
            </div>
            <div class="h-page git-page${scenario.rightDrawer ? ' is-drawer-open' : ''}" style="width:${scenario.git}px"><div class="side-tools-panel" style="${cardGeometry}"></div></div>
          </div>
        </div>
      </div></div></div>
      ${scenario.folded ? `<div class="sessions-float${scenario.peek ? ' is-open is-retained' : ''}" style="width:${scenario.sidebar}px">${left}</div>` : ''}
      ${scenario.settings ? '<div class="xfade is-shown settings-underlay-marker" style="position:absolute;left:100px;top:130px;width:12px;height:12px;background:lime"></div>' : ''}
      ${scenario.rightDrawer ? `<div style="position:absolute;left:${width - 66}px;top:100px;width:16px;height:16px;background:magenta;z-index:2"></div>` : ''}
    </div>
    ${scenario.settings ? '<div class="settings-page"><div class="settings-nav"></div><div class="settings-sheet"></div></div>' : ''}
  </div></div>`;
}
function pixel(png, x, y) {
  const offset = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return Array.from(png.data.subarray(offset, offset + 4));
}
function framePixel(rgba, accent, message) {
  const alpha = accent ? Math.round(255 * .28) : 0;
  assert.ok(Math.abs(rgba[3] - alpha) <= 1, `${message}: expected one overlay alpha ${alpha}, got ${rgba}`);
  if (accent) {
    const expected = accent.slice(1).match(/../g).map(value => parseInt(value, 16));
    assert.ok(expected.every((value, index) => Math.abs(value - rgba[index]) <= 3), `${message}: overlay must be pure ${accent}, got ${rgba}`);
  }
}
function opaqueCard(png, box, width, message) {
  if (!box || box.width < 40 || box.visibility === 'hidden') return;
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  if (x >= 0 && x < width) assert.equal(pixel(png, x, y)[3], 255, `${message}: alpha remains 255`);
}
