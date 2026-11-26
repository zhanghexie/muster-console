import type { CSSProperties, HTMLAttributes, JSX, ReactNode } from 'react';
import { extensionIconId, EXTENSION_ICON_PREFIX, EXTENSION_ICONS, type ExtensionIconId } from '../../shared/extensionIcons';

const iconModules = import.meta.glob('./assets/extensions/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

const urls = Object.fromEntries(EXTENSION_ICONS.map(({ id }) => [
  id,
  iconModules[`./assets/extensions/${id}.svg`],
])) as Partial<Record<ExtensionIconId, string>>;

export function extensionIconUrl(value?: string): string | undefined {
  const id = extensionIconId(value);
  return id ? urls[id] : undefined;
}

/**
 * 内置图标经 CSS mask 渲染：SVG（单色、stroke=currentColor 源文件）作为形状蒙版，
 * 颜色取容器前景色。img 直引 SVG 拿不到页面 currentColor，mask 才能让图标跟随主题、
 * hover 变亮，并保证任意调用点的尺寸精确受控。
 */
export function ExtensionIcon({ value, size = 16, className, fallback = '·', style, ...props }: { value?: string; size?: number; className?: string; fallback?: ReactNode } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>): JSX.Element {
  const src = extensionIconUrl(value);
  if (src) {
    // Vite can inline SVG data URLs containing quotes, which require a CSS URL string.
    const mask = `url(${JSON.stringify(src)}) center / contain no-repeat`;
    return <span {...props} className={className} aria-hidden="true" style={{
      display: 'inline-block',
      width: size,
      height: size,
      flex: 'none',
      verticalAlign: '-0.15em',
      backgroundColor: 'currentColor',
      WebkitMask: mask,
      mask,
      ...style
    } as CSSProperties} />;
  }
  const text = value?.trim();
  return <span className={className} aria-hidden="true">{text && !text.startsWith(EXTENSION_ICON_PREFIX) ? text : fallback}</span>;
}
