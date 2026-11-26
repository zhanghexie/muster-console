import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { applyLocaleSetting, t } from '../../shared/i18n';
import { PRODUCT_STORAGE_DIR } from '../../shared/productIdentity';
import { parseDemoArgs, replayTitleBar, type DemoOptions } from './options';
import { demoWorkspaceResolver, openDemoStore, prepareScene, recommendedDemoProject } from './storage';
import { setDemoWorkspaceDataResolver } from '../workspacePaths';
import { captureDemoLoginShellPath } from '../shell/loginEnv';
import { listTapes, readTape, startTape, type DemoEvent } from './tapes';
import { applyWindowChrome, initializeWindowMaterial } from '../windowMaterial';

function isolate(work: string, projects: string) {
  const home = path.join(work, 'home'), appData = path.join(work, 'app-data');
  const dirs = {
    home, appData, userData: path.join(appData, PRODUCT_STORAGE_DIR), sessionData: path.join(work, 'chromium'),
    temp: path.join(work, 'tmp'), logs: path.join(work, 'logs'), crashDumps: path.join(work, 'crashes'),
    documents: path.join(home, 'Documents'), desktop: path.join(home, 'Desktop'), downloads: path.join(home, 'Downloads')
  } as const;
  for (const [key, value] of Object.entries(dirs)) { fs.mkdirSync(value, { recursive: true }); app.setPath(key as keyof typeof dirs, value); }
  // Keep system desktop transport and provider credentials available. Redirect host discovery and harness state.
  for (const key of Object.keys(process.env)) if (key.startsWith('MUSTER_')) delete process.env[key];
  delete process.env.ELECTRON_RENDERER_URL;
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: path.join(home, 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    MUSTER_NO_SANDBOX: '1', MUSTER_INSTANCE_ID: 'demo-' + randomUUID(), MUSTER_DEMO_PROJECTS: projects,
    MUSTER_CLI_HOME: path.join(home, '.muster-console-cli'), TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp
  });
}

function attachRecorder(dir: string) {
  const writers = new Map<number, ReturnType<typeof startTape>>();
  const workbench = pathToFileURL(path.resolve(__dirname, '../renderer/index.html')).href;
  const permitted = (e: IpcMainEvent | IpcMainInvokeEvent) => e.senderFrame === e.sender.mainFrame
    && e.senderFrame?.url.split(/[?#]/, 1)[0] === workbench && !!BrowserWindow.fromWebContents(e.sender);
  ipcMain.on('demo:recordStart', e => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!permitted(e) || !win) throw new Error(t('无效录制窗口'));
      writers.get(e.sender.id)?.close();
      const [w, h] = win.getContentSize();
      const writer = startTape(dir, w, h);
      writers.set(e.sender.id, writer);
      e.returnValue = { id: writer.id };
    } catch (error) { e.returnValue = { error: String(error) }; }
  });
  ipcMain.on('demo:recordBatch', (e, id: string, items: DemoEvent[]) => {
    try {
      const writer = writers.get(e.sender.id);
      if (!permitted(e) || !writer || writer.id !== id) throw new Error(t('录制窗口与记录不匹配。'));
      writer.append(items);
      e.returnValue = { ok: true };
    } catch (error) { e.returnValue = { error: String(error) }; }
  });
  ipcMain.handle('demo:surface', async (e, id: string, rect: Electron.Rectangle) => {
    if (!permitted(e) || writers.get(e.sender.id)?.id !== id) throw new Error(t('无效录制窗口'));
    const zoom = e.sender.getZoomFactor();
    const [width, height] = BrowserWindow.fromWebContents(e.sender)!.getContentSize();
    const x = Math.max(0, Math.round(rect.x * zoom)), y = Math.max(0, Math.round(rect.y * zoom));
    const w = Math.min(width - x, Math.round(rect.width * zoom)), h = Math.min(height - y, Math.round(rect.height * zoom));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return '';
    const image = await e.sender.capturePage({ x, y, width: w, height: h });
    return image.isEmpty() ? '' : image.toDataURL();
  });
  app.on('web-contents-created', (_e, contents) => {
    const id = contents.id;
    contents.once('destroyed', () => { writers.get(id)?.close(); writers.delete(id); });
  });
}

