import { userDataStorage } from './runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { ConfigManager } from './config';
import { writeTextAtomicSync } from './atomicJson';
import { applyWindowChrome } from './windowMaterial';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  builtinTheme,
  formatThemeJson,
  parseTheme,
  slugifyThemeId,
  type ThemeActivateOptions,
  type ThemeMetaInfo,
  type ThemesChangedPayload,
  type WorkbenchTheme
} from '../shared/theme';
import { t } from '../shared/i18n';

/**
 * 主题服务：内置深/浅 + userData/themes/<id>.json 自定义主题。
 * JSON 落盘一律 formatThemeJson（2 空格格式化）；id 即文件名，写死后不可改。
 */
export class ThemeService {
  readonly dir: string;
  private config: ConfigManager;

  constructor(userDataDir: string, config: ConfigManager) {
    this.dir = userDataStorage(userDataDir).resolve('app', 'themes');
    this.config = config;
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 自定义主题（目录内非法 JSON 跳过并告警，不让单个坏文件拖垮列表） */
  private userThemes(): WorkbenchTheme[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch {
      return [];
    }
    const out: WorkbenchTheme[] = [];
    for (const file of files) {
      const id = file.slice(0, -'.json'.length);
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8');
        const res = parseTheme(JSON.parse(raw), { id });
        if (res.ok && res.theme) out.push(res.theme);
        else if (!res.ok) console.warn(`[themes] 跳过无效主题 ${file}:`, res.errors.join('；'));
      } catch (e) {
        console.warn(`[themes] 跳过无法解析的主题 ${file}:`, (e as Error).message);
      }
    }
    return out;
  }

  list(): ThemeMetaInfo[] {
    const metaOf = (t: WorkbenchTheme): ThemeMetaInfo => ({
      id: t.id,
      name: t.name,
      appearance: t.appearance,
      builtin: !!t.builtin,
      preview: {
        bg: t.colors['bg-panel'],
        ink: t.colors['ink'],
        accent: t.colors['green']
      }
    });
    // 内置保持定义顺序（深色默认在前），自定义按显示名排序
    return [
      ...BUILTIN_THEMES.map(metaOf),
      ...this.userThemes()
        .map(metaOf)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    ];
  }

  get(id: string): WorkbenchTheme | undefined {
    const builtin = builtinTheme(id);
    if (builtin) return builtin;
    if (!isValidThemeId(id)) return undefined;
    try {
      const raw = fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf-8');
      const res = parseTheme(JSON.parse(raw), { id });
      return res.ok ? res.theme : undefined;
    } catch {
      return undefined;
    }
  }

  /** 工作区独立主题 id；未设置或指向已不存在的主题时为 undefined（视为跟随全局） */
  getWorkspaceThemeId(workspaceId?: string): string | undefined {
    const cfg = this.config.get();
    const wsId = workspaceId?.trim() || cfg.activeWorkspaceId;
    const mapped = cfg.themeByWorkspace?.[wsId];
    return mapped && this.get(mapped) ? mapped : undefined;
  }

  /** 生效主题：工作区独立主题 → 全局 config.themeId → 内置深色（任一环解析失败都顺次回退） */
  getActive(workspaceId?: string): WorkbenchTheme {
    const wsId = workspaceId?.trim() || this.config.get().activeWorkspaceId;
    const wsThemeId = this.getWorkspaceThemeId(wsId);
    if (wsThemeId) {
      const wsTheme = this.get(wsThemeId);
      if (wsTheme) return wsTheme;
    }
    const id = this.config.get().themeId || DEFAULT_THEME_ID;
    return this.get(id) ?? builtinTheme(DEFAULT_THEME_ID)!;
  }

  /** 新建自定义主题：按需求从默认黑色主题复制一份 */
  create(name: string): WorkbenchTheme {
    const trimmed = name.trim();
    const id = slugifyThemeId(trimmed, this.list().map((t) => t.id));
    const base = builtinTheme(DEFAULT_THEME_ID)!;
    const theme: WorkbenchTheme = {
      id,
      name: trimmed,
      appearance: base.appearance,
      colors: { ...base.colors },
      terminal: { ...base.terminal }
    };
    this.ensureDir();
    writeTextAtomicSync(path.join(this.dir, `${id}.json`), formatThemeJson(theme));
    return theme;
  }

