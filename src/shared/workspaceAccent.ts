/**
 * 工作区强调色（design.md §1.5）：窗口框与主要操作按钮的点缀。
 * 工作区 accent/accentOff 独立覆盖 → 全局默认；选中方案禁用时为中性灰，
 * 否则手选色 → 该色、跟随头像 → 头像取色，无头像缓存时按 id 稳定哈希兜底。
 * 预设色板固定为一组柔和明亮的强调色；头像取色则单独归一到适合窗口框与按钮点缀的明度/饱和区间。
 */

export const WORKSPACE_ACCENTS = [
  '#4d88e6', // 蓝
  '#9276d8', // 紫
  '#d968b2', // 粉
  '#e66a73', // 红
  '#e58a52', // 橙
  '#d9b544', // 黄
  '#5fae83', // 绿
  '#9299a6' // 灰
] as const;

/** 关闭主题色时的中性色；用户/Worker 头像身份独立于工作区强调色。 */
export const NEUTRAL_ACCENT = '#8e8e96';

/** WorkspaceInfo.accent 的「跟随头像」取值（其余合法值为 #rrggbb） */
export const ACCENT_FOLLOW_AVATAR = 'avatar';

/** 全局默认；工作区有 accent/accentOff 时保留其整组覆盖。 */
export interface WorkspaceAccentDefault {
  accent: string;
  enabled: boolean;
}

export const DEFAULT_WORKSPACE_ACCENT: WorkspaceAccentDefault = { accent: ACCENT_FOLLOW_AVATAR, enabled: true };

export function normalizeWorkspaceAccentDefault(raw: unknown): WorkspaceAccentDefault {
  const v = raw && typeof raw === 'object' ? raw as Partial<WorkspaceAccentDefault> : {};
  return {
    accent: v.accent === ACCENT_FOLLOW_AVATAR ? v.accent : isAccentHex(v.accent) ? v.accent.toLowerCase() : ACCENT_FOLLOW_AVATAR,
    enabled: v.enabled !== false
  };
}

export interface WorkspaceAccentFields {
  id: string;
  accent?: string;
  avatarAccent?: string;
  accentOff?: boolean;
}

