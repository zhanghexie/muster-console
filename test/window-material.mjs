/** Mica availability, opaque fallback, and both production theme entry points. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-material-'));
const compile = createSharedCompiler(root, tmp);
const material = await import(pathToFileURL(compile('main/windowMaterial.ts')).href);
const { ThemeService } = await import(pathToFileURL(compile('main/themes.ts')).href);
const { builtinTheme } = await import(pathToFileURL(compile('shared/theme.ts')).href);
const { initializeWindowMaterial, applyWindowChrome, supportsMica, nativeMaterialFor } = material;
const require = createRequire(import.meta.url);
const ts = require('typescript');
const logs = [];
const logger = {
  info: (...args) => logs.push(['info', ...args]),
  warn: (...args) => logs.push(['warn', ...args])
};
const environment = { platform: 'win32', release: '10.0.22621', titleBarOverlay: true, logger };
const macEnvironment = { platform: 'darwin', release: '25.4.0', logger };
const dark = { panel: '#202023', ink: '#ededee', appearance: 'dark' };
const light = { panel: '#f0f3f9', ink: '#222222', appearance: 'light' };

function mockWindow({
  missingMethod = false,
  failEnable = false,
  failTransparent = false,
  failTransparentOverlay = false,
  overlayDisabled = false,
  darwin = false,
  missingVibrancy = false,
  failVibrancy = false
} = {}) {
  const backgrounds = [];
  const materials = [];
  const overlays = [];
  const vibrancies = [];
  const win = {
    setBackgroundColor(color) {
      if (failTransparent && color === '#00000000') throw new Error('transparent background rejected');
      backgrounds.push(color);
    },
    // darwin 的真实 BrowserWindow 没有 setTitleBarOverlay（Electron @platform win32,linux）
    ...(!darwin && {
      setTitleBarOverlay(overlay) {
        if (overlayDisabled) throw new TypeError('Titlebar overlay is not enabled');
        if (failTransparentOverlay && overlay.color === '#00000000') throw new Error('transparent overlay rejected');
        overlays.push(overlay);
      }
    }),
    ...(!missingMethod && {
      setBackgroundMaterial(value) {
        materials.push(value);
        if (failEnable && value === 'mica') throw new Error('Mica rejected');
      }
    }),
    ...(!missingVibrancy && {
      setVibrancy(value) {
        vibrancies.push(value);
        if (failVibrancy && value !== null) throw new Error('vibrancy rejected');
      }
    })
  };
  return { win, backgrounds, materials, overlays, vibrancies };
}

try {
  for (const release of ['10.0.22621', '10.0.22631', '10.0.26100.1', '11.0.0']) {
    assert.equal(supportsMica('win32', release), true, `${release} supports Mica`);
  }
  for (const release of ['6.3.9600', '10.0.19045', '10.0.22000', '10.0.22620', '10.0', 'bad', '10.0.22621-beta']) {
    assert.equal(supportsMica('win32', release), false, `${release} must fall back`);
  }
  // 平台能力分流：Windows 门槛内是 Mica，macOS 是原生 Vibrancy，其余实色。
  assert.equal(nativeMaterialFor('win32', '10.0.22621'), 'mica');
  assert.equal(nativeMaterialFor('win32', '10.0.22000'), 'solid');
  assert.equal(nativeMaterialFor('darwin', '25.4.0'), 'vibrancy');
  assert.equal(nativeMaterialFor('linux', '6.12.0'), 'solid');

  for (const platform of ['darwin', 'linux']) {
    assert.equal(supportsMica(platform, '10.0.22621'), false);
  }
  {
    const linux = mockWindow({ overlayDisabled: true });
    assert.equal(initializeWindowMaterial(linux.win, { themeSource: 'system' }, light, { platform: 'linux', logger }), 'solid');
    assert.equal(applyWindowChrome(linux.win, dark), 'solid');
    assert.deepEqual(linux.materials, [], 'unsupported platforms do not call Windows backdrop API');
    assert.deepEqual(linux.vibrancies, [], 'unsupported platforms do not call macOS vibrancy API');
    assert.deepEqual(linux.backgrounds, [light.panel, dark.panel]);
    assert.deepEqual(linux.overlays, [], 'Linux uses native titlebar without an Electron overlay');
  }

  // macOS Vibrancy：成功路径启用 sidebar 材质 + 透明底，主题切换不重装材质。
  {
    const mac = mockWindow({ darwin: true });
    const nativeTheme = { themeSource: 'system' };
    assert.equal(initializeWindowMaterial(mac.win, nativeTheme, dark, macEnvironment), 'vibrancy');
    assert.equal(nativeTheme.themeSource, 'dark');
    assert.deepEqual(mac.vibrancies, ['sidebar']);
    assert.deepEqual(mac.materials, [], 'mac never calls the Windows backdrop API');
    assert.deepEqual(mac.overlays, [], 'mac has no native caption overlay');
    assert.equal(applyWindowChrome(mac.win, light), 'vibrancy');
    assert.equal(nativeTheme.themeSource, 'light');
    assert.deepEqual(mac.vibrancies, ['sidebar'], 'theme changes do not reinstall vibrancy');
    assert.deepEqual(mac.backgrounds, ['#00000000', '#00000000']);
  }
  for (const options of [{ missingVibrancy: true }, { failVibrancy: true }, { failTransparent: true }]) {
    const fallback = mockWindow({ darwin: true, ...options });
    const before = logs.length;
    assert.equal(initializeWindowMaterial(fallback.win, { themeSource: 'system' }, dark, macEnvironment), 'solid');
    assert.equal(applyWindowChrome(fallback.win, light), 'solid');
    assert.deepEqual(fallback.backgrounds, [dark.panel, light.panel], 'failure always leaves an opaque fallback');
    if (options.failVibrancy) assert.deepEqual(fallback.vibrancies, ['sidebar', null], 'enable failure resets vibrancy');
    assert.ok(logs.slice(before).some((entry) => entry[0] === 'warn'), 'native failures are logged');
  }
  {
    const failedTheme = mockWindow({ darwin: true });
    const nativeFailure = { set themeSource(_) { throw new Error('theme sync rejected'); } };
    assert.equal(initializeWindowMaterial(failedTheme.win, nativeFailure, dark, macEnvironment), 'solid');
    assert.deepEqual(failedTheme.backgrounds, [dark.panel], 'native theme failure cannot block opaque rendering');
    // themeSource 先于 setVibrancy 赋值：抛错时材质从未启用，只尝试一次重置
    assert.deepEqual(failedTheme.vibrancies, [null]);
  }

  const unsupported = mockWindow();
  initializeWindowMaterial(unsupported.win, { themeSource: 'system' }, dark, { ...environment, release: '10.0.22000' });
  assert.deepEqual(unsupported.materials, []);
  assert.deepEqual(unsupported.backgrounds, [dark.panel]);
  assert.ok(logs.some((entry) => entry[0] === 'info' && entry[1].includes('no supported native backdrop')));

  for (const options of [{ missingMethod: true }, { failEnable: true }, { failTransparent: true }]) {
    const fallback = mockWindow(options);
    const before = logs.length;
    assert.equal(initializeWindowMaterial(fallback.win, { themeSource: 'system' }, dark, environment), 'solid');
    assert.equal(applyWindowChrome(fallback.win, light), 'solid');
    assert.deepEqual(fallback.backgrounds, [dark.panel, light.panel], 'failure always leaves an opaque fallback');
    assert.deepEqual(fallback.overlays.map((overlay) => overlay.color), [dark.panel, light.panel]);
    assert.ok(logs.slice(before).some((entry) => entry[0] === 'warn'), 'native failures are logged');
  }

  const failedTheme = mockWindow();
  const nativeFailure = { set themeSource(_) { throw new Error('theme sync rejected'); } };
  assert.equal(initializeWindowMaterial(failedTheme.win, nativeFailure, dark, environment), 'solid');
  assert.deepEqual(failedTheme.backgrounds, [dark.panel], 'native theme failure cannot block opaque rendering');

  const mica = mockWindow();
  const nativeTheme = { themeSource: 'system' };
  assert.equal(initializeWindowMaterial(mica.win, nativeTheme, dark, environment), 'mica');
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.equal(applyWindowChrome(mica.win, light), 'mica');
  assert.equal(nativeTheme.themeSource, 'light');
  assert.equal(applyWindowChrome(mica.win, { ...dark, ink: '#111111' }), 'mica');
  assert.equal(nativeTheme.themeSource, 'dark', 'appearance follows theme metadata even when frame text turns dark');
  assert.deepEqual(mica.materials, ['mica'], 'theme changes do not reinstall the backdrop');
  assert.deepEqual(mica.backgrounds, ['#00000000', '#00000000', '#00000000']);
  assert.deepEqual(mica.overlays.at(-1), { color: '#00000000', symbolColor: '#111111', height: 36 });
  assert.ok(mica.overlays.every((overlay) => overlay.color === '#00000000'), 'Mica caption controls expose the same frame tint in both appearances');

  const rejectedOverlay = mockWindow({ failTransparentOverlay: true });
  const beforeOverlayFailure = logs.length;
  assert.equal(initializeWindowMaterial(rejectedOverlay.win, { themeSource: 'system' }, dark, environment), 'solid');
  assert.equal(applyWindowChrome(rejectedOverlay.win, light), 'solid');
  assert.deepEqual(rejectedOverlay.backgrounds, ['#00000000', dark.panel, light.panel]);
  assert.deepEqual(rejectedOverlay.materials, ['mica', 'none']);
  assert.deepEqual(rejectedOverlay.overlays.map((overlay) => overlay.color), [dark.panel, light.panel]);
  assert.ok(logs.slice(beforeOverlayFailure).some((entry) => entry[0] === 'warn'), 'overlay failure is an explicit logged fallback');

  const plain = mockWindow({ missingMethod: true });
  assert.equal(applyWindowChrome(plain.win, light), 'solid', 'uninitialized older window mocks stay compatible');
  assert.deepEqual(plain.backgrounds, [light.panel], 'state belongs to each window rather than the whole app');
  assert.deepEqual(plain.overlays, [], 'uninitialized windows have no registered overlay');

  // Run the real ThemeService path: a direct opaque setBackgroundColor regression turns this red.
  const config = {
    value: { themeId: 'dark', activeWorkspaceId: 'workspace', workspaces: [{ id: 'workspace' }] },
    get() { return this.value; },
    update(patch) { Object.assign(this.value, patch); }
  };
  const themes = new ThemeService(tmp, config);
  const serviceWindow = mockWindow();
  const serviceNative = { themeSource: 'system' };
  initializeWindowMaterial(serviceWindow.win, serviceNative, dark, environment);
  themes.activate('light');
  themes.applyChrome(serviceWindow.win);
  assert.equal(serviceNative.themeSource, 'light');
  assert.equal(serviceWindow.backgrounds.at(-1), '#00000000');
  assert.equal(serviceWindow.overlays.at(-1).color, '#00000000');
  assert.equal(serviceWindow.overlays.at(-1).symbolColor, builtinTheme('light').colors['ink']);

  // Load the real IPC module; stub only its unrelated services and capture registration.
  const handlers = new Map();
  const appModule = { exports: {} };
  const overrides = {
    electron: { app: {}, dialog: {} },
    '../systemShortcuts': { sendSystemShortcut: () => {} },
    '../frameBackdropFiles': {},
    '../../shared/frameBackdrop': {},
    qrcode: {},
    './handle': { handle: (channel, fn) => handlers.set(channel, fn) },
    '../capabilities/hosts/terminal': {},
    '../../shared/i18n': { t: (value) => value },
    '../logs/rendererError': {},
    '../windowMaterial': material
  };
  const source = fs.readFileSync(path.join(root, 'src/main/ipc/app.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    fileName: 'app.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  new Function('require', 'module', 'exports', code)(
    (specifier) => {
      assert.ok(Object.hasOwn(overrides, specifier), `unexpected IPC dependency ${specifier}`);
      return overrides[specifier];
    }, appModule, appModule.exports
  );
  let ipcWindow = serviceWindow.win;
  appModule.exports.registerAppIpc({ getWindow: () => ipcWindow, themes });
  const syncChrome = handlers.get('app:setChromeTheme');
  assert.deepEqual(syncChrome(null, { ...dark, ink: '#111111' }), { ok: true, material: 'mica' });
  assert.equal(serviceNative.themeSource, 'dark', 'IPC preview appearance beats persisted theme appearance');
  assert.equal(serviceWindow.backgrounds.at(-1), '#00000000');
  assert.deepEqual(syncChrome(null, { panel: '#fefefe', ink: '#111111' }), { ok: true, material: 'mica' });
  assert.equal(serviceNative.themeSource, 'light', 'older IPC caller falls back to active theme metadata');
  assert.equal(serviceWindow.overlays.at(-1).color, '#00000000', 'IPC frame tint changes cannot make the native buttons opaque');
  assert.equal(serviceWindow.overlays.at(-1).symbolColor, '#111111');
  ipcWindow = plain.win;
  assert.deepEqual(syncChrome(null, dark), { ok: true, material: 'solid' });
  const macServiceWindow = mockWindow({ darwin: true });
  initializeWindowMaterial(macServiceWindow.win, { themeSource: 'system' }, dark, macEnvironment);
  ipcWindow = macServiceWindow.win;
  assert.deepEqual(syncChrome(null, { ...dark, ink: '#111111' }), { ok: true, material: 'vibrancy' }, 'mac IPC reports vibrancy');
  assert.equal(macServiceWindow.backgrounds.at(-1), '#00000000');
  ipcWindow = null;
  assert.deepEqual(syncChrome(null, dark), { ok: false });

  const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const initializeAt = indexSource.indexOf('initializeWindowMaterial(win, nativeTheme,');
  const loadAt = indexSource.search(/win\.load(?:URL|File)\(/);
  assert.ok(initializeAt > 0 && loadAt > initializeAt, 'native material is installed before renderer loading');
  assert.doesNotMatch(indexSource.slice(indexSource.indexOf('function createWindow()'), loadAt), /transparent:\s*true/);
  console.log('window-material: all assertions passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
