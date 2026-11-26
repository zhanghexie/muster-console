/** 自动更新（设置 → 关于、updater 通知/弹窗）词条 */
export const frag: Record<string, string> = {
  '版本': 'Version',
  '关于': 'About',
  '版本 · 检查更新': 'Version · Check for updates',
  '检查更新': 'Check for updates',
  '检查中…': 'Checking…',
  '加载版本信息…': 'Loading version info…',
  '已是最新版本': 'Up to date',
  '正在检查更新…': 'Checking for updates…',
  '重启并安装更新': 'Restart & install',
  '打开安装包文件夹': 'Open installer folder',
  '不立即重启也可以：退出应用时会自动完成安装。':
    'No rush — the update installs automatically when you quit the app.',
  '检查更新失败': 'Update check failed',
  '网络不可用或更新源不可达': 'network unavailable or update feed unreachable',
  '自动更新仅在 Windows 安装版（NSIS 安装包）上启用；macOS / Linux 请手动下载新安装包。':
    'Auto-update only runs on the Windows installer (NSIS). On macOS / Linux, download the new installer manually.',
  '发现新版本': 'Update available',
  '新版本 v{{version}} 已就绪，重启工作台后完成更新':
    'Version v{{version}} is ready — restart the workbench to finish updating',
  'v{{version}} 已下载完成，是否立即重启以完成更新？':
    'v{{version}} has been downloaded. Restart now to finish the update?',
  '自动安装未能完成，可在「设置 → 关于」打开已下载的安装包手动安装':
    'Automatic install did not complete. Open the downloaded installer manually via Settings → About.',
  '发现新版本，正在准备下载…': 'Update available — preparing download…',
  '发现新版本 v{{version}}，正在后台下载':
    'New version v{{version}} found — downloading in background',
  '正在下载 v{{version}}… {{percent}}%': 'Downloading v{{version}}… {{percent}}%',
  '重启并安装更新 v{{version}}': 'Restart to install v{{version}}',
  'v{{version}} 更新下载失败，可从「设置 → 关于」重新检查':
    'Failed to download v{{version}} — check again from Settings → About',
  '安装包已被清理，请重新检查更新':
    'The staged installer is gone — check for updates again',
  '更新已暂缓，将在下次退出工作台时完成安装':
    'Update deferred; it will complete installation the next time you exit the workbench',
  '有 {{n}} 个扩展任务运行中，更新已暂缓，将在下次退出工作台时完成安装':
    '{{n}} extension task(s) are running; the update is deferred and will install the next time you exit the workbench'
};
