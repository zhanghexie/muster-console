import { app, Menu, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { subscribeLocale, t } from '../shared/i18n';
import { PRODUCT_NAME_ZH } from '../shared/productIdentity';
import { trayMenuTemplate } from './updater/surface';
import type { TrayUpdateItem } from './updater/surface';

let keptAlive: Tray | null = null;
let showWindowAction: (() => void) | null = null;
/** 更新可安装态由 updater 经 setTrayUpdateItem 同步；先于 createTray 到达也先存着 */
let updateItem: TrayUpdateItem | null = null;

function rebuildMenu(): void {
  if (!keptAlive || !showWindowAction) return;
  keptAlive.setContextMenu(
    Menu.buildFromTemplate(
      trayMenuTemplate(updateItem, { showWindow: showWindowAction, quit: () => app.quit() })
    )
  );
}

/**
 * 系统托盘：窗口关闭按钮只做隐藏到托盘，真正的退出只有这里的右键菜单。
 * 左键单击 = 显示主窗口（与常见 Windows 应用习惯一致）。
 * 更新下载完成后菜单动态插入「重启并安装更新 vX」（updater 模块驱动）。
 */
export function createTray(opts: { showWindow: () => void }): void {
  // 托盘优先用 png（macOS/Linux 不认 ico）；与打包配置 electron-builder.yml 的 files 一致
  const iconCandidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.ico')
  ];
  const iconPath = iconCandidates.find((p) => fs.existsSync(p));
  const icon = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  if (icon.isEmpty()) {
    console.error('[tray] app icon not found, tray disabled:', iconCandidates);
    return;
  }

  // macOS 菜单栏按点位渲染图标且不自动缩放：不出 16pt/@2x 表示会整图原尺寸铺开（Windows Tray 自动缩放，ico 原生）
  let trayIcon = icon;
  if (process.platform === 'darwin') {
    trayIcon = icon.resize({ width: 16, height: 16, quality: 'best' });
    trayIcon.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: icon.resize({ width: 32, height: 32, quality: 'best' }).toPNG()
    });
  }

  // 模块级保活：Tray 实例失去引用会被 GC 回收，托盘图标随之消失
  keptAlive = new Tray(trayIcon);
  const tray = keptAlive;
  tray.setToolTip(t(PRODUCT_NAME_ZH));
  showWindowAction = opts.showWindow;
  rebuildMenu();
  // 菜单文案随语言设置即时生效（rebuildMenu 时才求值 t()）；托盘与应用同生命周期，不退订
  subscribeLocale(() => rebuildMenu());
  // macOS 挂了 context menu 后 click 事件只开菜单；Windows/Linux 左键直达主窗口
  tray.on('click', () => opts.showWindow());
}

/** 更新可安装态变化时由 updater 调：非 null 显示「重启并安装更新 vX」，null 移除 */
export function setTrayUpdateItem(item: TrayUpdateItem | null): void {
  updateItem = item;
  rebuildMenu();
}
