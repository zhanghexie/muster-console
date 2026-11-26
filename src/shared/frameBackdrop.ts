/**
 * 窗口背景（框底图）共享模型：模板清单 + 配置规整 + 按工作区解析生效背景。
 * 形态事实源：docs/prototypes/frame-backdrop-templates/frame-backdrop-templates.html；实现说明见 docs/features/frame-backdrop.md。
 */

/** 渐变系（纯 CSS）/ 几何系（内嵌 SVG + 高斯模糊）/ 纯色 / 自定义壁纸 */
export type FrameBackdropKind = 'gradient' | 'geo' | 'solid' | 'image';

export const FRAME_BACKDROPS = [
  { id: 'corner', kind: 'gradient', name: '角光' },
  { id: 'horizon', kind: 'gradient', name: '地平线' },
  { id: 'velvet', kind: 'gradient', name: '丝绒' },
  { id: 'mesh', kind: 'gradient', name: '流彩' },
  { id: 'solid', kind: 'solid', name: '纯色' },
  { id: 'mondrian', kind: 'geo', name: '蒙德里安' },
  { id: 'albers', kind: 'geo', name: '阿尔伯斯' },
  { id: 'bauhaus', kind: 'geo', name: '包豪斯' },
  { id: 'suprematism', kind: 'geo', name: '至上主义' },
  { id: 'grid', kind: 'geo', name: '网格' },
  { id: 'custom', kind: 'image', name: '自定义壁纸' }
] as const satisfies readonly { id: string; kind: FrameBackdropKind; name: string }[];

export type FrameBackdropId = (typeof FRAME_BACKDROPS)[number]['id'];
export type FrameBackdropGeoId = Extract<(typeof FRAME_BACKDROPS)[number], { kind: 'geo' }>['id'];

export const DEFAULT_FRAME_BACKDROP_ID: FrameBackdropId = 'corner';

/** 纯色浓度：工作区色与框色的 oklab 混合比 */
export const SOLID_LEVELS = { deep: 28, mid: 55, full: 100 } as const;
export type SolidLevel = keyof typeof SOLID_LEVELS;

export const WALLPAPER_BLUR_MAX = 48;
export const WALLPAPER_DIM_MAX = 80;
export const DEFAULT_WALLPAPER_BLUR = 24;
export const DEFAULT_WALLPAPER_DIM = 45;

export interface FrameBackdropChoice {
  id: FrameBackdropId;
  /** 纯色浓度（缺省 deep） */
  solidLevel?: SolidLevel;
  /** 自定义壁纸：userData/backdrops/ 下的绝对路径 */
  image?: string;
  /** 壁纸模糊 px（0–48） */
  blur?: number;
  /** 壁纸暗化 %（0–80） */
  dim?: number;
}

export const DEFAULT_FRAME_BACKDROP: FrameBackdropChoice = { id: DEFAULT_FRAME_BACKDROP_ID };

const IDS = new Set<string>(FRAME_BACKDROPS.map((b) => b.id));

export function frameBackdropKind(id: FrameBackdropId): FrameBackdropKind {
  return FRAME_BACKDROPS.find((b) => b.id === id)?.kind ?? 'gradient';
}

function clampInt(v: unknown, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(0, n));
}

/** 规整任意输入：未知 id 回默认；custom 缺图片路径回默认；只保留与 id 相关的参数 */
export function normalizeFrameBackdrop(raw: unknown): FrameBackdropChoice {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FRAME_BACKDROP };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && IDS.has(r.id) ? (r.id as FrameBackdropId) : DEFAULT_FRAME_BACKDROP_ID;
  if (id === 'solid') {
    const lv = typeof r.solidLevel === 'string' && r.solidLevel in SOLID_LEVELS ? (r.solidLevel as SolidLevel) : 'deep';
    return { id, solidLevel: lv };
  }
  if (id === 'custom') {
    const image = typeof r.image === 'string' ? r.image.trim() : '';
    if (!image) return { ...DEFAULT_FRAME_BACKDROP };
    return {
      id,
      image,
      blur: clampInt(r.blur, WALLPAPER_BLUR_MAX, DEFAULT_WALLPAPER_BLUR),
      dim: clampInt(r.dim, WALLPAPER_DIM_MAX, DEFAULT_WALLPAPER_DIM)
    };
  }
  return { id };
}

export function normalizeFrameBackdropByWorkspace(raw: unknown): Record<string, FrameBackdropChoice> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, FrameBackdropChoice> = {};
  for (const [wsId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!wsId.trim() || !v || typeof v !== 'object') continue;
    out[wsId] = normalizeFrameBackdrop(v);
  }
  return out;
}

/** 生效背景：工作区有独立设置用独立的，否则跟随全局 */
export function resolveFrameBackdrop(
  global: FrameBackdropChoice | undefined,
  byWorkspace: Record<string, FrameBackdropChoice> | undefined,
  workspaceId: string | null | undefined
): FrameBackdropChoice {
  const own = workspaceId ? byWorkspace?.[workspaceId] : undefined;
  return normalizeFrameBackdrop(own ?? global);
}

/** 全局与各工作区当前引用的壁纸文件（清理 userData/backdrops/ 时保留） */
export function referencedWallpapers(
  global: FrameBackdropChoice | undefined,
  byWorkspace: Record<string, FrameBackdropChoice> | undefined
): string[] {
  const all = [global, ...Object.values(byWorkspace ?? {})];
  return [...new Set(all.flatMap((c) => (c?.id === 'custom' && c.image ? [c.image] : [])))];
}

/** 相对亮度（sRGB，0–1）：纯色原色档据此给顶栏文字/窗口按钮符号切深色 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 浅底阈值：高于此亮度时浅色文字对比度不足 4.5:1，改用深色 */
export const LIGHT_SURFACE_LUMINANCE = 0.18;
