import fs from 'node:fs';
import { app, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { NsisUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import { t } from '../../shared/i18n';
import { isConfirmed } from '../../shared/confirmDialog';
import type { UpdaterProgress, UpdaterStatus } from '../../shared/updater';
import type { AppContext } from '../context';
import { setTrayUpdateItem } from '../tray';
import {
  UPDATE_NOTIFY_KEY,
  downloadFailedNotifyText,
  downloadStartNotifyText,
  taskbarProgressValue
} from './surface';

/**
 * 自动更新服务（electron-updater / NSIS）。
 *
 * - 更新源配置不在代码里：构建时由 electron-builder.yml 的 publish 块烘进
 *   resources/app-update.yml，运行期 updater 自动读取（迁移托管方 = 改 yml 重出包）。
 * - 仅 Windows 安装版启用（mac 未签名无法自动更新；dev 态默认关闭）。
 *   dev 联调：项目根放 dev-app-update.yml + 环境变量 MUSTER_UPDATER_DEV=1，
 *   详见 docs/features/auto-update.md。
 * - 策略：启动延迟静默检查（失败只记日志），发现新版自动后台下载（blockmap 差量）。
 *   下载中任务栏进度条 /「关于」页可见；发现新版与完成/失败各弹一次系统 toast（同键
 *   原地更新），窗口可见时再叠「立即重启？」确认弹窗 + 托盘菜单插「重启并安装更新」。
 *   用户可无视，退出应用时 autoInstallOnAppQuit
 *   兜底静默安装。
 * - 直接实例化 NsisUpdater（官方支持的姿势）而非 autoUpdater 单例：只为了把
 *   BaseUpdater 的 protected installerPath 暴露出来——「自动安装失败后手动运行安装包」
 *   的兜底需要知道它落在了哪（packaging.md：/S 静默升级遇 HKLM 残留可能强制 UAC）。
 */

const STARTUP_CHECK_DELAY_MS = 3 * 60_000;
const DEV_CHECK_DELAY_MS = 2_000;
/** download-progress 事件很密，广播给渲染层按 500ms 节流（状态变化始终即时推） */
const PROGRESS_BROADCAST_INTERVAL_MS = 500;
/** quitAndInstall 后多久内的 error 视为「安装触发失败」，走手动安装兜底提示 */
const INSTALL_FAIL_WINDOW_MS = 30_000;

class WorkbenchUpdater extends NsisUpdater {
  get downloadedInstallerPath(): string | null {
    return this.installerPath;
  }
}

let updater: WorkbenchUpdater | null = null;
let appCtx: AppContext | null = null;
let status: UpdaterStatus;
let installRequestedAt = 0;
let lastProgressSentAt = 0;
/** 每版本只播报一次（通知 + 弹窗），防止「跳过重启 → 再次检查」重复打扰 */
let announcedVersion: string | null = null;
/** 任务栏进度条缓存（值 + 写入时的窗口）：同值短路，但窗口重建后同值也要补设一次 */
let lastTaskbarWin: BrowserWindow | null = null;
let lastTaskbarValue = -1;
/**
 * 通知归属工区：发现更新那一刻的活动工区，全程固定——同键原地更新才成立。
 * 无活动工区时空串：NotifyStore 空桶仍可去重，此时只有 toast/任务栏/托盘/关于页可见。
 */
let notifyWsId = '';
/** 托盘「重启并安装更新」当前展示的版本（null = 不展示） */
let trayItemVersion: string | null = null;

function updaterEnabled(): boolean {
  return (
    process.platform === 'win32' &&
    (app.isPackaged || process.env.MUSTER_UPDATER_DEV === '1')
  );
}

export function getUpdaterStatus(): UpdaterStatus {
  return status;
}

function setStatus(patch: Partial<UpdaterStatus>, forceBroadcast = true): void {
  status = { ...status, ...patch };
  const win = appCtx?.getWindow();
  syncTaskbar(win);
  syncTrayItem();
  // 节流只对进度刷新生效；forceBroadcast（状态迁移）永远直发
  if (!forceBroadcast) {
    const now = Date.now();
    if (now - lastProgressSentAt < PROGRESS_BROADCAST_INTERVAL_MS) return;
    lastProgressSentAt = now;
  }
  win?.webContents.send('updater:status', status);
}

/** 活动工区 id（无活动工区时空串——对可见性的影响见 notifyWsId 注释） */
function activeWsId(): string {
  return appCtx?.config.get().activeWorkspaceId || '';
}

/**
 * 更新类通知统一出口：归属 notifyWsId、全程同键（UPDATE_NOTIFY_KEY）原地更新、
 * 一律系统 toast（应用内通知面板已移除）。「全程同键」这一不变量靠这里单点维持，
 * 调用点不得自拼参数。
 */
function pushUpdaterNotify(text: string, updateKey: string = UPDATE_NOTIFY_KEY): void {
  appCtx?.notify.push({
    workspaceId: notifyWsId,
    sessionId: 'updater:app',
    sessionName: '',
    text,
    updateKey,
    update: true,
    toast: true
  });
}

function syncTaskbar(win: BrowserWindow | null | undefined): void {
  const v = taskbarProgressValue(status.state, status.progress?.percent);
  if (v === lastTaskbarValue && win === lastTaskbarWin) return;
  lastTaskbarValue = v;
  lastTaskbarWin = win ?? null;
  win?.setProgressBar(v);
}

function syncTrayItem(): void {
  const v = status.state === 'downloaded' ? status.availableVersion ?? null : null;
  if (v === trayItemVersion) return;
  trayItemVersion = v;
  setTrayUpdateItem(v ? { version: v, install: installNow } : null);
}

/**
 * 挂事件 + 排启动检查。在 registerIpc 链里调用一次；未启用（mac/linux/dev）
 * 时仍保持 unsupported 状态快照，渲染层照常可显示版本号。
 */
export function initUpdater(ctx: AppContext): void {
  appCtx = ctx;
  const enabled = updaterEnabled();
  status = { state: enabled ? 'idle' : 'unsupported', currentVersion: app.getVersion() };

  if (!enabled) return;
  updater = new WorkbenchUpdater();
  if (!app.isPackaged) updater.forceDevUpdateConfig = true;
  // 更新链路问题必须可查：主进程日志统一带前缀；debug 级噪声丢掉
  updater.logger = {
    info: (...args: unknown[]) => console.log('[updater]', ...args),
    warn: (...args: unknown[]) => console.warn('[updater]', ...args),
    error: (...args: unknown[]) => console.error('[updater]', ...args)
  };

  updater.on('checking-for-update', () => {
    setStatus({ state: 'checking', errorMessage: undefined });
  });
  updater.on('update-available', (info: UpdateInfo) => {
    setStatus({
      state: 'downloading',
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      // merge 语义必须显式清残留：失败/中断后重新检查时，陈旧 progress 会让
      // 渲染层跳过「正在准备下载」分支并闪现旧百分比（首个新进度事件才自愈）
      progress: undefined,
      errorMessage: undefined
    });
    notifyUpdateStart(info.version);
  });
  updater.on('update-not-available', () => {
    setStatus({
      state: 'idle',
      checkedAt: Date.now(),
      availableVersion: undefined,
      progress: undefined,
      errorMessage: undefined
    });
  });
  updater.on('download-progress', (p: ProgressInfo) => {
    // 幽灵进度防御：downloaded/error 后迟到的 progress 事件不得把状态机倒回下载中
    if (status.state !== 'downloading') return;
    const progress: UpdaterProgress = {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    };
    setStatus({ state: 'downloading', progress }, false);
    // 真下载进行中（缓存命中秒发 downloaded 没有进度事件）：解除「已就绪」播报守卫，
    // 同版本撤回重发/缓存损坏重下后，才能再次走完 下载中→已就绪 并重新播报
    announcedVersion = null;
  });
  updater.on('update-downloaded', (info: UpdateInfo) => {
    setStatus({
      state: 'downloaded',
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      progress: undefined,
      installerPath: updater?.downloadedInstallerPath ?? undefined,
      checkedAt: Date.now()
    });
    announceDownloaded(info.version);
  });
  updater.on('error', (err: Error) => {
    console.error('[updater] error:', err);
    // 安装触发失败（spawn/EACCES、UAC 被拒等）：版本已下载，转手动兜底而不是打回 error 态
    if (installRequestedAt && Date.now() - installRequestedAt < INSTALL_FAIL_WINDOW_MS) {
      installRequestedAt = 0;
      setStatus({ state: 'downloaded', errorMessage: errorMessageOf(err) });
      announceInstallFallback(err);
      return;
    }
    // 其余错误（检查/下载失败）：任务栏/托盘由 setStatus 回收；下载途中的失败还要把
    // 同键通知收口成「下载失败」，不能永停「正在后台下载」。启动静默检查等
    // 非下载态的失败不满足条件（state 仍是 checking），不会凭空报「下载失败」；
    // 渲染层「关于」页会显示失败详情。
    const failedDuringDownload = status.state === 'downloading';
    setStatus({ state: 'error', checkedAt: Date.now(), errorMessage: errorMessageOf(err) });
    if (failedDuringDownload) {
      pushUpdaterNotify(downloadFailedNotifyText(status.availableVersion ?? ''));
    }
  });

  const delay = app.isPackaged ? STARTUP_CHECK_DELAY_MS : DEV_CHECK_DELAY_MS;
  const timer = setTimeout(() => {
    void checkNow();
  }, delay);
  // 退出在即就不必再检查了
  timer.unref?.();
}

/** 手动/定时检查；进行中（checking/downloading）时忽略重复触发。返回当前快照。 */
export async function checkNow(): Promise<UpdaterStatus> {
  if (!updater) return status;
  if (status.state === 'checking' || status.state === 'downloading') return status;
  setStatus({ state: 'checking', errorMessage: undefined });
  try {
    await updater.checkForUpdates();
  } catch {
    // error 事件已统一处理状态与日志；这里只吞掉 promise 拒绝
  }
  return status;
}

/** 静默安装 + 装完自启。未就绪时是 no-op。 */
export function installNow(): void {
  if (!updater || status.state !== 'downloaded') return;
  // X7-F03：扩展任务在跑时 quitAndInstall 会先撞 before-quit 确认门，用户选
  // 「返回工作台」后安装静默中止——直接暂缓并提示，退出时 autoInstallOnAppQuit 兜底。
  const running = appCtx?.extensionSystem?.runningTasks() ?? [];
  if (running.length) {
    pushUpdaterNotify(
      t('有 {{n}} 个扩展任务运行中，更新已暂缓，将在下次退出工作台时完成安装', { n: running.length })
    );
    return;
  }
  installRequestedAt = Date.now();
  updater.quitAndInstall(true, true);
}

/**
 * X7-F03：安装触发的 quit 被 before-quit 扩展任务确认门取消（「返回工作台」）。
 * 清掉 installRequestedAt 残留（否则占 30s 安装失败窗，后续无关 error 会被误判
 * 成「安装触发失败」）并 toast 告知更新已暂缓；下次退出仍由 autoInstallOnAppQuit
 * 兜底安装，托盘「重启并安装更新」项保留可重试。
 */
export function noteInstallDeferred(): void {
  if (!installRequestedAt) return;
  installRequestedAt = 0;
  pushUpdaterNotify(t('更新已暂缓，将在下次退出工作台时完成安装'));
}

/** 打开已下载安装包所在文件夹（自动安装失败后的手动兜底入口） */
export async function revealUpdaterInstaller(): Promise<boolean> {
  const p = status.installerPath ?? updater?.downloadedInstallerPath ?? null;
  if (!p || !fs.existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
}

function errorMessageOf(err: Error): string {
  return err?.message || String(err);
}

/**
 * 下载开始：弹「发现新版本，正在后台下载」系统 toast（后续状态同键原地更新）。
 * 同版本已播报过「已就绪」时不再覆盖——「跳过重启 → 再次检查」的重复检查会重发
 * update-available（缓存命中随即秒发 downloaded），若不守卫，通知会被倒回
 * 「正在后台下载」且因 announcedVersion 早退永远不再转「已就绪」。
 */
function notifyUpdateStart(version: string): void {
  if (announcedVersion === version) return;
  const ctx = appCtx;
  if (!ctx) return;
  notifyWsId = activeWsId();
  pushUpdaterNotify(downloadStartNotifyText(version));
}

/**
 * 下载完成播报：必弹系统 toast（窗口可见与否都弹，toast 是不依赖应用内界面的
 * 唯一保证可见信号）；窗口可见再叠加「立即重启？」确认弹窗。
 */
function announceDownloaded(version: string): void {
  const ctx = appCtx;
  if (!ctx || announcedVersion === version) return;
  announcedVersion = version;
  pushUpdaterNotify(t('新版本 v{{version}} 已就绪，重启工作台后完成更新', { version }));
  const win = ctx.getWindow();
  if (win?.isVisible()) {
    void ctx.ui
      .confirm(t('发现新版本'), t('v{{version}} 已下载完成，是否立即重启以完成更新？', { version }))
      .then((yes) => {
        if (isConfirmed(yes)) installNow();
      });
  }
}

/** 安装触发失败的手动兜底提示（packaging.md 已知边界：/S 遇 HKLM 残留强制 UAC）。 */
function announceInstallFallback(err: Error): void {
  if (!appCtx) return;
  console.error('[updater] install failed, fallback to manual:', err);
  pushUpdaterNotify(
    t('自动安装未能完成，可在「设置 → 关于」打开已下载的安装包手动安装'),
    'updater:install-fallback'
  );
}

