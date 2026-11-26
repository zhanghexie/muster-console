/**
 * shared 纯函数测试的编译助手：把入口及其相对依赖按 src/ 镜像结构转译为 .mjs，
 * 并在临时目录种一个 i18next shim——shared/i18n/index.ts 的裸 import 'i18next'
 * 在仓库外的临时目录里解析不到仓库 node_modules，用最小 CJS 包转发到真包
 * （ESM 侧 default 即完整 i18next 实例，与 interop 语义一致）。
 *
 * 与 emitTree 的差别：面向「单入口 + shared 纯函数」测试，自带 typescript 与
 * 统一编译选项，入口相对 src/ 传路径，返回产物绝对路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

/** 纯类型 import/export 在运行期没有对应导出，转译前整行删掉（与 emitTree 一致） */
const TYPE_ONLY = /(?:import|export)\s+type\s+(?:\{[^}]*\}|[\w$]+)\s+from\s+'[^']+';?\r?\n/g;
/** 相对 specifier：`from './x'` 与 `import('./x')` */
const RELATIVE_SPECIFIER = /(from\s+|import\s*\(\s*)'(\.[^']*)'/g;

const TS_OPTS = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true
};

/**
 * @param root 仓库根
 * @param tmpDir 本测试的临时目录（产物写进 tmpDir/<src 相对路径>.mjs）
 * @returns compile(entryRel) —— entryRel 相对 src/（如 'shared/chatTime.ts'），返回产物绝对路径
 */