async function openViewer(dir: string, opts: DemoOptions) {
  const tapes = listTapes(dir);
  const tape = opts.replay === 'latest' ? tapes[0] : tapes.find(t => t.id === opts.replay);
  if (!tape) throw new Error(t('没有可播放的记录。请用 demo-build --record 录制整窗操作，再用 demo-run --list 查看。'));
  await app.whenReady();
  const renderer = path.resolve(__dirname, '../renderer');
  const offline = session.fromPartition('demo-view-' + randomUUID());
  offline.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  offline.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    let allowed = ['about:', 'data:', 'blob:'].includes(url.protocol);
    if (url.protocol === 'file:') {
      try {
        const relative = path.relative(renderer, fs.realpathSync(fileURLToPath(url)));
        allowed = !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      } catch { allowed = false; }
    }
    done({ cancel: !allowed });
  });
  const win = new BrowserWindow({ width: tape.width, height: tape.height, useContentSize: true,
    autoHideMenuBar: true, title: t('集序 · {{scene}}', { scene: opts.scene }), backgroundColor: '#202023',
    ...replayTitleBar(process.platform),
    webPreferences: { session: offline, preload: path.join(__dirname, '../preload/demoReplay.js'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false } });
  initializeWindowMaterial(win, nativeTheme, { panel: '#202023', ink: '#ededee', appearance: 'dark' }, { titleBarOverlay: process.platform === 'win32' });
  ipcMain.on('demo:appearance', (e, colors) => {
    if (e.sender !== win.webContents || e.senderFrame !== e.sender.mainFrame || !['light', 'dark'].includes(colors?.appearance)) return;
    if (![colors.panel, colors.ink].every(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) return;
    applyWindowChrome(win, colors);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const data = readTape(dir, tape.id);
  ipcMain.handle('demo:read', async e => {
    if (e.sender !== win.webContents || e.senderFrame !== e.sender.mainFrame) throw new Error(t('无效回放窗口'));
    const batch = await data.next();
    return { events: batch.value ?? [], done: !!batch.done, speed: opts.speed, from: opts.from, width: tape.width, height: tape.height };
  });
  win.once('closed', () => { ipcMain.removeHandler('demo:read'); void data.return(undefined); app.quit(); });
  await win.loadFile(path.join(renderer, 'demo-replay.html'));
}

function main() {
  applyLocaleSetting('system', app.getPreferredSystemLanguages()[0]);
  const opts = parseDemoArgs(process.argv)!;
  const base = path.resolve(opts.base ?? app.getPath('appData'));
  const store = openDemoStore(base, opts.mode);
  if (!store) {
    if (opts.mode === 'delete' || opts.list) { console.log(t('没有本地演示数据。')); app.exit(0); return; }
    throw new Error(t('尚未搭建演示，请先运行 demo-build。'));
  }
  // Hold through Chromium/process shutdown. A close-to-tray window is still a live author.
  process.once('exit', store.close);
  const { work, recordings } = prepareScene(store.root, opts);
  if (opts.mode === 'delete') { console.log(t('已删除演示数据。原项目目录保留。')); app.exit(0); return; }
  if (opts.list) {
    const tapes = listTapes(recordings);
    console.log(tapes.map(t => t.id + '  ' + t.started).join('\n') || t('尚无可播放的记录。')); app.exit(0); return;
  }
  if (!opts.replay) captureDemoLoginShellPath();
  isolate(opts.replay ? path.join(path.dirname(work), 'viewer') : work,
    opts.replay ? '' : recommendedDemoProject(base, opts.scene));
  if (opts.replay) { void openViewer(recordings, opts).catch(fail); return; }
  setDemoWorkspaceDataResolver(demoWorkspaceResolver(store.root, work));
  if (opts.record) attachRecorder(recordings);
  require('./workbench.js'); // Sibling compiled entry in out/main.
}

function fail(error: unknown) {
  console.error('[demo]', error);
  if (app.isPackaged) dialog.showErrorBox(t('集序 · Demo'), String(error));
  app.exit(1);
}
try { main(); } catch (error) { fail(error); }
