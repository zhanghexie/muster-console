import { getResolvedAppearance } from '../theme';
import { getUiFontStylesheets } from '../uiFont';
import { getResolvedLocale } from '../../../shared/i18n';

/** Map artifact aliases to the host's resolved roles; no independent palette calculation. */
export function uiWidgetAppearance(element?: Element | null): {
  theme: 'dark' | 'light'; cssVars: Record<string, string>; fontStylesheets: string[]; locale: 'zh-CN' | 'en';
} {
  const appearance = getResolvedAppearance();
  const style = getComputedStyle(element ?? document.documentElement);
  const cssVars = { ...appearance.cssVars };
  const read = (key: string): string => style.getPropertyValue(key).trim() || appearance.cssVars[key] || '';
  const inline = element?.matches('.ma-ui-card.is-inline') ?? false;
  const aliases: Record<string, string> = {
    // Generated documents paint body.ma-artifact with --bg-card, including existing inline artifacts.
    // Both document background aliases must match the chat canvas; the outer host card stays raised.
    '--bg-canvas': '--surface-canvas', '--bg-card': '--surface-canvas', '--bg-input': '--surface-input',
    '--ink': inline ? '--canvas-fg-primary' : '--fg-primary',
    '--ink-soft': inline ? '--canvas-fg-secondary' : '--fg-secondary',
    '--text-2': inline ? '--canvas-fg-secondary' : '--fg-secondary', '--text-3': inline ? '--canvas-fg-muted' : '--fg-muted',
    '--hairline': '--border-subtle', '--border-control': '--border-control',
    '--hover-fill': inline ? '--canvas-interaction-hover' : '--interaction-hover', '--hover-fill-strong': inline ? '--canvas-interaction-pressed' : '--interaction-pressed',
    '--action-bg': '--primary-bg', '--action-fg': '--primary-fg', '--action-hover': '--primary-hover',
    '--fs-caption': '--font-caption', '--fs-ui': '--font-ui', '--fs-control': '--font-control',
    '--fs-body': '--font-body', '--fs-title': '--font-title', '--fs-head': '--font-head'
  };
  for (const [target, source] of Object.entries(aliases)) { const value = read(source); if (value) cssVars[target] = value; }
  for (const name of ['--font-sans', '--font-mono', '--radius-small', '--radius-control', '--radius-card', '--radius-pill', '--dur-micro', '--dur-panel', '--dur-exit', '--ease-standard', '--ease-exit']) {
    const value = read(name); if (value) cssVars[name] = value;
  }
  return { theme: appearance.appearance, cssVars, fontStylesheets: getUiFontStylesheets(), locale: getResolvedLocale() };
}
