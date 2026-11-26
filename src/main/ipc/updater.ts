import { handle } from './handle';
import type { AppContext } from '../context';
import { checkNow, getUpdaterStatus, initUpdater, installNow, revealUpdaterInstaller } from '../updater';

/** 自动更新：状态快照 + 手动检查/安装/兜底入口。初始化（事件挂载、启动检查）也挂在这里。 */
export function registerUpdaterIpc(ctx: AppContext): void {
  initUpdater(ctx);
  handle('updater:getState', () => getUpdaterStatus());
  handle('updater:check', () => checkNow());
  handle('updater:install', () => {
    installNow();
    return { ok: true };
  });
  handle('updater:revealInstaller', () => revealUpdaterInstaller());
}
