/**
 * 自动更新（electron-updater）主⇄渲染层共享类型。
 * 状态机由 src/main/updater/index.ts 维护，经 `updater:status` 事件全量推送；
 * 渲染层也可 `updater:getState` 拉当前快照。
 */

export type UpdaterState =
  /** 非 Windows 安装版（mac/linux/dev）不启用自动更新 */
  | 'unsupported'
  | 'idle'
  | 'checking'
  /** update-available 后自动进入；progress 持续刷新 */
  | 'downloading'
  /** 安装包已就绪：可 quitAndInstall，或点重启用；不操作则退出应用时静默安装 */
  | 'downloaded'
  | 'error';

export interface UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdaterStatus {
  state: UpdaterState;
  /** 当前运行的应用版本（app.getVersion()），任何状态都携带 */
  currentVersion: string;
  /** 远端可用的新版本号（发现更新后携带） */
  availableVersion?: string;
  /** 发布说明（GitHub Release body / latest.yml releaseNotes） */
  releaseNotes?: string | null;
  progress?: UpdaterProgress;
  /** error 态的人类可读信息；downloaded 态若安装触发失败也会带上 */
  errorMessage?: string;
  /** 已下载安装包的本地路径（downloaded 态携带；「手动安装」兜底用） */
  installerPath?: string;
  /** 最近一次完成检查的时间戳（idle/error 态） */
  checkedAt?: number;
}