  /** 保存自定义主题（校验 + 规整 + 格式化落盘）；内置主题与未知 id 拒绝 */
  save(
    theme: WorkbenchTheme
  ): { ok: true; theme: WorkbenchTheme } | { ok: false; errors: string[] } {
    const id = theme?.id;
    if (!id || builtinTheme(id)) {
      return { ok: false, errors: [t('内置主题不可覆盖保存，可「复制为新主题」后编辑')] };
    }
    if (!isValidThemeId(id)) {
      return { ok: false, errors: [t('主题 id "{{id}}" 不合法', { id })] };
    }
    const res = parseTheme(theme, { id });
    if (!res.ok) return { ok: false, errors: res.errors };
    this.ensureDir();
    writeTextAtomicSync(path.join(this.dir, `${id}.json`), formatThemeJson(res.theme!));
    return { ok: true, theme: res.theme! };
  }

  /**
   * 删除自定义主题并级联清理引用：全局 themeId 指向它时重置回内置深色，
   * 各工作区的独立主题覆盖指向它时清除（该区回到跟随全局）——界面经广播自动回落。
   */
  remove(id: string): { ok: boolean; error?: string } {
    if (builtinTheme(id)) return { ok: false, error: t('内置主题不可删除') };
    if (!isValidThemeId(id)) return { ok: false, error: t('主题 id "{{id}}" 不合法', { id }) };
    try {
      fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const cfg = this.config.get();
    const patch: { themeId?: string; themeByWorkspace?: Record<string, string> } = {};
    if ((cfg.themeId || DEFAULT_THEME_ID) === id) {
      patch.themeId = DEFAULT_THEME_ID;
    }
    const mapped = cfg.themeByWorkspace;
    if (mapped && Object.values(mapped).includes(id)) {
      patch.themeByWorkspace = Object.fromEntries(
        Object.entries(mapped).filter(([, v]) => v !== id)
      );
    }
    if (Object.keys(patch).length) this.config.update(patch);
    return { ok: true };
  }

  /**
   * 切换主题。缺省 scope=global 改全局默认；scope=workspace 只写该工作区覆盖
   * （followGlobal=true 则清除覆盖回到跟随全局，此时不要求 id）。
   */
  activate(
    id: string,
    opts?: ThemeActivateOptions
  ): { ok: boolean; error?: string; scope?: 'global' | 'workspace' } {
    const scope = opts?.scope === 'workspace' ? 'workspace' : 'global';
    const followGlobal = scope === 'workspace' && opts?.followGlobal === true;
    const themeId = String(id ?? '').trim().toLowerCase();
    if (!followGlobal) {
      // id 已被强制小写（slug 生成即小写，Linux 文件名大小写敏感）：报错附带提示，
      // 避免经 agent 工具传大写 id 时用户以为 id 本身可有大写
      if (!this.get(themeId)) return { ok: false, error: t('主题 "{{id}}" 不存在（主题 id 需全小写）', { id: themeId }) };
    }
    if (scope === 'workspace') {
      const cfg = this.config.get();
      const wsId = opts?.workspaceId?.trim() || cfg.activeWorkspaceId;
      if (!cfg.workspaces?.some((w) => w.id === wsId)) {
        return { ok: false, error: t('工作区不存在: {{id}}', { id: wsId }) };
      }
      const map = { ...(cfg.themeByWorkspace ?? {}) };
      if (followGlobal) delete map[wsId];
      else map[wsId] = themeId;
      this.config.update({ themeByWorkspace: map });
      return { ok: true, scope };
    }
    this.config.update({ themeId });
    return { ok: true, scope };
  }

  /** themes:list / themes:changed 共用的视图载荷（生效主题按活跃工作区解析） */
  payload(): ThemesChangedPayload {
    const cfg = this.config.get();
    const wsId = cfg.activeWorkspaceId;
    const active = this.getActive(wsId);
    const wsName = cfg.workspaces?.find((w) => w.id === wsId)?.name;
    return {
      activeId: active.id,
      active,
      themes: this.list(),
      globalThemeId: cfg.themeId || DEFAULT_THEME_ID,
      workspaceThemeId: this.getWorkspaceThemeId(wsId),
      activeWorkspaceId: wsId,
      ...(wsName ? { activeWorkspaceName: wsName } : {})
    };
  }

  /** 窗口底色/标题栏跟随主题（创建时的深色默认值由这里覆盖）；缺省按活跃工作区生效主题 */
  applyChrome(win: BrowserWindow, workspaceId?: string): void {
    const theme = this.getActive(workspaceId);
    applyWindowChrome(win, {
      panel: theme.colors['bg-frame'],
      ink: theme.colors['ink'],
      appearance: theme.appearance
    });
  }
}

function isValidThemeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}
