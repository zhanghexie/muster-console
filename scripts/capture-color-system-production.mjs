/**
 * Current built production app only: isolated data/cwd, real IPC, CM, Git and PTY.
 * Run after npm run build: node scripts/capture-color-system-production.mjs
 * Optional: --no-native (skip desktop composition), --no-settings (targeted rerun).
 * This script never adds styles or changes/fixes colors for a screenshot.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const project = path.resolve(import.meta.dirname, '..');
const captures = path.join(project, 'output/color-system-production');
await fs.mkdir(path.join(project, '.tmp'), { recursive: true });
await fs.mkdir(captures, { recursive: true });
const run = await fs.mkdtemp(path.join(project, '.tmp/color-production-'));
const userData = path.join(run, '.dev-sandbox/userData');
const workspace = path.join(run, 'workspace');
const workspaceId = 'color-production';
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
const report = {
  source: 'current built production Electron app; no injected CSS, prototypes, color freezing or UI copies',
  startedAt: new Date().toISOString(), run, userData, workspace, visualReview: 'pending',
  framing: 'app PNG is Chromium/capturePage composition, including native transparent-frame alpha; it cannot prove DWM Mica appearance',
  fixture: 'local Git repository, two empty GUI sessions with fixture transcript events, one real PowerShell PTY; no model request is sent',
  views: [], checks: [], ledger: [], native: [], errors: [], errorStacks: [], consoleErrors: [], failedRequests: [], unverified: [],
  terminalBoundary: 'ANSI identities and explicit cell backgrounds are preserved. Light theme uses the official DOM renderer with the production foreground-only DIM contrast guard; real default DIM cells are checked at >=4.5:1. Dark theme keeps official WebGL DIM behavior and receives screenshot review. This capture does not benchmark renderer performance.'
};
let app, page, ownedProcess, ownedPid, browserFixtureServer, browserFixtureOrigin, expired = false, closing = false;
const deadline = Date.now() + 170_000;
const killOwned = () => {
  if (!ownedPid || !ownedProcess || ownedProcess.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(ownedPid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(ownedPid, 'SIGKILL');
  } catch {}
};
const watchdog = setTimeout(() => { expired = true; killOwned(); }, 170_000);
watchdog.unref();
const cleanup = async () => {
  if (closing) return;
  closing = true; clearTimeout(watchdog);
  if (app) {
    // Kill only this isolated app's owned process tree before the parent disappears,
    // so real PTY descendants cannot become orphaned after app.exit/close-to-tray.
    killOwned();
    let timer;
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 4_000); })]);
    clearTimeout(timer); killOwned();
  }
  if (browserFixtureServer) {
    browserFixtureServer.closeAllConnections();
    await new Promise(resolve => browserFixtureServer.close(resolve));
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
const bounded = () => { assert.ok(!expired && Date.now() < deadline, 'Production capture exceeded its bounded runtime; verification incomplete'); };
const waitUntil = async (predicate, label, budget = 8_000) => {
  const end = Math.min(deadline, Date.now() + budget);
  while (Date.now() < end) {
    bounded(); if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}`);
};
const settle = async () => {
  bounded();
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) { try { animation.finish(); } catch {} }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
};

// Read every visible host control's real computed styles. Native transparent stacks
// are explicitly unresolved rather than composited over an invented background.
const colors = () => page.evaluate(() => {
  const root = document.documentElement, variables = getComputedStyle(root);
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.closest('[aria-hidden="true"]');
  };
  const read = element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const backgrounds = []; let ancestor = element;
    while (ancestor) {
      const value = getComputedStyle(ancestor).backgroundColor; backgrounds.push(value);
      if (/^rgb\(/.test(value) || /^rgba\([^,]+,[^,]+,[^,]+,\s*1\)$/.test(value)) break;
      ancestor = ancestor.parentElement;
    }
    return { tag: element.tagName, class: typeof element.className === 'string' ? element.className : element.className.baseVal,
      label: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('placeholder') || '').trim().slice(0, 90),
      color: style.color, background: style.backgroundColor, backgrounds, nativeCompositeUnknown: !ancestor,
      border: { top: [style.borderTopWidth, style.borderTopStyle, style.borderTopColor], bottom: [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor], left: [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor], right: [style.borderRightWidth, style.borderRightStyle, style.borderRightColor] },
      shadow: style.boxShadow, opacity: style.opacity, containsFocus: element.contains(document.activeElement), font: [style.fontFamily, style.fontSize, style.fontWeight],
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, disabled: !!element.disabled,
      selected: element.getAttribute('aria-selected'), revision: element.dataset.appearanceRevision };
  };
  const surfaces = {};
  for (const selector of ['.app-shell', '.chrome-bar', '.center-panel', '.right-workspace', '.right-tabs-row', '.right-current-row', '.right-resources', '.right-tab.is-selected', '.right-content-page.is-shown .cm-editor', '.right-content-page.is-shown .cm-gutters', '.right-content-page.is-shown .git-diff-scroll', '.right-browser-location', '.right-bookmarks', '.chat-input-shell', '.settings-nav', '.settings-sheet', '.memory-panel', '.usage-panel', '.ext-manager-panel', '.center-utility-layer:not([aria-hidden="true"])', '.g-board-sheet.is-open', '.terminal-wrap.is-shown', '.terminal-wrap.is-shown .terminal-container', '.terminal-wrap.is-shown .xterm-screen']) {
    const element = [...document.querySelectorAll(selector)].find(visible); if (element) surfaces[selector] = read(element);
  }
  const tokens = {};
  for (const role of ['surface-frame', 'surface-canvas', 'surface-chrome', 'surface-raised', 'surface-input', 'surface-overlay', 'selected-tab', 'fg-primary', 'fg-secondary', 'fg-muted', 'fg-selected-primary', 'border-control', 'border-focus', 'identity-surface', 'identity-fg', 'ws-accent', 'workspace-native-tint']) tokens[`--${role}`] = variables.getPropertyValue(`--${role}`).trim();
  const controls = [...document.querySelectorAll('button,input,textarea,select,[role="tab"],[role="option"],.s-row-d,.chat-msg-text,.chat-msg-avatar,.session-status-pill,.status-badge')].filter(visible).slice(0, 450).map(read);
  const avatars = [...document.querySelectorAll('.chat-msg-avatar:not([data-avatar-omitted="1"])')].filter(visible).map(element => ({ sender: element.dataset.avatarSender, face: element.dataset.avatarFace, ...read(element) }));
  return { theme: root.dataset.theme, material: root.dataset.workspaceMaterial, native: root.dataset.nativeMaterial, revision: root.dataset.appearanceRevision,
    active: document.activeElement?.className, tokens, surfaces, controls, avatars,
    fonts: [...document.fonts].map(font => ({ family: font.family, weight: font.weight, status: font.status })),
    viewport: { width: innerWidth, height: innerHeight }, injectedStyleEvidence: [...document.querySelectorAll('style')].filter(style => /color-study|study-reading|data-color-capture/.test(style.textContent || '')).length };
});

const capture = async name => {
  await page.mouse.move(1, 1); await settle();
  const ledger = await colors();
  assert.equal(ledger.injectedStyleEvidence, 0, 'No study/frozen colors in the production document');
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  const image = Buffer.from(png, 'base64');
  await fs.writeFile(path.join(captures, `${name}.png`), image);
  report.views.push({ name, theme: ledger.theme, material: ledger.material, revision: ledger.revision, width: image.readUInt32BE(16), height: image.readUInt32BE(20) });
  report.ledger.push({ name, ...ledger });
  console.log(`Captured ${name}`);
  return { ledger, png };
};

const nativeCapture = async (name, appCapture) => {
  if (process.platform !== 'win32' || process.argv.includes('--no-native') || appCapture.ledger.native !== 'mica') return;
  await page.bringToFront();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.moveTop(); win.focus(); });
  await new Promise(resolve => setTimeout(resolve, 450));
  const actual = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen, nativeImage }, expected) => {
    const win = BrowserWindow.getAllWindows()[0], bounds = win.getContentBounds(), display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
    const source = sources.find(source => source.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('No real desktop composition thumbnail');
    const size = source.thumbnail.getSize(), sx = size.width / display.size.width, sy = size.height / display.size.height;
    const image = source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x) * sx), y: Math.round((bounds.y - display.bounds.y) * sy), width: Math.round(bounds.width * sx), height: Math.round(bounds.height * sy) });
    const bitmap = image.toBitmap(), dimensions = image.getSize();
    const reference = nativeImage.createFromBuffer(Buffer.from(expected.png, 'base64')), referenceSize = reference.getSize(), referenceBitmap = reference.toBitmap();
    let edges = 0, sampled = 0, mismatched = 0;
    for (let y = 4; y < dimensions.height - 4; y += 2) for (let x = 4; x < dimensions.width - 4; x += 2) {
      const at = (y * dimensions.width + x) * 4;
      if (Math.abs(bitmap[at] - bitmap[at + 4]) + Math.abs(bitmap[at + 1] - bitmap[at + 5]) + Math.abs(bitmap[at + 2] - bitmap[at + 6]) > 100) edges++;
    }
    // Compare only opaque host content. DWM frame colors are deliberately excluded.
    for (const selector of ['.center-panel', '.right-content-page.is-shown .cm-editor']) {
      const box = expected.surfaces[selector]?.box; if (!box) continue;
      for (let y = box.y + 12; y < box.y + box.height - 12; y += 7) for (let x = box.x + 12; x < box.x + box.width - 12; x += 7) {
        const rx = Math.min(referenceSize.width - 1, Math.max(0, Math.round(x))), ry = Math.min(referenceSize.height - 1, Math.max(0, Math.round(y)));
        const nx = Math.min(dimensions.width - 1, Math.max(0, Math.round(x * dimensions.width / referenceSize.width))), ny = Math.min(dimensions.height - 1, Math.max(0, Math.round(y * dimensions.height / referenceSize.height)));
        const ra = (ry * referenceSize.width + rx) * 4, na = (ny * dimensions.width + nx) * 4;
        if (referenceBitmap[ra + 3] < 250) continue;
        sampled++; if (Math.max(...[0, 1, 2].map(channel => Math.abs(referenceBitmap[ra + channel] - bitmap[na + channel]))) > 45) mismatched++;
      }
    }
    return { png: image.toPNG().toString('base64'), edges, sampled, mismatchRatio: sampled ? mismatched / sampled : null, bounds, dimensions };
  }, { png: appCapture.png, surfaces: appCapture.ledger.surfaces });
  await fs.writeFile(path.join(captures, `${name}-desktop.png`), Buffer.from(actual.png, 'base64'));
  const pollutionSuspected = actual.edges < 150 || actual.sampled < 20 || actual.mismatchRatio > .15;
  report.native.push({ name, ...actual, png: undefined, pollutionSuspected, visualReview: 'pending', acceptedAsMicaAppearance: false });
  if (pollutionSuspected) report.unverified.push(`${name}: native screenshot may contain unrelated overlay/misaligned capture; manual review required`);
};

const composerEdges = async (name, snapshot, focused) => {
  const shell = snapshot.ledger.surfaces['.chat-input-shell'];
  assert.ok(shell, 'Visible Composer shell exists');
  assert.equal(shell.containsFocus, focused, `${name}: Composer focus state matches the requested capture`);
  for (const [side, border] of Object.entries(shell.border)) {
    assert.equal(border[1], 'solid', `${side} Composer border is solid`);
    assert.ok(parseFloat(border[0]) > 0, `${side} Composer border exists`);
    assert.equal(border[2], shell.border.top[2], 'Composer border colors match on all four sides');
  }
  const pixelEdges = await app.evaluate(({ nativeImage }, { png, box, border, background, viewport }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64')), size = image.getSize(), bytes = image.toBitmap();
    const rgb = border.match(/[\d.]+/g).slice(0, 3).map(Number), bg = background.match(/[\d.]+/g).slice(0, 3).map(Number);
    const sx = size.width / viewport.width, sy = size.height / viewport.height;
    const sample = (x, y, axis) => {
      const candidates = [];
      for (let delta = -1; delta <= 1; delta++) {
        const row = Math.min(size.height - 1, Math.max(0, Math.round(y * sy) + (axis === 'y' ? delta : 0)));
        const col = Math.min(size.width - 1, Math.max(0, Math.round(x * sx) + (axis === 'x' ? delta : 0))), at = (row * size.width + col) * 4;
        const value = [bytes[at + 2], bytes[at + 1], bytes[at]];
        candidates.push({ value, alpha: bytes[at + 3], difference: Math.max(...value.map((channel, index) => Math.abs(channel - rgb[index]))), backgroundDifference: Math.max(...value.map((channel, index) => Math.abs(channel - bg[index]))) });
      }
      return candidates.sort((a, b) => a.difference - b.difference)[0];
    };
    const fractions = [.25, .5, .75];
    return { expectedBorderToBackground: Math.max(...rgb.map((value, index) => Math.abs(value - bg[index]))),
      top: fractions.map(f => sample(box.x + box.width * f, box.y, 'y')),
      bottom: fractions.map(f => sample(box.x + box.width * f, box.y + box.height - 1, 'y')),
      left: fractions.map(f => sample(box.x, box.y + box.height * f, 'x')),
      right: fractions.map(f => sample(box.x + box.width - 1, box.y + box.height * f, 'x')) };
  }, { png: snapshot.png, box: shell.box, border: shell.border.top[2], background: shell.background, viewport: snapshot.ledger.viewport });
  report.checks.push({ name, kind: 'composer-four-painted-edges', focused, css: shell.border, pixels: pixelEdges });
  for (const side of ['top', 'bottom', 'left', 'right']) assert.ok(pixelEdges[side].every(pixel => pixel.alpha >= 250 && pixel.difference <= 35 && pixel.backgroundDifference >= pixelEdges.expectedBorderToBackground * .35), `${name}: ${side} edge must be visibly painted, rather than only matching the input background`);
};

const terminalDefaultPixels = async (name, snapshot, canvasColor) => {
  const screen = snapshot.ledger.surfaces['.terminal-wrap.is-shown .xterm-screen'];
  assert.ok(screen, 'Real mounted xterm grid exists');
  const pixels = await app.evaluate(({ nativeImage }, { png, box, color, viewport }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64')), size = image.getSize(), bytes = image.toBitmap();
    const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number), points = [];
    for (const fy of [.15, .35, .55, .75, .9]) for (const fx of [.9, .98]) {
      const x = Math.min(size.width - 1, Math.max(0, Math.round((box.x + box.width * fx) * size.width / viewport.width)));
      const y = Math.min(size.height - 1, Math.max(0, Math.round((box.y + box.height * fy) * size.height / viewport.height))), at = (y * size.width + x) * 4;
      const value = [bytes[at + 2], bytes[at + 1], bytes[at]];
      points.push({ x, y, value, alpha: bytes[at + 3], difference: Math.max(...value.map((channel, index) => Math.abs(channel - rgb[index]))) });
    }
    return points;
  }, { png: snapshot.png, box: screen.box, color: canvasColor, viewport: snapshot.ledger.viewport });
  report.checks.push({ name, kind: 'real-xterm-grid-default-pixels', expected: canvasColor, pixels });
  assert.ok(pixels.filter(pixel => pixel.alpha >= 250 && pixel.difference <= 3).length >= 2, `${name}: actual xterm grid must paint default cells with the production canvas, beyond matching wrapper CSS`);
};

const newestProductionSource = async directory => {
  const timestamps = await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(async entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? newestProductionSource(file) : /\.(tsx?|css|html|json)$/.test(entry.name) ? (await fs.stat(file)).mtimeMs : 0;
  }));
  return Math.max(0, ...timestamps);
};

const saveReport = async () => {
  report.completedAt = new Date().toISOString(); report.elapsedMs = Date.now() - Date.parse(report.startedAt);
  await fs.writeFile(path.join(captures, 'verification.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(captures, 'review.md'), '# Production color capture\n\nVisual review: pending.\n\nOpen the PNGs listed in verification.json before recording visual acceptance. App capturePage images preserve native transparent-frame boundaries and do not prove DWM appearance. Desktop images have a contamination ledger and require separate inspection. No CSS is injected by this script.\n');
};

try {
  // Preserve the confirmed normal-close failure before this run replaces verification.json.
  // A retained-guest color run must never silently turn the previous lifecycle failure into a pass.
  let previousCapture;
  try { previousCapture = JSON.parse(await fs.readFile(path.join(captures, 'verification.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previousCapture?.status === 'failed or incomplete' && !/Real rendered light DIM cell repaired to readable contrast|Invalid guestInstanceId/.test(previousCapture.failure ?? '')) {
    const evidenceName = `capture-failure-${previousCapture.startedAt.replace(/[^a-zA-Z0-9-]/g, '-')}`;
    await fs.copyFile(path.join(captures, 'verification.json'), path.join(captures, `${evidenceName}.json`));
    try { await fs.copyFile(path.join(captures, 'failure.png'), path.join(captures, `${evidenceName}.png`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    report.previousCaptureFailure = { observedAt: previousCapture.startedAt, evidence: path.join(captures, `${evidenceName}.json`) };
  }
  if (/Real rendered light DIM cell repaired to readable contrast/.test(previousCapture?.failure ?? '')) {
    const evidenceName = `terminal-dim-capture-failure-${previousCapture.startedAt.replace(/[^a-zA-Z0-9-]/g, '-')}`;
    await fs.copyFile(path.join(captures, 'verification.json'), path.join(captures, `${evidenceName}.json`));
    try { await fs.copyFile(path.join(captures, 'failure.png'), path.join(captures, `${evidenceName}.png`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    report.previousDimCaptureFailure = { observedAt: previousCapture.startedAt, evidence: path.join(captures, `${evidenceName}.json`), cause: 'Full DIM sentence was required inside a single DOM span, but the actual 517px terminal wrapped it into two rows. Previous contrast values were not recorded; this run verifies every fragment and retains complete DIM diagnostics.' };
  }
  if (previousCapture?.errorStacks?.some(error => /Invalid guestInstanceId/.test(error.message) && error.phase === 'capture')) {
    const evidenceFile = `browser-close-lifecycle-failure-${previousCapture.startedAt.replace(/[^a-zA-Z0-9-]/g, '-')}.json`;
    await fs.copyFile(path.join(captures, 'verification.json'), path.join(captures, evidenceFile));
    report.browserCloseLifecycle = { status: 'FAILED in prior actual UI close; not exercised as passing by this retained-guest color run', observedAt: previousCapture.startedAt, evidence: path.join(captures, evidenceFile) };
  } else if (previousCapture?.browserCloseLifecycle?.evidence) {
    report.browserCloseLifecycle = previousCapture.browserCloseLifecycle;
  } else {
    report.browserCloseLifecycle = { status: 'FAILED in prior production batch 2026-10-09T11:20; this retained-guest color run does not claim a close pass', evidence: 'root-reviewed Electron WebViewElement.disconnectedCallback Invalid guestInstanceId stack' };
  }
  report.unverified.push(`FAILED browser-close lifecycle: ${report.browserCloseLifecycle.status}. ${report.browserCloseLifecycle.evidence}. This run keeps one actual guest alive and switches its URL/theme; all current pageErrors still remain recorded.`);
  // Refuse a known stale renderer build; never build behind the caller's back.
  const main = path.join(project, 'out/main/index.js');
  const rendererAssets = path.join(project, 'out/renderer/assets');
  const assets = (await fs.readdir(rendererAssets)).filter(file => /\.(js|css)$/.test(file));
  const builtAt = Math.max(...await Promise.all(assets.map(async file => (await fs.stat(path.join(rendererAssets, file))).mtimeMs)));
  const [rendererSourceAt, mainSourceAt, sharedSourceAt] = await Promise.all(['src/renderer', 'src/main', 'src/shared'].map(directory => newestProductionSource(path.join(project, directory))));
  const sourceAt = Math.max(rendererSourceAt, sharedSourceAt), mainBuiltAt = (await fs.stat(main)).mtimeMs;
  assert.ok(builtAt >= sourceAt, 'Renderer build is stale. Run npm run build before production capture.');
  assert.ok(mainBuiltAt >= Math.max(mainSourceAt, sharedSourceAt), 'Main build is stale. Run npm run build before production capture.');
  report.build = { main, mainModifiedAt: new Date(mainBuiltAt).toISOString(), rendererBuiltAt: new Date(builtAt).toISOString(), latestRendererSourceAt: new Date(sourceAt).toISOString(), latestMainSourceAt: new Date(Math.max(mainSourceAt, sharedSourceAt)).toISOString() };
  await fs.writeFile(path.join(workspace, 'review.ts'), 'export const phase = "ready";\nexport const tabs = ["files", "git", "browser"];\n\nexport function review() {\n  return tabs.map(tab => ({ tab, ready: true }));\n}\n');
  await fs.writeFile(path.join(workspace, 'design.md'), '# 配色验证\n\n生产组件、真实文件和同一份配色快照。\n');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: workspace, stdio: 'pipe' });
  git('init'); git('add', '.'); git('-c', 'user.name=Color fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'Production color fixture');
  await fs.appendFile(path.join(workspace, 'review.ts'), '\n// Review draft: one resolved palette for all host surfaces.\n');
  // Author content only: a loopback page with browser-default styling, no copied host UI/CSS.
  browserFixtureServer = createServer((request, response) => {
    const title = request.url.startsWith('/reference') ? '本机参考页' : '本机内容页';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>这是隔离的网页内容夹具。浏览器地址、标签和收藏夹使用正式应用界面；本页未注入任何样式。</p></body></html>`);
  });
  await new Promise((resolve, reject) => { browserFixtureServer.once('error', reject); browserFixtureServer.listen(0, '127.0.0.1', resolve); });
  browserFixtureOrigin = `http://127.0.0.1:${browserFixtureServer.address().port}`;
  report.browserFixture = { origin: browserFixtureOrigin, authorContentOnly: true, styleInjection: false, externalRequests: false };
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', uiFont: 'oppo', themeId: 'dark', activeWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, name: '配色系统·生产验证', path: workspace, accent: '#8b7bff', accentOff: true }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  await fs.writeFile(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `color-production-${process.pid}` };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_DEV_MOBILE_WS', 'MUSTER_HOST', 'MUSTER_STATUS_URL']) delete env[key];
  // Exactly the pre-existing isolated-fixture guard: disable the external lark adapter,
  // never replace application APIs, component output or colors.
  const cliOff = path.join(run, 'lark-off.cjs'), bootstrap = path.join(run, 'bootstrap.cjs');
  await fs.writeFile(cliOff, 'process.stdout.write(JSON.stringify({ok:false,error:{message:"Disabled in production visual fixture"}}));process.exitCode=1;');
  await fs.writeFile(bootstrap, `const cp=require('node:child_process');const p=require('node:path');const original=cp.spawn;cp.spawn=function(file,args,options){if(p.basename(String(file)).toLowerCase()==='lark-cli.exe'){return original(process.execPath,[${JSON.stringify(cliOff)}],{...options,env:{...options?.env,ELECTRON_RUN_AS_NODE:'1'}});}return original(file,args,options);};require(${JSON.stringify(main)});`);
  app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--force-device-scale-factor=1', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd: run, env, timeout: 30_000 });
  ownedProcess = app.process(); ownedPid = ownedProcess.pid;
  page = await app.firstWindow(); page.setDefaultTimeout(9_000);
  page.on('pageerror', error => {
    report.errors.push(error.message);
    report.errorStacks.push({ message: error.message, stack: error.stack, at: new Date().toISOString(), phase: closing ? 'cleanup' : 'capture', lastCapture: report.views.at(-1)?.name });
  });
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await app.evaluate(({ BrowserWindow, screen }) => { const win = BrowserWindow.getAllWindows()[0], area = screen.getDisplayMatching(win.getBounds()).workArea; win.webContents.setBackgroundThrottling(false); win.setBounds({ x: area.x + 20, y: area.y + 20, width: Math.min(1440, area.width - 40), height: Math.min(900, area.height - 40) }); win.showInactive(); });
  await page.locator('.app-shell').waitFor({ timeout: 30_000 });
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userData), 'Actual application data must be isolated');
  await page.evaluate(({ workspaceId }) => window.api.workspaceFile.patch({ hVirtualScreen: true, hDock: 'git', hTerminalRatio: .5, hGitRatio: .5, focusMode: false, leftColumnWidth: 240 }, workspaceId), { workspaceId });
  await page.reload(); await page.locator('.app-shell').waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const ids = await page.evaluate(async ({ cwd, workspaceId }) => {
    const request = { runtime: 'pi', force: true, guiMode: 'auto', cwd, workspaceId };
    const one = await window.api.sessions.create({ ...request, name: '代码审核' }), two = await window.api.sessions.create({ ...request, name: '界面开发' });
    return [one.id, two.id];
  }, { cwd: workspace, workspaceId });
  // Session creation publishes a real full-session refresh. Finish all three before
  // the renderer-only transcript fixture, so empty authoritative GUI history cannot replace it.
  const terminal = await page.evaluate(({ cwd, workspaceId }) => window.api.sessions.create({ name: '真实 PowerShell ANSI 验证', shellProfileId: 'powershell', cwd, workspaceId }), { cwd: workspace, workspaceId });
  await page.evaluate(id => window.api.sessions.select(id), ids[0]); await page.keyboard.press('Escape');
  await page.locator('.composer-editable:visible').first().waitFor();
  const pane = page.locator('.right-workspace');
  if (!await pane.isVisible()) await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
  await pane.waitFor();
  const syncFixtureTranscript = async () => {
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send('agentSession:event', payload), { kind: 'sync', sessionId: ids[0], messages: [
    { id: 'fixture-user', role: 'user', ts: Date.now() - 90000, parts: [{ kind: 'text', text: '查看真实多标签、文件编辑、Git diff 和输入框配色。' }] },
    { id: 'fixture-worker', role: 'assistant', ts: Date.now() - 60000, parts: [{ kind: 'text', text: '这是生产组件的隔离视觉夹具。\n\n- 默认头像保持中性。\n- 所有宿主内容面使用同一配色版本。\n- 深浅主题与工作区颜色都从正式入口切换。\n\n```tsx\n<RightWorkspace>\n  <TabStrip />\n  <ContentToolbar />\n</RightWorkspace>\n```' }] }
    ] });
    await page.getByText('查看真实多标签、文件编辑、Git diff 和输入框配色。', { exact: true }).waitFor();
    await page.getByText('这是生产组件的隔离视觉夹具。', { exact: false }).waitFor();
    await page.locator('.chat-msg-avatar[data-avatar-sender="user"]:visible').first().waitFor();
    await page.locator('.chat-msg-avatar[data-avatar-sender="assistant"]:visible').first().waitFor();
  };
  await syncFixtureTranscript();
  const capsule = pane.getByRole('tablist', { name: '资源面板' });
  // title is the precise existing FileTree identity, independent of tree glyph text.
  const file = name => pane.locator(`.right-resource-page.is-shown .file-tree-row[title="${name}"]`);
  await capsule.getByRole('tab', { name: '文件', exact: true }).click();
  await file('design.md').dblclick(); await file('review.ts').dblclick();
  await pane.getByRole('button', { name: '编辑', exact: true }).click();
  await pane.locator('.right-content-page.is-shown .cm-content').waitFor();
  assert.ok(await pane.locator('.right-tab').count() >= 2, 'Two real content tabs are open');
  const avatarsByTheme = new Map();
  let browserFixtureTab, browserFixtureGuestId, browserBookmarkFixture;
  await page.evaluate(id => window.api.sessions.select(id), ids[0]);
  for (const theme of ['dark', 'light']) for (const enabled of [false, true]) {
    bounded(); const state = `${theme}-${enabled ? 'accent' : 'neutral'}`;
    await page.evaluate(async ({ theme, enabled, workspaceId }) => { await window.api.themes.activate(theme); await window.api.workspaces.update(workspaceId, { accent: '#8b7bff', accentOff: !enabled }); }, { theme, enabled, workspaceId });
    await page.waitForFunction(({ theme, enabled }) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.workspaceMaterial === (enabled ? 'frosted' : 'solid') && getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim() === (enabled ? '#8b7bff' : '#8e8e96'), { theme, enabled });
    await page.evaluate(id => window.api.sessions.select(id), ids[0]);
    await page.evaluate(workspaceId => window.api.workspaceFile.patch({ hDock: 'git' }, workspaceId), workspaceId);
    await pane.locator('.right-tab').filter({ hasText: 'review.ts' }).first().click();
    await syncFixtureTranscript();
    const composer = page.locator('.composer-editable:visible').first();
    await composer.fill(''); await composer.focus();
    const empty = await capture(`${state}-workbench-empty-focus`); await composerEdges(`${state}-empty-focus`, empty, true);
    report.checks.push({ name: state, kind: 'active-workspace-appearance-via-real-ipc', revision: empty.ledger.revision, material: empty.ledger.material, tokens: empty.ledger.tokens });
    const selected = empty.ledger.surfaces['.right-tab.is-selected'], chrome = empty.ledger.surfaces['.right-tabs-row'];
    assert.ok(selected && chrome && selected.background !== chrome.background, 'Selected tab has its own visible surface');
    const channels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    assert.ok(Math.max(...channels(selected.background).map((value, index) => Math.abs(value - channels(chrome.background)[index]))) >= 8, 'Tab/chrome separation is at least 8 sRGB steps');
    const avatars = empty.ledger.avatars.map(({ sender, face, color, background }) => ({ sender, face, color, background }));
    assert.ok(avatars.length >= 2, 'User and Worker default avatar faces are visible');
    if (!enabled) avatarsByTheme.set(theme, avatars); else assert.deepEqual(avatars, avatarsByTheme.get(theme), 'Default avatars keep stable identity under project tint');
    await nativeCapture(state, empty);
    await pane.locator('.right-tab').filter({ hasText: 'review.ts' }).first().click();
    const emptyBlur = await capture(`${state}-workbench-empty-blur`); await composerEdges(`${state}-empty-blur`, emptyBlur, false);
    await composer.fill('聚焦输入的上边框与下边框都应完整，文字和图标清楚。');
    await composer.focus();
    const filled = await capture(`${state}-workbench-filled-focus`); await composerEdges(`${state}-filled-focus`, filled, true);
    await pane.locator('.right-tab').filter({ hasText: 'review.ts' }).first().click();
    const filledBlur = await capture(`${state}-workbench-filled-blur`); await composerEdges(`${state}-filled-blur`, filledBlur, false);
    const composerStates = [empty, emptyBlur, filled, filledBlur].map(snapshot => snapshot.ledger.surfaces['.chat-input-shell']);
    assert.ok(composerStates.every(shell => shell.background === composerStates[0].background), 'Empty/filled and focused/blurred Composer states preserve the same material');
    assert.deepEqual(emptyBlur.ledger.surfaces['.chat-input-shell'].border, filledBlur.ledger.surfaces['.chat-input-shell'].border, 'Typing must not remove or alter any blurred Composer edge');
    report.checks.push({ name: state, kind: 'composer-four-states-stable-material', background: composerStates[0].background });
    if (enabled) {
      const stack = page.locator('.agent-ws-stack:not(.agent-ws-stack-ghost)').first();
      const badge = stack.locator('.agent-notify-scheduler .status-badge').first();
      await badge.waitFor();
      const status = await badge.evaluate(element => ({ text: element.textContent.trim(), shared: element.classList.contains('session-capsule'), background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
      assert.equal(status.shared, true, 'Scheduler entry uses the real shared StatusBadge');
      await stack.locator('.agent-notify-chat').first().click();
      const float = page.locator('.agent-float-panel'); await float.waitFor(); await settle();
      const collapse = float.locator('.agent-panel-side-right');
      await waitUntil(() => collapse.isEnabled(), 'Real scheduler panel ready');
      const floating = await capture(`${state}-dispatch-empty-float`);
      const ghost = await collapse.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow }; });
      assert.equal(ghost.background, 'rgba(0, 0, 0, 0)', 'Scheduler collapse is transparent at rest');
      assert.equal(ghost.shadow, 'none', 'Scheduler collapse does not add a raised black box');
      const headerAvatar = await float.locator('.agent-panel-avatar').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
      report.checks.push({ name: state, kind: 'real-scheduler-empty-float-and-shared-status', revision: floating.ledger.revision, ghost, headerAvatar, collapsedEntryStatus: status });
      await collapse.click(); await settle(); await float.waitFor({ state: 'detached' });
      await stack.locator('.agent-notify-scheduler .status-badge').first().waitFor();
      await pane.getByRole('button', { name: '标签页管理', exact: true }).click();
      const menu = page.locator('.ctx-menu[role="menu"]').first(); await menu.waitFor();
      const pin = menu.locator('#ctx-item-pin');
      assert.notEqual(await pin.getAttribute('aria-disabled'), 'true', 'A real menu action is enabled');
      await pin.hover(); await capture(`${state}-right-tabs-menu`);
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
      // Exercise the real reversible menu action after recording its resting/disabled states.
      await pane.getByRole('button', { name: '标签页管理', exact: true }).click();
      await page.locator('.ctx-menu #ctx-item-pin').click();
      const unpin = pane.getByRole('button', { name: '取消固定', exact: true }); await unpin.waitFor();
      assert.equal(await unpin.getAttribute('aria-pressed'), 'true', 'Menu action really pinned the current content tab');
      await unpin.click(); await page.keyboard.press('Escape');
      report.checks.push({ name: state, kind: 'real-tab-menu-escape-and-pin-roundtrip' });
    }
    await capsule.getByRole('tab', { name: 'Git', exact: true }).click();
    await pane.locator('.right-resource-page.is-shown .git-repo-tree-leaf').first().click();
    await pane.locator('.right-content-page.is-shown .git-changes-scroll').getByText('review.ts', { exact: true }).click();
    const repositoryDiff = pane.locator('.right-content-page.is-shown .git-diff-view');
    await repositoryDiff.waitFor();
    await pane.locator('.right-content-page.is-shown .git-diff-skel').waitFor({ state: 'hidden' });
    await repositoryDiff.getByText('// Review draft: one resolved palette for all host surfaces.', { exact: true }).waitFor();
    assert.ok(await repositoryDiff.locator('tr').count() > 0, 'Repository Diff contains real painted fixture rows');
    await capture(`${state}-git-diff`);
    await pane.getByRole('button', { name: '在新标签中打开 Diff' }).click();
    await pane.locator('.right-independent-diff').waitFor();
    const independentDiff = pane.locator('.right-content-page.is-shown .right-independent-diff');
    await independentDiff.locator('.git-diff-skel').waitFor({ state: 'hidden' });
    await independentDiff.locator('.git-diff-view').waitFor();
    await independentDiff.getByText('// Review draft: one resolved palette for all host surfaces.', { exact: true }).waitFor();
    assert.ok(await independentDiff.locator('.git-diff-view tr').count() > 0, 'Independent Diff contains real painted fixture rows');
    await capture(`${state}-independent-diff`);
    report.checks.push({ name: state, kind: 'both-real-git-diffs-loaded', fixture: '// Review draft: one resolved palette for all host surfaces.' });
    // Formal Browser API and the production guest/URL/Bookmarks hosts, with no page-style injection.
    // Production intentionally displays about:blank as an empty address. Use a real local URL for address review.
    const browserUrl = `${browserFixtureOrigin}/color-review/${state}?source=production-capture`;
    if (!browserFixtureTab) browserFixtureTab = await page.evaluate(({ workspaceId, sessionId, url }) => window.api.browser.open({ url, workspaceId, sessionId }), { workspaceId, sessionId: ids[0], url: browserUrl });
    else await page.evaluate(({ id, url }) => window.api.browser.navigate({ id, input: url }), { id: browserFixtureTab.id, url: browserUrl });
    const browser = browserFixtureTab;
    const browserTab = pane.locator(`.right-tab[title="${browserUrl}"]`).first();
    await browserTab.waitFor(); await browserTab.click();
    await capsule.getByRole('tab', { name: '浏览器', exact: true }).click();
    await pane.locator('.browser-addr').waitFor();
    const guest = pane.locator(`webview[data-tab-id="${browser.id}"]`); await guest.waitFor();
    const waitForBrowserDocument = async url => {
      await page.waitForFunction(value => document.querySelector('.browser-addr')?.value === value, url);
      await waitUntil(async () => (await page.evaluate(() => window.api.browser.restore())).tabs.some(tab => tab.id === browser.id && tab.url === url && !tab.loading && !tab.crashed), 'Real local Browser URL finished');
      await waitUntil(async () => {
        try { const webContentsId = await guest.evaluate(element => element.getWebContentsId()); return await app.evaluate(async ({ webContents }, { id, url }) => { const content = webContents.fromId(id); return !!content && content.getURL() === url && !content.isLoadingMainFrame() && await content.executeJavaScript('document.readyState === "complete" && document.body.innerText.includes("这是隔离的网页内容夹具")'); }, { id: webContentsId, url }); } catch { return false; }
      }, 'Real local guest document content rendered');
    };
    await waitForBrowserDocument(browserUrl);
    const bookmarkTree = pane.locator('.right-resource-page.is-shown .right-bookmark-tree');
    await bookmarkTree.waitFor();
    if (!browserBookmarkFixture) {
      // Bookmarks have no browser RPC: use the real folder form and toolbar star,
      // which dispatch and persist the canonical rightWorkspace bookmark model.
      await pane.getByRole('button', { name: '新建文件夹', exact: true }).click();
      const form = pane.locator('.right-bookmark-edit');
      await form.getByRole('textbox', { name: '名称', exact: true }).fill('本机阅读');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await form.waitFor({ state: 'detached' });
      await pane.getByRole('button', { name: '收藏当前网页', exact: true }).click();
      await bookmarkTree.getByRole('button', { name: '本机内容页', exact: true }).waitFor();
      const referenceUrl = `${browserFixtureOrigin}/reference?source=production-capture`;
      await page.evaluate(({ id, url }) => window.api.browser.navigate({ id, input: url }), { id: browser.id, url: referenceUrl });
      await waitForBrowserDocument(referenceUrl);
      await waitUntil(async () => (await page.evaluate(() => window.api.browser.restore())).tabs.some(tab => tab.id === browser.id && tab.title === '本机参考页'), 'Local reference title propagated before bookmarking');
      await pane.getByRole('button', { name: '收藏当前网页', exact: true }).click();
      await bookmarkTree.getByRole('button', { name: '本机参考页', exact: true }).waitFor();
      await page.evaluate(({ id, url }) => window.api.browser.navigate({ id, input: url }), { id: browser.id, url: browserUrl });
      await waitForBrowserDocument(browserUrl);
      const folder = bookmarkTree.getByRole('button', { name: '本机阅读', exact: true });
      await folder.click();
      assert.equal(await folder.getAttribute('aria-expanded'), 'true', 'Real favorite folder opens through its normal UI');
      browserBookmarkFixture = { folder: '本机阅读', urls: [browserUrl, referenceUrl], source: 'actual folder form and toolbar favorite action; persisted inside isolated workspace' };
    }
    assert.equal(await bookmarkTree.locator('.right-bookmark-row').count(), 3, 'Browser favorites show a real folder and two actual bookmarks');
    assert.equal(await bookmarkTree.getByRole('button', { name: '本机阅读', exact: true }).getAttribute('aria-expanded'), 'true', 'The real folder remains expanded through theme changes');
    for (const name of ['本机内容页', '本机参考页']) await bookmarkTree.getByRole('button', { name, exact: true }).waitFor();
    const currentGuestId = await guest.evaluate(element => element.getWebContentsId());
    if (browserFixtureGuestId === undefined) browserFixtureGuestId = currentGuestId;
    else assert.equal(currentGuestId, browserFixtureGuestId, 'All theme rounds reuse the same mounted guest rather than recreating or closing it');
    assert.equal(await pane.locator('.browser-address-host').innerText(), new URL(browserUrl).host, 'Pretty address host displays the real local domain and port');
    assert.equal(await pane.locator('.browser-address-path').innerText(), new URL(browserUrl).pathname + new URL(browserUrl).search, 'Pretty address path/query remains complete');
    await capture(`${state}-browser-bookmarks-url`);
    report.checks.push({ name: state, kind: 'real-browser-guest-url-and-bookmarks-host', browserId: browser.id, webContentsId: currentGuestId, url: browserUrl, loadedAuthorContent: true, emptyTree: false, rowCount: 3, bookmarks: browserBookmarkFixture });
    await pane.locator('.right-tab').filter({ hasText: 'review.ts' }).first().click();
    await capsule.getByRole('tab', { name: '文件', exact: true }).click();
    await pane.locator('.right-content-page.is-shown .cm-content').waitFor();
    await page.waitForFunction(() => document.querySelector('.right-content-page.is-shown .cm-content')?.textContent.includes('export const phase = "ready";'));
    assert.ok(await guest.evaluate(element => element.isConnected), 'Production file switch retains the mounted browser guest');
    report.checks.push({ name: state, kind: 'real-browser-keepalive-and-return-to-file', browserId: browser.id, webContentsId: currentGuestId, guestRetained: true, browserCloseVerified: false, realFileBodyVisible: true });
    // Read-only tools are opened from their real navigation buttons, preserving their IPC and loading states.
    for (const tool of [
      { id: 'memory', label: '记忆整理', selector: '.memory-panel' },
      { id: 'usage', label: '使用统计', selector: '.usage-panel' },
      { id: 'tasks', label: '定时任务', selector: '.prompt-task-panel:not(.usage-panel):not(.memory-panel):not(.ext-manager-panel)' },
      { id: 'extensions', label: '扩展管理', selector: '.ext-manager-panel' }
    ]) {
      bounded();
      await page.locator('.utility-feature-item').filter({ has: page.locator('.session-name-text').filter({ hasText: new RegExp(`^${tool.label}$`) }) }).click();
      const toolPanel = page.locator(`.center-utility-layer:not([aria-hidden="true"]) ${tool.selector}`);
      await toolPanel.waitFor();
      let actualData;
      if (tool.id === 'memory') {
        await toolPanel.locator('.memory-overview-svg').waitFor();
        await waitUntil(async () => !(await toolPanel.locator('.prompt-task-toolbar').innerText()).includes('加载中'), 'Memory entries and real overview loaded');
      } else if (tool.id === 'usage') {
        await toolPanel.locator('.usage-skel').first().waitFor({ state: 'hidden' });
        assert.equal(await toolPanel.locator('.usage-card').count(), 4, 'Usage contains four real loaded metric cards');
      } else if (tool.id === 'tasks') {
        await toolPanel.getByText('正在检测 Worker…', { exact: true }).waitFor({ state: 'hidden' });
        await toolPanel.getByText('还没有定时任务', { exact: true }).waitFor();
      } else {
        // Isolated workspaces can contain the production-seeded daily-report package.
        // Compare the real IPC list, rather than assuming that isolation means an empty list.
        const extensionList = await page.evaluate(id => window.api.extensions.snapshot(id), workspaceId);
        assert.equal(extensionList.workspaceId, workspaceId, 'Extension list belongs to the isolated current workspace');
        const entries = extensionList.listing.global;
        await waitUntil(async () => entries.length > 0
          ? await toolPanel.locator('[role="tabpanel"]:not([aria-hidden="true"]) .ext-manager-row').count() === entries.length
          : await toolPanel.getByText('还没有全局扩展', { exact: true }).isVisible(), 'Actual extension cards or confirmed empty state loaded');
        actualData = { count: entries.length, ids: entries.map(entry => entry.id), empty: entries.length === 0 };
      }
      assert.equal(await toolPanel.locator('.error-box,.ext-manager-error').count(), 0, `${tool.id}: no read-only tool loading error`);
      await capture(`${state}-utility-${tool.id}`);
      report.checks.push({ name: state, kind: 'real-read-only-utility-entry', id: tool.id, label: tool.label, actualData });
      if (tool.id === 'extensions') await page.locator('.utility-feature-item').filter({ has: page.locator('.session-name-text').filter({ hasText: new RegExp(`^${tool.label}$`) }) }).click();
      else await toolPanel.getByRole('button', { name: '返回终端', exact: true }).click();
      await toolPanel.waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: '全局看板', exact: true }).click();
    const board = page.locator('.g-board-sheet.is-open'); await board.waitFor();
    await board.locator('button.board-card-name').filter({ hasText: /^代码审核$/ }).waitFor();
    await board.locator('button.board-card-name').filter({ hasText: /^界面开发$/ }).waitFor();
    await capture(`${state}-global-board`);
    await board.getByRole('button', { name: '关闭看板', exact: true }).click();
    await board.waitFor({ state: 'hidden' });
    report.checks.push({ name: state, kind: 'real-global-board-open-and-close', realFixtureSessions: 2 });
    await page.evaluate(async ({ id, workspaceId }) => { await window.api.sessions.select(id); await window.api.workspaceFile.patch({ hDock: 'terminal' }, workspaceId); }, { id: terminal.id, workspaceId });
    await page.locator('.terminal-wrap.is-shown .xterm-helper-textarea').waitFor();
    const marker = `PRODUCTION_TERMINAL_DEFAULT_${state}`;
    const dimText = `DIM ${state}: auxiliary text stays readable under the current theme.`;
    const terminalText = `\u001b[0m${marker}\r\n\u001b[31mANSI red  \u001b[32mANSI green  \u001b[34mANSI blue\u001b[0m\r\n\u001b[2m${dimText}\u001b[0m\r\n\u001b[48;2;40;28;46mTUI explicit background stays its own color\u001b[0m\r\n`;
    const encoded = Buffer.from(terminalText).toString('base64');
    await page.evaluate(({ id, text }) => window.api.pty.input(id, text), { id: terminal.id, text: `[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\r` });
    await waitUntil(async () => { const buffer = String(await page.evaluate(id => window.api.pty.getBuffer(id), terminal.id)); return buffer.includes(marker) && buffer.includes(dimText); }, 'Real PTY output, including the complete DIM sentence');
    if (theme === 'light') {
      const dimCells = async () => page.evaluate(({ text, prefix }) => {
        const parse = value => { const values = value.match(/[\d.]+/g)?.map(Number); return values && values.length >= 3 ? { rgb: values.slice(0, 3), alpha: values[3] ?? 1 } : null; };
        const over = (foreground, background) => foreground.rgb.map((value, index) => value * foreground.alpha + background[index] * (1 - foreground.alpha));
        const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const elements = [...document.querySelectorAll('.terminal-wrap.is-shown .xterm-rows .xterm-dim')];
        const allCells = elements.map(element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect(), container = element.closest('.terminal-container');
          let background = parse(getComputedStyle(document.querySelector('.center-panel')).backgroundColor).rgb;
          const ancestors = [];
          for (let node = element; node && node !== container; node = node.parentElement) ancestors.push(node);
          for (const node of ancestors.reverse()) { const color = parse(getComputedStyle(node).backgroundColor); if (color) background = over(color, background); }
          const foreground = parse(style.color), painted = foreground ? over(foreground, background) : background;
          const fgL = luminance(painted), bgL = luminance(background);
          return { text: element.textContent, rowText: element.parentElement?.textContent, foreground: style.color, foregroundAlpha: foreground?.alpha, inline: element.style.color, priority: element.style.getPropertyPriority('color'), background, contrast: (Math.max(fgL, bgL) + .05) / (Math.min(fgL, bgL) + .05), visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden', opaque: foreground?.alpha === 1 };
        });
        // Xterm splits a single DIM sentence into spans when the actual grid wraps.
        // Anchor its unique current-state prefix, then verify all rendered fragments.
        const start = allCells.findLastIndex(cell => cell.text.includes(prefix));
        const cells = []; let reconstructed = '';
        if (start >= 0) for (const cell of allCells.slice(start)) {
          cells.push(cell); reconstructed += cell.text;
          if (reconstructed.includes(text)) break;
        }
        const screen = document.querySelector('.terminal-wrap.is-shown .xterm-screen')?.getBoundingClientRect();
        return { cells, allCells, reconstructed, matchesSentence: reconstructed.includes(text), screen: screen && { width: screen.width, height: screen.height } };
      }, { text: dimText, prefix: `DIM ${state}:` });
      let diagnostic;
      try {
        await waitUntil(async () => {
          diagnostic = await dimCells();
          return diagnostic.matchesSentence && diagnostic.cells.length > 0 && diagnostic.cells.every(cell => cell.visible && cell.opaque && cell.contrast >= 4.5);
        }, 'Real rendered light DIM cell repaired to readable contrast');
      } catch (error) {
        report.checks.push({ name: state, kind: 'real-light-xterm-dim-timeout-diagnostics', expectedSentence: dimText, ...diagnostic });
        throw error;
      }
      assert.ok(diagnostic.matchesSentence && diagnostic.cells.length > 0 && diagnostic.cells.every(cell => cell.visible && cell.opaque && cell.contrast >= 4.5), 'Every painted fragment of the current wrapped light DIM sentence uses readable concrete foregrounds');
      report.checks.push({ name: state, kind: 'real-light-xterm-dim-painted-contrast', expectedSentence: dimText, ...diagnostic });
      const preservedCells = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('.terminal-wrap.is-shown .xterm-rows span')];
        const read = text => { const span = spans.filter(element => element.textContent.includes(text)).at(-1); if (!span) return null; const style = getComputedStyle(span); return { text: span.textContent, class: span.className, color: style.color, background: style.backgroundColor, colorPriority: span.style.getPropertyPriority('color'), dim: span.classList.contains('xterm-dim') }; };
        return { ordinary: ['ANSI red', 'ANSI green', 'ANSI blue'].map(read), explicit: read('TUI explicit background stays its own color') };
      });
      assert.ok(preservedCells.ordinary.every(cell => cell && !cell.dim && cell.colorPriority !== 'important'), 'DIM guard does not override ordinary ANSI foreground cells');
      assert.equal(new Set(preservedCells.ordinary.map(cell => cell.color)).size, 3, 'Ordinary red, green and blue retain distinct ANSI colors');
      assert.ok(preservedCells.explicit && !preservedCells.explicit.dim && preservedCells.explicit.colorPriority !== 'important', 'DIM guard leaves ordinary TUI text intact');
      assert.equal(preservedCells.explicit.background, 'rgb(40, 28, 46)', 'The real explicit TUI cell keeps its exact application-specified background');
      report.checks.push({ name: state, kind: 'real-light-xterm-ordinary-ansi-and-explicit-background-preserved', ...preservedCells });
    }
    const term = await capture(`${state}-terminal-ansi-dim`);
    const rootRevision = term.ledger.revision, terminalSurface = term.ledger.surfaces['.terminal-wrap.is-shown .terminal-container'];
    assert.equal(terminalSurface?.revision, rootRevision, 'Mounted xterm palette matches current appearance revision');
    const pad = await page.locator('.terminal-wrap.is-shown').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, canvas: getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim(), terminal: getComputedStyle(element).getPropertyValue('--terminal-bg').trim() }));
    report.checks.push({ name: state, kind: 'real-terminal-default-surface', ...pad, revision: rootRevision });
    // Resolve both concrete CSS forms in the production DOM, without changing any role.
    const rgbCanvas = await page.locator('.center-panel').evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(pad.background, rgbCanvas, 'Default terminal padding and production canvas have identical concrete backgrounds');
    await terminalDefaultPixels(state, term, rgbCanvas);
    if (!process.argv.includes('--no-settings')) {
      await page.keyboard.press('Control+,'); await page.locator('.settings-page').waitFor();
      const count = await page.locator('.settings-nav-item').count();
      for (let index = 0; index < count; index++) {
        bounded(); const navigation = page.locator('.settings-nav-item').nth(index), label = (await navigation.innerText()).trim();
        await navigation.click(); await settle();
        const activeId = await page.locator('.settings-tabpane.is-shown').getAttribute('data-settings-item');
        await capture(`${state}-settings-${activeId}`);
        report.checks.push({ name: state, kind: 'settings-navigation', id: activeId, label });
      }
      await page.keyboard.press('Escape'); await page.locator('.settings-page').waitFor({ state: 'detached' });
    }
  }
  // Exercise both renderer directions on this same real, persistent PTY. No terminal is recreated.
  await page.evaluate(async ({ id, workspaceId }) => { await window.api.themes.activate('dark'); await window.api.sessions.select(id); await window.api.workspaceFile.patch({ hDock: 'terminal' }, workspaceId); }, { id: terminal.id, workspaceId });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.workspaceMaterial === 'frosted');
  await page.locator('.terminal-wrap.is-shown .xterm-screen canvas').first().waitFor();
  await page.locator('.terminal-wrap.is-shown .xterm-rows').waitFor({ state: 'hidden' });
  const restoredBuffer = String(await page.evaluate(id => window.api.pty.getBuffer(id), terminal.id));
  assert.ok(restoredBuffer.includes('PRODUCTION_TERMINAL_DEFAULT_light-accent'), 'Light-to-dark renderer restoration preserves the same real PTY buffer');
  const restored = await capture('dark-accent-terminal-restored');
  const restoredCanvas = await page.locator('.center-panel').evaluate(element => getComputedStyle(element).backgroundColor);
  await terminalDefaultPixels('dark-accent-terminal-restored', restored, restoredCanvas);
  report.checks.push({ name: 'dark-accent-terminal-restored', kind: 'same-pty-light-to-dark-renderer-restoration', terminalId: terminal.id, bufferPreserved: true, webglCanvasVisible: true, revision: restored.ledger.revision });
  assert.deepEqual(report.errors, [], 'Renderer pageErrors must be empty');
  report.status = 'captured; DOM/IPC checks passed; images await actual visual review';
  report.unverified.push('No external AI CLI, remote Git/PR, media/document formats, external website colors, business-populated Memory/Tasks, custom Extension data or custom themes are exercised by this bounded script. Read-only utility data/empty states, Browser local-author-content shell and the folder/two-bookmark tree are real. Production-seeded extensions are listed with their actual counts. Their CSS owners remain in the static inventory.');
} catch (error) {
  report.status = 'failed or incomplete'; report.failure = String(error?.stack || error);
  // Preserve failure evidence before any screenshot/cleanup operation can itself fail.
  await saveReport();
  if (app && page && !expired) await capture('failure').catch(() => {});
  process.exitCode = 1; console.error(report.failure);
} finally {
  try { await cleanup(); } catch (error) {
    report.cleanupFailure = String(error?.stack || error); process.exitCode = 1;
    console.error(report.cleanupFailure);
  } finally { await saveReport(); }
  console.log(JSON.stringify({ status: report.status, captures: report.views.length, native: report.native.length, run, output: captures }));
}