export function createSharedCompiler(root, tmpDir) {
  // i18next shim：main 指向的 index.cjs require 真包，module.exports 即实例。
  // 真包位置用本 helper 自身的解析上下文求出（node 沿目录树向上找 node_modules）：
  // 本仓常以 git worktree 形式迁出，worktree 内没有自己的 node_modules（在主仓根），
  // 硬拼 `${root}/node_modules/i18next` 绝对路径必 MODULE_NOT_FOUND（40 个测试全红）
  const i18nextRealDir = path.dirname(require.resolve('i18next/package.json'));
  const shimDir = path.join(tmpDir, 'node_modules', 'i18next');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    path.join(shimDir, 'package.json'),
    JSON.stringify({ name: 'i18next', main: 'index.cjs' })
  );
  fs.writeFileSync(
    path.join(shimDir, 'index.cjs'),
    `module.exports = require(${JSON.stringify(i18nextRealDir)});\n`
  );
  // RuntimeHost supplies the app's WS implementation to process-pinned native providers.
  const wsDir = path.join(tmpDir, 'node_modules', 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'ws', main: 'index.cjs' }));
  fs.writeFileSync(path.join(wsDir, 'index.cjs'), `const ws = require(${JSON.stringify(require.resolve('ws'))});
module.exports = ws;
module.exports.WebSocket = ws.WebSocket;
module.exports.WebSocketServer = ws.WebSocketServer;
`);

  // ACP review turns provider old/new content into a unified diff.
  const unidiffDir = path.join(tmpDir, 'node_modules', 'unidiff');
  fs.mkdirSync(unidiffDir, { recursive: true });
  fs.writeFileSync(path.join(unidiffDir, 'package.json'), JSON.stringify({ name: 'unidiff', main: 'index.cjs' }));
  fs.writeFileSync(path.join(unidiffDir, 'index.cjs'), `module.exports = require(${JSON.stringify(require.resolve('unidiff'))});\n`);

  // The extension host validates tool JSON schemas in the app's Ajv runtime.
  const ajvDir = path.join(tmpDir, 'node_modules', 'ajv');
  fs.mkdirSync(ajvDir, { recursive: true });
  fs.writeFileSync(path.join(ajvDir, 'package.json'), JSON.stringify({ name: 'ajv', main: 'index.cjs' }));
  fs.writeFileSync(path.join(ajvDir, 'index.cjs'), `module.exports = require(${JSON.stringify(require.resolve('ajv'))});\n`);

  // Extension snapshot publishing uses the same native no-overwrite primitive.
  const koffiDir = path.join(tmpDir, 'node_modules', 'koffi');
  fs.mkdirSync(koffiDir, { recursive: true });
  fs.writeFileSync(path.join(koffiDir, 'package.json'), JSON.stringify({ name: 'koffi', main: 'index.cjs' }));
  fs.writeFileSync(path.join(koffiDir, 'index.cjs'), `module.exports = require(${JSON.stringify(require.resolve('koffi'))});\n`);

  // electron stub：main 图谱（如 sessions → tasks/delegate）的 `import { app } from 'electron'`
  // 在纯 node 临时树里解析不到真包（真包在 electron 运行时外只导出可执行文件路径）。
  // 导出静态具名桩（覆盖 src/main 全部具名导入面），app.getPath 落在本测试临时目录内。
  const electronDir = path.join(tmpDir, 'node_modules', 'electron');
  fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.cjs' }));
  fs.writeFileSync(
    path.join(electronDir, 'index.cjs'),
    `const path = require('node:path');
const noop = () => {};
const tmpRoot = path.resolve(__dirname, '..', '..');
const stub = (extra = {}) => Object.assign({
  on: noop, once: noop, off: noop, addListener: noop, removeListener: noop,
  removeAllListeners: noop, handle: noop, handleOnce: noop, invoke: async () => ({}),
  send: noop, sendTo: noop, show: noop, close: noop, focus: noop, destroy: noop,
  isDestroyed: () => true, isDevToolsOpened: () => false
}, extra);
const app = Object.assign(stub(), {
  whenReady: () => Promise.resolve(), isReady: true, isPackaged: false,
  getVersion: () => '0.0.0', getLocale: () => 'zh-CN', getName: () => 'Muster Console',
  getPath: (n) => path.join(tmpRoot, 'electron-' + String(n || 'data')), setPath: noop,
  getAppPath: () => tmpRoot, quit: noop, exit: noop, relaunch: noop,
  requestSingleInstanceLock: () => true, setAppUserModelId: noop,
  commandLine: { appendSwitch: noop, appendArgument: noop }
});
const BrowserWindow = Object.assign(stub(), {
  getAllWindows: () => [], fromId: () => null, getFocusedWindow: () => null
});
const dialog = Object.assign(stub(), {
  showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 0,
  showErrorBox: noop, showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true })
});
const shell = Object.assign(stub(), {
  openExternal: async () => undefined, openPath: async () => '', showItemInFolder: noop
});
// 全部导出先落成具名常量：cjs-module-lexer 只识别「键: 标识符」或简写，
// 「键: stub()」这类调用表达式会让 ESM 具名导入（import { ipcMain }）解析失败。
const Menu = stub(), MenuItem = stub(), MenuItemConstructorOptions = stub(),
  Notification = stub(), Tray = stub(), WebContents = stub(),
  ipcMain = stub(), ipcRenderer = stub(), clipboard = stub(),
  crashReporter = stub(), desktopCapturer = stub(), nativeImage = stub(),
  nativeTheme = stub(), net = stub(), powerMonitor = stub(), powerSaveBlocker = stub(),
  protocol = stub(), safeStorage = stub(), screen = stub(), session = stub(),
  webContents = stub(), globalShortcut = stub();
module.exports = {
  app, BrowserWindow, dialog, shell,
  Menu, MenuItem, MenuItemConstructorOptions,
  Notification, Tray, WebContents,
  ipcMain, ipcRenderer, clipboard,
  crashReporter, desktopCapturer, nativeImage,
  nativeTheme, net, powerMonitor, powerSaveBlocker,
  protocol, safeStorage, screen, session,
  webContents, globalShortcut
};
`
  );

  const done = new Set();
  /** 相对 spec 的转译目标：<spec>.ts，目录则 <spec>/index.ts（返回 null 找不到） */
  const resolveDep = (absTs, spec) => {
    const base = path.resolve(path.dirname(absTs), spec);
    if (fs.existsSync(`${base}.ts`)) return { abs: `${base}.ts`, outSpec: `${spec}.mjs` };
    const idx = path.join(base, 'index.ts');
    if (fs.existsSync(idx)) return { abs: idx, outSpec: `${spec}/index.mjs` };
    return null;
  };
  const emitOne = (absTs) => {
    const rel = path.relative(path.join(root, 'src'), absTs);
    const outPath = path.join(tmpDir, rel.replace(/\.ts$/, '.mjs'));
    if (done.has(rel)) return outPath;
    done.add(rel);
    if (rel.replaceAll('\\', '/') === 'main/agentSession/process/windowsJobAsset.ts') {
      const guardian = path.join('main', 'agentSession', 'drivers', 'codex', 'worker', 'windows-job.ps1');
      fs.mkdirSync(path.dirname(path.join(tmpDir, guardian)), { recursive: true });
      fs.copyFileSync(path.join(root, 'src', guardian), path.join(tmpDir, guardian));
    }
    const source = fs.readFileSync(absTs, 'utf8').replace(TYPE_ONLY, '');
    const deps = [];
    const rewritten = source.replace(RELATIVE_SPECIFIER, (_m, head, spec) => {
      const dep = resolveDep(absTs, spec);
      if (!dep) throw new Error(`[shared-compile] 解析不到相对依赖 '${spec}'（自 ${absTs}）`);
      deps.push(dep.abs);
      return `${head}'${dep.outSpec}'`;
    });
    const { outputText } = ts.transpileModule(rewritten, { compilerOptions: TS_OPTS, fileName: absTs });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const directoryShim = /\b__dirname\b/.test(source) && !/(?:const|let|var)\s+__dirname\b/.test(source)
      ? `const __dirname = ${JSON.stringify(path.dirname(outPath))};\n` : '';
    fs.writeFileSync(outPath, directoryShim + outputText, 'utf8');
    for (const abs of deps) emitOne(abs);
    return outPath;
  };

  return (entryRel) => emitOne(path.join(root, 'src', entryRel));
}