/** 写入 workspaces:update / workspaces:open 的强调色补丁；null = 清除该字段 */
export interface WorkspaceAccentPatch {
  accent?: string | null;
  avatarAccent?: string | null;
  accentOff?: boolean;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isAccentHex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/** FNV-1a 32 位：短字符串分布均匀、零依赖 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 按 id 哈希取色板色（旧工作区缺省色） */
export function hashedWorkspaceAccent(workspaceId: string | null | undefined): string {
  if (!workspaceId) return WORKSPACE_ACCENTS[0];
  return WORKSPACE_ACCENTS[hash(workspaceId) % WORKSPACE_ACCENTS.length];
}

export function hasWorkspaceAccentOverride(ws: WorkspaceAccentFields): boolean {
  return isAccentHex(ws.accent) || ws.accent === ACCENT_FOLLOW_AVATAR || ws.accentOff === true;
}

export function workspaceAccentChoice(ws: WorkspaceAccentFields, defaults = DEFAULT_WORKSPACE_ACCENT): WorkspaceAccentDefault {
  return hasWorkspaceAccentOverride(ws)
    ? { accent: ws.accent || hashedWorkspaceAccent(ws.id), enabled: !ws.accentOff }
    : defaults;
}

export function resolveWorkspaceAccent(ws: WorkspaceAccentFields | null | undefined, defaults = DEFAULT_WORKSPACE_ACCENT): string {
  if (!ws) return WORKSPACE_ACCENTS[0];
  const choice = workspaceAccentChoice(ws, defaults);
  if (!choice.enabled) return NEUTRAL_ACCENT;
  if (isAccentHex(choice.accent)) return choice.accent.toLowerCase();
  if (choice.accent === ACCENT_FOLLOW_AVATAR && isAccentHex(ws.avatarAccent)) {
    return ws.avatarAccent.toLowerCase();
  }
  return hashedWorkspaceAccent(ws.id);
}

/**
 * 渲染层查表：store 在工作区列表变化时 registerWorkspaceAccents，
 * 各处只持有 id 的调用点（顶栏/看板卡/调度栈…）经 workspaceAccent(id) 取到用户设定色。
 */
const resolved = new Map<string, string>();
let registered: readonly WorkspaceAccentFields[] = [];
let accentDefault = DEFAULT_WORKSPACE_ACCENT;

export function setWorkspaceAccentDefault(raw: unknown): void {
  const next = normalizeWorkspaceAccentDefault(raw);
  if (next.accent === accentDefault.accent && next.enabled === accentDefault.enabled) return;
  accentDefault = next;
  registerWorkspaceAccents(registered);
  version++;
  for (const fn of listeners) fn();
}

export function workspaceAccentEnabled(id: string | null | undefined): boolean {
  const ws = registered.find(w => w.id === id);
  return !!ws && workspaceAccentChoice(ws, accentDefault).enabled;
}
/** 编辑弹窗里未保存的主题色：优先于已登记值，关弹窗即清 */
const previews = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/** 渲染期调用（store useMemo）：不通知订阅者，避免渲染中触发其它组件 setState；持 workspaces 的组件本就随之重渲染 */
export function registerWorkspaceAccents(list: readonly WorkspaceAccentFields[]): void {
  resolved.clear();
  registered = Array.isArray(list) ? list : [];
  if (!Array.isArray(list)) return;
  for (const ws of list) if (ws?.id) resolved.set(ws.id, resolveWorkspaceAccent(ws, accentDefault));
}

/** 实时预览：color=null 撤销预览、回到已保存值 */
export function setWorkspaceAccentPreview(workspaceId: string, color: string | null): void {
  const prev = previews.get(workspaceId);
  if (color === null) {
    if (prev === undefined) return;
    previews.delete(workspaceId);
  } else {
    if (prev === color) return;
    previews.set(workspaceId, color);
  }
  version++;
  for (const fn of listeners) fn();
}

export function subscribeWorkspaceAccents(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** useSyncExternalStore 快照：预览变化即自增 */
export function workspaceAccentVersion(): number {
  return version;
}

export function workspaceAccent(workspaceId: string | null | undefined): string {
  if (!workspaceId) return WORKSPACE_ACCENTS[0];
  return previews.get(workspaceId) ?? resolved.get(workspaceId) ?? hashedWorkspaceAccent(workspaceId);
}

export function hasAccentPatch(p: WorkspaceAccentPatch | null | undefined): boolean {
  return !!p && (p.accent !== undefined || p.avatarAccent !== undefined || p.accentOff !== undefined);
}

/** 主进程落盘前校验：非法值忽略（不写不删），null/'' 清除 */
export function applyWorkspaceAccentPatch<T extends WorkspaceAccentFields>(ws: T, p: WorkspaceAccentPatch): T {
  const next = { ...ws };
  if (p.accent !== undefined) {
    if (p.accent === null || p.accent === '') delete next.accent;
    else if (p.accent === ACCENT_FOLLOW_AVATAR) next.accent = ACCENT_FOLLOW_AVATAR;
    else if (isAccentHex(p.accent)) next.accent = p.accent.toLowerCase();
  }
  if (p.avatarAccent !== undefined) {
    if (p.avatarAccent === null || p.avatarAccent === '') delete next.avatarAccent;
    else if (isAccentHex(p.avatarAccent)) next.avatarAccent = p.avatarAccent.toLowerCase();
  }
  if (p.accentOff !== undefined) {
    if (p.accentOff === true) next.accentOff = true;
    else delete next.accentOff;
  }
  return next;
}

/** 配置解析：只收合法字段 */
export function parseWorkspaceAccentFields(raw: Record<string, unknown>): Omit<WorkspaceAccentFields, 'id'> {
  const out: Omit<WorkspaceAccentFields, 'id'> = {};
  if (raw.accent === ACCENT_FOLLOW_AVATAR || isAccentHex(raw.accent)) out.accent = String(raw.accent).toLowerCase();
  if (isAccentHex(raw.avatarAccent)) out.avatarAccent = raw.avatarAccent.toLowerCase();
  if (raw.accentOff === true) out.accentOff = true;
  return out;
}

/* ---------- 头像取色（纯函数；渲染层把头像画到小画布后传像素进来） ---------- */

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** 头像主色 → 强调色：色相保留，饱和/明度夹到色板同一区间；近灰（无色相）返回 null */
export function normalizeAvatarAccent(r: number, g: number, b: number): string | null {
  const [h, s] = rgbToHsl(r, g, b);
  if (s < 0.18) return null;
  const sat = Math.min(0.85, Math.max(0.55, s));
  return hslToHex(h, sat, 0.64);
}

const HUE_BINS = 24;

/**
 * RGBA 像素 → 头像主色：按色相分桶，桶权重 = 饱和度 × 不透明度，跳过透明/近黑/近白/近灰像素；
 * 取权重最大桶内像素均值再归一。整张近灰（或全透明）返回 null → 调用方回退哈希色。
 */
export function pickDominantAccent(pixels: ArrayLike<number>): string | null {
  const weight = new Float64Array(HUE_BINS);
  const sums = Array.from({ length: HUE_BINS }, () => [0, 0, 0]);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3] / 255;
    if (a < 0.5) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.18 || l < 0.12 || l > 0.92) continue;
    const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS));
    const w = s * a;
    weight[bin] += w;
    sums[bin][0] += r * w;
    sums[bin][1] += g * w;
    sums[bin][2] += b * w;
  }
  let best = -1;
  for (let i = 0; i < HUE_BINS; i++) if (weight[i] > 0 && (best < 0 || weight[i] > weight[best])) best = i;
  if (best < 0) return null;
  const w = weight[best];
  return normalizeAvatarAccent(sums[best][0] / w, sums[best][1] / w, sums[best][2] / w);
}
