/** mac 平台壳层回归：托盘图标按点位缩放 + 原生全屏收回顶栏让位（主进程接线与 CSS 守卫）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');

// ── 托盘：transpile tray.ts 并用 stub require 隔离 electron/fs（同 window-material.mjs 的 ipc/app.ts 手法）──
function loadTray(platform) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const constructed = [];
  const iconOps = [];
  const makeIcon = (empty = false) => ({
    isEmpty: () => empty,
    getSize: () => ({ width: 512, height: 512 }),
    resize(options) {
      iconOps.push(['resize', options]);
      return makeIcon(false);
    },
    addRepresentation(rep) {
      iconOps.push(['addRepresentation', rep]);
    },
    toPNG() {
      return Buffer.from('png');
    }
  });
  const sourceIcon = makeIcon();
  const overrides = (specifier) => {
    if (specifier === 'electron') {
      return {
        app: {},
        Menu: { buildFromTemplate: () => ({}) },
        Tray: class {
          constructor(icon) { constructed.push(icon); }
          setContextMenu() {}
          setToolTip() {}
          on() {}
        },
        nativeImage: {
          createFromPath: () => sourceIcon,
          createEmpty: () => makeIcon(true)
        }
      };
    }
    if (specifier === 'node:fs') return { existsSync: () => true };
    if (specifier === 'node:path') return path;
    if (specifier === '../shared/i18n') return { subscribeLocale: () => () => {}, t: (key) => key };
    if (specifier === '../shared/productIdentity') return { PRODUCT_NAME_ZH: '集序' };
    if (specifier === './updater/surface') return { trayMenuTemplate: () => [] };
    throw new Error(`unexpected tray dependency ${specifier}`);
  };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/tray.ts'), 'utf8'), {
    fileName: 'tray.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  try {
    new Function('require', 'module', 'exports', '__dirname', code)(
      overrides, module, module.exports, path.join(root, 'out', 'main')
    );
    module.exports.createTray({ showWindow: () => {} });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
  return { constructed, iconOps };
}

try {
  // macOS：必须显式缩到 16pt 并补 @2x 表示，Tray 拿到的是缩放后的实例（还原修复即红：整图直塞）
  const mac = loadTray('darwin');
  assert.deepEqual(mac.constructed.length, 1, 'tray constructed once');
  assert.ok(mac.iconOps.some(([op, opt]) => op === 'resize' && opt.width === 16 && opt.height === 16), '16pt logical icon');
  const retina = mac.iconOps.find(([op]) => op === 'addRepresentation');
  assert.ok(retina && retina[1].scaleFactor === 2 && retina[1].width === 32 && retina[1].height === 32, '32px @2x representation');
  assert.ok(mac.iconOps.some(([op, opt]) => op === 'resize' && opt.width === 32 && opt.height === 32), '@2x source resized from the original');

  // Windows：沿用原行为，不做 resize（Tray 自动缩放）
  const win32 = loadTray('win32');
  assert.deepEqual(win32.iconOps, [], 'windows keeps the original icon');
  assert.equal(win32.constructed.length, 1);

  // ── 全屏让位：CSS 规则 + 主进程接线守卫 ──
  const chromeCss = fs.readFileSync(path.join(root, 'src/renderer/src/styles/chrome.css'), 'utf8');
  assert.match(chromeCss, /\.is-mac\s+\.chrome-bar\s*\{[^}]*padding-left:\s*84px/, 'windowed mac bar yields to traffic lights');
  assert.match(chromeCss, /\.is-mac\.is-native-fullscreen\s+\.chrome-bar\s*\{[^}]*padding-left:\s*0/, 'native fullscreen reclaims the yield');

  const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(indexSource, /enter-full-screen/, 'fullscreen enter event wired');
  assert.match(indexSource, /leave-full-screen/, 'fullscreen leave event wired');
  assert.match(indexSource, /did-finish-load'[^]*?pushFullscreen\(\)/, 'initial fullscreen state pushed after load');

  const mainTsx = fs.readFileSync(path.join(root, 'src/renderer/src/main.tsx'), 'utf8');
  assert.match(mainTsx, /installMacChrome\(\)/, 'renderer entry installs mac chrome');

  console.log('mac-chrome: tray icon sizing + fullscreen yield reclaim guards passed');
} finally {
  // 无持久化产物
}
