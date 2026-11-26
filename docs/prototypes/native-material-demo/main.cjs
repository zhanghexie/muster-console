const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { supportedMaterials, validateOptions } = require('./policy.cjs');

const root = path.resolve(__dirname, '../../..');
const userData = path.join(root, '.tmp/native-material-demo/user-data');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setName('MetaAgent Native Material Study');
let win;
let referenceWindow;
let state;
const readyFile = path.join(root, '.tmp/native-material-demo/ready.json');
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});
app.on('before-quit', () => {
  try {
    if (JSON.parse(fs.readFileSync(readyFile, 'utf8')).pid === process.pid) fs.unlinkSync(readyFile);
  } catch { /* No readiness file was published. */ }
});

function applyMaterial(material, theme) {
  nativeTheme.themeSource = theme;
  if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') {
    win.setBackgroundMaterial(material === 'solid' ? 'none' : material);
  } else if (process.platform === 'darwin') {
    win.setVibrancy(material === 'solid' ? null : 'sidebar');
  }
  // Native backdrops need a transparent Chromium surface. Opaque DOM covers the working area.
  win.setBackgroundColor(material === 'solid' ? (theme === 'dark' ? '#191a1d' : '#e9eaed') : '#00000000');
}

function setReference(visible) {
  if (visible) {
    referenceWindow.showInactive();
    win.moveTop();
    win.focus();
  } else referenceWindow.hide();
}

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1200, area.width - 80);
  const height = Math.min(790, area.height - 80);
  const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
  const nativeMethod = process.platform === 'darwin' ? 'setVibrancy' : 'setBackgroundMaterial';
  const supported = supportedMaterials(process.platform, os.release(), typeof BrowserWindow.prototype[nativeMethod] === 'function');
  state = { material: supported.includes('acrylic') ? 'acrylic' : 'solid', theme: 'dark', tint: 12, reference: true,
    platform: process.platform, supportedMaterials: supported, nativeAvailable: supported.length > 1,
    electronVersion: process.versions.electron, osVersion: os.release() };
  nativeTheme.themeSource = state.theme;
  referenceWindow = new BrowserWindow({ ...bounds, x: bounds.x - 24, y: bounds.y - 24, width: width + 48, height: height + 48,
    show: false, frame: false, focusable: false, skipTaskbar: true, backgroundColor: '#536b7d',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  referenceWindow.setMenuBarVisibility(false);
  await referenceWindow.loadFile(path.join(__dirname, 'reference.html'));
  win = new BrowserWindow({ ...bounds, minWidth: 720, minHeight: 560, show: false, frame: false,
    title: 'MetaAgent · 原生侧栏材质小样', ...(process.platform === 'win32' && state.nativeAvailable ? { backgroundMaterial: state.material } : {}),
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar', visualEffectState: 'active' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.setMenuBarVisibility(false);
  applyMaterial(state.material, state.theme);
  const authorize = event => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的原型窗口');
  };
  ipcMain.handle('material-demo:state', event => { authorize(event); return { ...state }; });
  ipcMain.handle('material-demo:options', (event, patch) => {
    authorize(event);
    const next = { ...state, ...validateOptions(patch, supported) };
    if (next.material !== state.material || next.theme !== state.theme) applyMaterial(next.material, next.theme);
    if (next.reference !== state.reference) setReference(next.reference);
    state = next;
    return { ...state };
  });
  ipcMain.on('material-demo:window', (event, action) => {
    authorize(event);
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('closed', () => { referenceWindow.destroy(); app.quit(); });
  win.on('minimize', () => referenceWindow.hide());
  win.on('restore', () => { if (state.reference) setReference(true); });
  await win.loadFile(path.join(root, '.tmp/native-material-demo/renderer/index.html'));
  if (state.reference) referenceWindow.showInactive();
  win.show();
  win.focus();
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, state, bounds: win.getBounds(), readyAt: new Date().toISOString() }));
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
