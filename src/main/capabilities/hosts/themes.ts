import type { AppContext } from '../../context';
import type { ThemeActivateOptions, WorkbenchTheme } from '../../../shared/theme';
import { t } from '../../../shared/i18n';

/** 主题变更推送：与 IPC themes:* 同一事件，UI 即时刷新（载荷含全局/工作区主题信息） */
function broadcast(ctx: AppContext): void {
  ctx.getWindow()?.webContents.send('themes:changed', ctx.themes.payload());
}

function pickSection(
  raw: unknown,
  section: 'colors' | 'terminal'
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(t('{{section}} 必须是对象（键为 token 名，值为颜色字符串）', { section }));
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(t('{{key}} 的值必须是字符串，当前为 {{value}}', { key: `${section}.${k}`, value: JSON.stringify(v) }));
    }
    out[k] = v;
  }
  return out;
}

/**
 * 调度 Agent 的主题增删改查工具（Worker/扩展白名单不含 themes.*）。
 * 与设置「主题外观」页同一 ThemeService 底座：校验、2 空格格式化 JSON 落盘、
 * themes:changed 广播全一致——Agent 改主题，界面即时刷新。
 */
export const themesHost = {
  'themes.list': (ctx: AppContext) => ({
    ...ctx.themes.payload(),
    dir: ctx.themes.dir
  }),

  'themes.get': (ctx: AppContext, args: { id: string }) => {
    const theme = ctx.themes.get(String(args?.id ?? ''));
    if (!theme) throw new Error(t('主题不存在: {{id}}', { id: args?.id }));
    return theme;
  },

  'themes.create': (ctx: AppContext, args: { name: string }) => {
    const name = String(args?.name ?? '').trim();
    if (!name) throw new Error(t('name 必须是非空字符串'));
    const theme = ctx.themes.create(name);
    broadcast(ctx);
    return theme;
  },

  'themes.update': (
    ctx: AppContext,
    args: {
      id: string;
      name?: string;
      appearance?: 'dark' | 'light';
      colors?: Record<string, string>;
      terminal?: Record<string, string>;
    }
  ) => {
    const id = String(args?.id ?? '');
    const cur = ctx.themes.get(id);
    if (!cur) throw new Error(t('主题不存在: {{id}}', { id: id || t('(空)') }));
    const name =
      args.name !== undefined ? String(args.name).trim() : undefined;
    const appearance =
      args.appearance === 'light' ? 'light' : args.appearance === 'dark' ? 'dark' : undefined;
    const colors = pickSection(args.colors, 'colors');
    const terminal = pickSection(args.terminal, 'terminal');
    const next: WorkbenchTheme = {
      ...cur,
      ...(name ? { name } : {}),
      ...(appearance ? { appearance } : {}),
      ...(colors ? { colors: { ...cur.colors, ...colors } } : {}),
      ...(terminal ? { terminal: { ...cur.terminal, ...terminal } } : {})
    };
    // save 内部 parseTheme 校验：内置主题拒绝、未知键/非法色值报错指名字段
    const res = ctx.themes.save(next);
    if (!res.ok) throw new Error(res.errors.join('；'));
    broadcast(ctx);
    return res.theme;
  },

  'themes.activate': (ctx: AppContext, args: { id?: string } & ThemeActivateOptions) => {
    const res = ctx.themes.activate(String(args?.id ?? ''), args ?? {});
    if (!res.ok) throw new Error(res.error);
    const win = ctx.getWindow();
    if (win) ctx.themes.applyChrome(win);
    broadcast(ctx);
    const view = ctx.themes.payload();
    return {
      ok: true,
      scope: res.scope,
      globalThemeId: view.globalThemeId,
      workspaceThemeId: view.workspaceThemeId,
      activeId: view.activeId
    };
  },

  'themes.remove': (ctx: AppContext, args: { id: string }) => {
    const res = ctx.themes.remove(String(args?.id ?? ''));
    if (!res.ok) throw new Error(res.error);
    broadcast(ctx);
    return { ok: true };
  }
};
