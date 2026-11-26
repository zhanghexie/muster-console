import { t } from '../../shared/i18n';
import type { UpdaterState } from '../../shared/updater';
import { PRODUCT_NAME_ZH } from '../../shared/productIdentity';
// 仅类型导入：编译期擦除，运行时零 electron 依赖（node 单测可直载）不破坏
import type { MenuItemConstructorOptions } from 'electron';

/**
 * 更新的全局可见面（纯决策，零 electron 运行时依赖，供单测）：
 * 任务栏进度值 / 系统通知文案 / 托盘菜单模板。接线在 ../updater/index.ts。
 */

/**
 * 更新类通知全程共用同键：发现 → 已就绪/下载失败 同键原地更新（不堆 toast）。
 * 旧实现按版本建键（updater:<version>），改为常键后同一时刻至多一条更新通知。
 */
export const UPDATE_NOTIFY_KEY = 'updater:progress';

/**
 * Windows 任务栏进度值（win.setProgressBar）。downloading 拿到百分比给真实进度；
 * 尚未收到首个进度事件给 2（>1 = 任务栏不定态动画，对应「正在准备下载」）；
 * 其余状态给 -1（<0 = 移除进度条）。
 */
export function taskbarProgressValue(state: UpdaterState, percent?: number): number {
  if (state !== 'downloading') return -1;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 2;
  return Math.min(100, Math.max(0, percent)) / 100;
}

export function downloadStartNotifyText(version: string): string {
  return t('发现新版本 v{{version}}，正在后台下载', { version });
}

/** 下载失败终态：同键收口（percent 不可信故不带数字） */
export function downloadFailedNotifyText(version: string): string {
  return t('v{{version}} 更新下载失败，可从「设置 → 关于」重新检查', { version });
}

export function trayInstallLabel(version: string): string {
  return t('重启并安装更新 v{{version}}', { version });
}

export interface TrayMenuActions {
  showWindow(): void;
  quit(): void;
}

export interface TrayUpdateItem {
  version: string;
  install(): void;
}

/** 托盘右键菜单模板：更新可安装时插「重启并安装更新 vX」，其余与原静态菜单一致 */
export function trayMenuTemplate(
  updateItem: TrayUpdateItem | null,
  actions: TrayMenuActions
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: t('显示主窗口'), click: actions.showWindow }
  ];
  if (updateItem) {
    items.push({ label: trayInstallLabel(updateItem.version), click: updateItem.install });
  }
  items.push({ type: 'separator' }, { label: t(`退出 ${PRODUCT_NAME_ZH}`), click: actions.quit });
  return items;
}
