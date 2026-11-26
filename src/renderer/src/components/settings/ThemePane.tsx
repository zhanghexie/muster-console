import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  THEME_UI_GROUPS,
  formatCssColor,
  parseCssColor,
  parseTheme,
  themeColorAllowsAlpha,
  type RgbaColor,
  type ThemeListView,
  type ThemeMetaInfo,
  type WorkbenchTheme
} from '../../../../shared/theme';
import { applyTheme } from '../../theme';
import { IconPlus, IconTrash } from '../icons';
import { Chevron, FieldRow, SettingRow, SettingsRows, SettingsSection } from './shared';
import { CustomSelect } from '../CustomSelect';
import { UserAvatarSettings } from './UserAvatarSettings';
import { WorkspaceAccentSettings } from './WorkspaceAccentSettings';
import { AppConfirmDialog } from '../AppConfirmDialog';

/**
 * 设置「外观」页：内置深/浅 + 自定义主题（userData/themes/*.json），缩略图卡片点选即切换。
 * 色盘编辑（取色器 + 透明度 + 文本），编辑当前主题时实时预览（不落盘），
 * 「保存」才写文件（恒为 2 空格格式化 JSON）并广播刷新。全部操作即时生效。
 */
export function ThemePane(): React.JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<ThemeListView | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [theme, setTheme] = useState<WorkbenchTheme | null>(null);
  /** 编辑稿（结构化，非 JSON 文本）；null = 未编辑 */
  const [draft, setDraft] = useState<WorkbenchTheme | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [okMsg, setOkMsg] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ThemeMetaInfo | null>(null);

  const dirty = !!draft;
  /**
   * 切换主题的作用域：当前工作区设了独立主题 → 只切本工作区；否则切全局默认。
   * scopeView 显式传入刚拉取的列表（reload 路径），避免 React state 未更新时误判作用域。
   */
  const activateScoped = (
    id: string,
    scopeView: ThemeListView | null = view
  ): Promise<{ ok: boolean; error?: string }> =>
    scopeView?.workspaceThemeId
      ? window.api.themes.activate(id, { scope: 'workspace' })
      : window.api.themes.activate(id);
  const selectTheme = async (id: string, scopeView?: ThemeListView): Promise<void> => {
    try {
      setBusy(true);
      setDeleteTarget(null);
      setErrors([]);
      setOkMsg('');
      setSelectedId(id);
      const res = await window.api.themes.get(id);
      if (res.ok) {
        setTheme(res.theme);
        setDraft(null);
        // 选中即切换（幂等；已是当前主题时无副作用），保证编辑稿始终有实时预览
        const act = await activateScoped(id, scopeView ?? null);
        if (!act.ok) setErrors([act.error ?? t('切换失败')]);
      } else {
        setErrors([res.error]);
      }
    } finally {
      setBusy(false);
    }
  };

  const reload = async (preferId?: string): Promise<ThemeListView> => {
    const v = await window.api.themes.list();
    setView(v);
    const id =
      preferId && v.themes.some((t) => t.id === preferId) ? preferId : v.activeId;
    await selectTheme(id, v);
    return v;
  };

  useEffect(() => {
    void reload();
    // 别处（或本页保存/切换/Agent 工具）推送的主题变更 → 同步列表与「使用中」标记
    return window.api.on('themes:changed', (p) => {
      setView((v) =>
        v
          ? {
              ...v,
              activeId: p.activeId,
              themes: p.themes,
              globalThemeId: p.globalThemeId,
              workspaceThemeId: p.workspaceThemeId
            }
          : v
      );
    });
  }, []);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      setBusy(true);
      setErrors([]);
      setOkMsg('');
      await fn();
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 编辑稿：改色即预览（仅当前主题；不落盘） ---------- */

  const sectionOf = (t: WorkbenchTheme, section: 'colors' | 'terminal'): Record<string, string> =>
    (section === 'colors' ? t.colors : t.terminal) as Record<string, string>;

  const editDraft = (next: WorkbenchTheme): void => {
    setDraft(next);
    setOkMsg('');
  };

  const preview = useMemo(() => draft ?? theme, [draft, theme]);
  /** 预览/保存前的校验（复用 parseTheme：未知键、非法色值、空名都在这里报） */
  const draftErrors = useMemo(() => {
    if (!dirty || !preview || !theme) return [] as string[];
    const raw = { ...preview, id: theme.id };
    const res = parseTheme(raw, { id: theme.id });
    return res.ok ? [] : res.errors;
  }, [dirty, preview, theme]);

  // 实时预览：编辑当前主题且校验通过 → 直接应用到界面（applyTheme 只写内存 CSS 变量与缓存，不落盘）
  useEffect(() => {
    if (!dirty || !preview || !view) return;
    if (selectedId !== view.activeId) return;
    if (draftErrors.length > 0) return;
    applyTheme({ ...preview, id: selectedId }, { persist: false });
  }, [dirty, preview, view, selectedId, draftErrors]);

  const setColor = (section: 'colors' | 'terminal', key: string, value: string): void => {
    if (!theme) return;
    const base = draft ?? theme;
    editDraft({
      ...base,
      [section]: { ...base[section], [key]: value }
    } as WorkbenchTheme);
  };

  const onSwatch = (section: 'colors' | 'terminal', key: string, hex: string): void => {
    const cur = preview ? sectionOf(preview, section)[key] ?? '#000000' : '#000000';
    const parsed = parseCssColor(cur);
    const a = parsed?.a ?? 1;
    setColor(section, key, formatCssColor({ ...parseCssColor(hex)!, a }));
  };

  const onAlpha = (section: 'colors' | 'terminal', key: string, pct: number): void => {
    const cur = preview ? sectionOf(preview, section)[key] ?? '#000000' : '#000000';
    const parsed = parseCssColor(cur);
    if (!parsed) return;
    setColor(section, key, formatCssColor({ ...parsed, a: pct / 100 }));
  };

  const save = (): Promise<void> =>
    run(async () => {
      if (!theme || !draft) return;
      if (draftErrors.length > 0) {
        setErrors(draftErrors);
        return;
      }
      const res = await window.api.themes.save({ ...draft, id: theme.id });
      if (!res.ok) {
        setErrors(res.errors);
        return;
      }
      setTheme(res.theme);
      setDraft(null);
      const isActive = view?.activeId === theme.id;
      setOkMsg(isActive ? t('已保存，界面已按新配色刷新') : t('已保存（未在使用中，切到该主题即可生效）'));
    });

  const reset = (): Promise<void> =>
    run(async () => {
      if (!theme) return;
      // 回到已保存版本；当前主题需把预览残留刷回去
      await selectTheme(theme.id);
      if (view && theme.id === view.activeId) applyTheme(theme);
    });

  const createTheme = (name: string): Promise<void> =>
    run(async () => {
      const res = await window.api.themes.create(name);
      if (!res.ok) {
        setErrors([res.error]);
        return;
      }
      setCreating(false);
      setNewName('');
      await reload(res.theme.id);
      setOkMsg(t('已从「深色（默认）」复制出新主题，改颜色后保存即可'));
    });

  const copyCurrentAsNew = (): Promise<void> =>
    run(async () => {
      if (!theme) return;
      const res = await window.api.themes.create(t('{{name}} 副本', { name: t(theme.name) }));
      if (!res.ok) {
        setErrors([res.error]);
        return;
      }
      const copied: WorkbenchTheme = {
        ...res.theme,
        appearance: theme.appearance,
        colors: { ...theme.colors },
        terminal: { ...theme.terminal }
      };
      const saved = await window.api.themes.save(copied);
      if (!saved.ok) {
        setErrors(saved.errors);
        return;
      }
      await reload(res.theme.id);
      setOkMsg(t('已复制为新主题'));
    });

  const activate = (id: string): Promise<void> =>
    run(async () => {
      const res = await activateScoped(id);
      if (!res.ok) setErrors([res.error ?? t('切换失败')]);
    });

  /** 工作区独立主题：选空 = 清除覆盖回到跟随全局 */
  const setWorkspaceTheme = (id: string): Promise<void> =>
    run(async () => {
      const res = id
        ? await window.api.themes.activate(id, { scope: 'workspace' })
        : await window.api.themes.activate('', { scope: 'workspace', followGlobal: true });
      if (!res.ok) setErrors([res.error ?? t('切换失败')]);
    });

  /** 按 id 删除：列表行内与编辑器底部共用；不先选中/切换该主题 */
  const remove = (id: string): Promise<void> =>
    run(async () => {
      const target = view?.themes.find((th) => th.id === id);
      if (!target || target.builtin) return;
      // 主进程级联清理引用：全局默认回退深色，各工作区覆盖清除（该区回到跟随全局）
      const wasActive = !!view && id === view.activeId;
      const res = await window.api.themes.remove(id);
      if (!res.ok) {
        setErrors([res.error ?? t('删除失败')]);
        return;
      }
      // 删的不是当前选中项则原地保住选中；否则回落到新的生效主题
      const v = await reload(selectedId !== id ? selectedId : undefined);
      setOkMsg(
        wasActive ? t('已删除，界面回落到「{{name}}」', { name: t(v.active.name) }) : t('已删除')
      );
    });

  if (!view || !theme) {
    return <p className="empty-hint">{t('加载主题…')}</p>;
  }

  const activeId = view.activeId;
  const globalTheme = view.themes.find((th) => th.id === view.globalThemeId);
  const isBuiltin = !!theme.builtin;
  const isSelectedActive = selectedId === activeId;
  const editable = !isBuiltin;
  const rowMeta = (meta: ThemeMetaInfo): React.JSX.Element => {
    return (
      // 行内含删除按钮，根不能是 button（禁嵌套交互元素）；键盘经 Enter/Space 选中
      <div
        key={meta.id}
        role="button"
        tabIndex={0}
        data-theme-id={meta.id}
        className={`theme-row theme-card${selectedId === meta.id ? ' is-selected' : ''}`}
        onClick={() => {
          // 点行 = 选中并按当前作用域切换（selectTheme 内含激活：工作区独立主题只切本区，否则切全局）
          void selectTheme(meta.id);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void selectTheme(meta.id);
          }
        }}
        title={meta.builtin ? t('内置主题（不可编辑，可复制为新主题）') : meta.id}
      >
        {/* 缩略图：主题自己的底色 / 文字色 / 强调色画一个迷你窗口 */}
        <span className="theme-thumb" aria-hidden="true" style={{ background: meta.preview.bg }}>
          <i className="theme-thumb-side" style={{ background: meta.preview.ink }} />
          <i className="theme-thumb-line" style={{ background: meta.preview.ink }} />
          <i className="theme-thumb-line is-short" style={{ background: meta.preview.ink }} />
          <i className="theme-thumb-dot" style={{ background: meta.preview.accent }} />
        </span>
        <span className="theme-card-meta">
          {/* 内置主题名（深色（默认）/浅色）是数据 key，随语言翻译；自定义名 t() 恒等 */}
          <span className="theme-row-name">{t(meta.name)}</span>
          {view.workspaceThemeId === meta.id && (
            <span className="theme-kind theme-scope-ws">{t('本工作区')}</span>
          )}
          {view.workspaceThemeId && view.globalThemeId === meta.id && (
            <span className="theme-kind">{t('全局默认')}</span>
          )}
          {meta.id === activeId && <span className="theme-active-pill">{t('使用中')}</span>}
        </span>
        {!meta.builtin && (
          <button
            type="button"
            className="theme-row-del"
            disabled={busy}
            title={t('删除主题文件；引用它的界面会自动回落（全局回退深色，工作区回到跟随全局）')}
            aria-label={t('删除主题「{{name}}」', { name: t(meta.name) })}
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(meta);
            }}
          >
            <IconTrash size={11} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="settings-section theme-pane">
      <AppConfirmDialog open={!!deleteTarget} title={t('确认删除主题「{{name}}」？', { name: deleteTarget ? t(deleteTarget.name) : '' })}
        detail={t('删除主题文件；引用它的界面会自动回落（全局回退深色，工作区回到跟随全局）')}
        confirmLabel={t('确认删除')} danger onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); if (target) void remove(target.id); }}/>

      <SettingsSection
        title={t('主题')}
        side={
          <button
            type="button"
            className="btn tiny ghost"
            data-settings-item="appearance-folder"
            title={t('阴影等高级项与手工编辑在主题 JSON 文件里改')}
            onClick={() => void window.api.themes.revealDir()}
          >
            {t('打开主题文件夹')}
          </button>
        }
      >
        <div className="theme-grid">
          {view.themes.filter((th) => th.builtin).map(rowMeta)}
          {view.themes.filter((th) => !th.builtin).map(rowMeta)}
          {creating ? (
            <div className="theme-create-box">
              <input
                className="ui-input compact"
                autoFocus
                placeholder={t('新主题名，如 夜蓝')}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter' && newName.trim()) {
                    e.preventDefault();
                    void createTheme(newName);
                  }
                  if (e.key === 'Escape') setCreating(false);
                }}
              />
              <div className="theme-create-actions">
                <button
                  type="button"
                  className="btn tiny primary"
                  disabled={!newName.trim() || busy}
                  onClick={() => void createTheme(newName)}
                >
                  {t('创建')}
                </button>
                <button type="button" className="btn tiny" onClick={() => setCreating(false)}>
                  {t('取消')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="theme-new-card"
              data-settings-item="appearance-new"
              disabled={busy}
              onClick={() => {
                setCreating(true);
                setNewName('');
              }}
            >
              <IconPlus size={14} />
              <span>{t('新建主题')}</span>
            </button>
          )}
        </div>

        <SettingsRows>
          <SettingRow
            item="appearance-workspace-theme"
            title={t('这个工作区单独用')}
            desc={
              view.workspaceThemeId
                ? t('本工作区使用独立主题，切换工作区会自动换肤')
                : t('跟随全局默认「{{name}}」', { name: t(globalTheme?.name ?? '') })
            }
          >
            <CustomSelect
              className="s-select"
              value={view.workspaceThemeId ?? ''}
              ariaLabel={t('当前工作区主题')}
              onChange={(v) => void setWorkspaceTheme(v)}
              options={[
                { value: '', label: t('跟随全局默认') },
                ...view.themes.map((th) => ({ value: th.id, label: t(th.name) }))
              ]}
            />
          </SettingRow>
        </SettingsRows>
      </SettingsSection>

      <WorkspaceAccentSettings />

      <SettingsSection
        title={t('配色 · {{name}}', { name: t(theme.name) })}
        side={
          isBuiltin ? <span className="s-tag">{t('内置主题不可编辑')}</span> : undefined
        }
      >
        <div className="theme-editor">
          <SettingsRows>
            <SettingRow
              item="appearance-mode"
              title={t('外观')}
              desc={isBuiltin ? t('内置主题：点「复制为新主题」后再改颜色。') : undefined}
            >
              <div className="s-seg" role="group" aria-label={t('外观')}>
                {(['dark', 'light'] as const).map((ap) => (
                  <button
                    key={ap}
                    type="button"
                    className={preview?.appearance === ap ? 'is-on' : undefined}
                    aria-pressed={preview?.appearance === ap}
                    disabled={!editable || busy}
                    onClick={() =>
                      preview && editDraft({ ...preview, appearance: ap })
                    }
                  >
                    {ap === 'dark' ? t('深色') : t('浅色')}
                  </button>
                ))}
              </div>
            </SettingRow>
            <FieldRow item="appearance-name" label={t('主题名')}>
              <input
                className="s-input"
                style={{ maxWidth: 280 }}
                disabled={!editable || busy}
                value={preview?.name ?? ''}
                onChange={(e) =>
                  preview && editDraft({ ...preview, name: e.target.value })
                }
              />
            </FieldRow>
          </SettingsRows>

          <div className="theme-groups">
            {THEME_UI_GROUPS.map((g) => (
              <details
                key={g.id}
                className="theme-group"
                data-settings-item={`theme-group:${g.id}`}
                open={!g.collapsed}
              >
                <summary>
                  <Chevron />
                  <span>{t(g.label)}</span>
                  <span className="theme-group-count">{g.keys.length}</span>
                </summary>
                <div className="theme-group-body">
                  {g.keys.map((item) => {
                    const raw = preview ? sectionOf(preview, g.section)[item.key] ?? '' : '';
                    const parsed = parseCssColor(raw);
                    const alphaAllowed = themeColorAllowsAlpha(g.section, item.key);
                    const valid =
                      (parsed !== null && (alphaAllowed || parsed.a === 1)) || raw.trim() === '';
                    return (
                      <div key={item.key} className="theme-color-row" data-settings-item={`theme-color:${item.key}`}>
                        <span className="theme-color-label" title={item.key}>
                          {t(item.label)}
                        </span>
                        <input
                          type="color"
                          className="theme-color-swatch"
                          disabled={!editable || busy || !parsed}
                          value={parsed ? cssHexOf(parsed) : '#000000'}
                          onChange={(e) => onSwatch(g.section, item.key, e.target.value)}
                          aria-label={`${t(item.label)} ${t('取色')}`}
                        />
                        <input
                          type="range"
                          className="theme-color-alpha"
                          min={0}
                          max={100}
                          step={1}
                          disabled={!editable || busy || !parsed || !alphaAllowed}
                          value={alphaAllowed && parsed ? Math.round(parsed.a * 100) : 100}
                          title={!alphaAllowed ? t('背景和文字保持不透明') : undefined}
                          onChange={(e) => onAlpha(g.section, item.key, Number(e.target.value))}
                          aria-label={`${t(item.label)} ${t('透明度')}`}
                        />
                        <input
                          type="text"
                          className={`ui-input compact theme-color-text${valid ? '' : ' is-bad'}`}
                          spellCheck={false}
                          disabled={!editable || busy}
                          value={raw}
                          onChange={(e) => setColor(g.section, item.key, e.target.value)}
                          aria-label={`${t(item.label)} ${t('色值')}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>

          {errors.length > 0 && (
            <ErrorTip message={errors.join('\n')} />
          )}
          {draftErrors.length > 0 && errors.length === 0 && (
            <ErrorTip message={draftErrors.join('\n')} />
          )}
          {okMsg && <p className="settings-ok">{okMsg}</p>}

          <div className="theme-editor-actions">
            {!isSelectedActive && (
              <button
                type="button"
                className="btn primary tiny"
                disabled={busy}
                onClick={() => void activate(theme.id)}
              >
                {t('使用该主题')}
              </button>
            )}
            {editable ? (
              <>
                <button
                  type="button"
                  className={`btn tiny${isSelectedActive ? ' primary' : ''}`}
                  disabled={busy || !dirty || draftErrors.length > 0}
                  title={dirty ? undefined : t('无改动')}
                  onClick={() => void save()}
                >
                  {isSelectedActive ? t('保存并刷新界面') : t('保存')}
                </button>
                {dirty && (
                  <button
                    type="button"
                    className="btn tiny"
                    disabled={busy}
                    onClick={() => void reset()}
                  >
                    {t('重置')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn tiny danger"
                  disabled={busy}
                  title={t('删除主题文件；引用它的界面会自动回落（全局回退深色，工作区回到跟随全局）')}
                  onClick={() => setDeleteTarget(view.themes.find(meta => meta.id === theme.id) ?? null)}
                >
                  {t('删除')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn tiny"
                disabled={busy}
                onClick={() => void copyCurrentAsNew()}
              >
                {t('复制为新主题')}
              </button>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('你的头像')}>
        <SettingsRows className="s-rows-flush">
          <UserAvatarSettings />
        </SettingsRows>
      </SettingsSection>

    </div>
  );
}

function cssHexOf(c: RgbaColor): string {
  return (
    '#' +
    [c.r, c.g, c.b]
      .map((x) => Math.round(x).toString(16).padStart(2, '0'))
      .join('')
  );
}
