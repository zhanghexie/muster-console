import { shell } from 'electron';
import { handle } from './handle';
import type { AppContext } from '../context';
import type { ThemeActivateOptions, WorkbenchTheme } from '../../shared/theme';
import { t } from '../../shared/i18n';

/**
 * 工作区激活/主题变化后的统一重放：窗口底色跟随生效主题 + 推送渲染层换肤。
 * 供 themes:activate 与工作区 open/switch/close 激活漏斗共用。
 */
export function reapplyActiveTheme(ctx: AppContext): void {
  const win = ctx.getWindow();
  if (!win) return;
  try {
    ctx.themes.applyChrome(win);
  } catch (e) {
    console.warn('[themes] applyChrome failed:', (e as Error).message);
  }
  win.webContents.send('themes:changed', ctx.themes.payload());
}

export function registerThemeIpc(ctx: AppContext): void {
  handle('themes:list', () => ({ ...ctx.themes.payload(), dir: ctx.themes.dir }));

  handle('themes:get', (_e, id: string) => {
    const theme = ctx.themes.get(String(id ?? ''));
    return theme ? { ok: true, theme } : { ok: false, error: t('主题不存在') };
  });

  handle('themes:create', (_e, name: string) => {
    try {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) return { ok: false, error: t('主题名不能为空') };
      const theme = ctx.themes.create(trimmed);
      ctx.getWindow()?.webContents.send('themes:changed', ctx.themes.payload());
      return { ok: true, theme };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle('themes:save', (_e, raw: WorkbenchTheme) => {
    try {
      const res = ctx.themes.save(raw);
      if (!res.ok) return { ok: false, errors: res.errors };
      // 保存当前主题 → 广播生效主题，界面随之刷新；非当前主题只刷新列表
      ctx.getWindow()?.webContents.send('themes:changed', ctx.themes.payload());
      return { ok: true, theme: res.theme };
    } catch (e) {
      return { ok: false, errors: [(e as Error).message] };
    }
  });

  handle('themes:remove', (_e, id: string) => {
    const res = ctx.themes.remove(String(id ?? ''));
    if (res.ok) ctx.getWindow()?.webContents.send('themes:changed', ctx.themes.payload());
    return res;
  });

  handle('themes:activate', (_e, id: string, opts?: ThemeActivateOptions) => {
    const res = ctx.themes.activate(String(id ?? ''), opts ?? {});
    if (res.ok) reapplyActiveTheme(ctx);
    return res;
  });

  handle('themes:revealDir', () => {
    try {
      ctx.themes.ensureDir();
    } catch {
      /* 目录建不出来时也交给 openPath 返回错误 */
    }
    return shell.openPath(ctx.themes.dir);
  });
}
