import { builtinTheme, parseCssColor, type WorkbenchTheme, type ThemeAppearance } from './theme';

type RGB = [number, number, number];
export type AppearanceSurface = 'frame' | 'canvas' | 'chrome' | 'raised' | 'input' | 'overlay' | 'board-column' | 'board-card';
export type AppearanceWorkspace = { workspaceId?: string | null; accent: string; enabled: boolean };
export type ForegroundPair = { primary: string; secondary: string; muted: string };
export type InteractionColors = { hover: string; pressed: string; selected: string; selectedHover: string };
export type AppearanceStatus = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type StatusColors = { bg: string; fg: string; border: string };
export type ContrastCheck = { role: string; foreground: string; background: string; ratio: number; minimum: number; ok: boolean };
export interface ResolvedAppearance {
  revision: number;
  appearance: ThemeAppearance;
  workspaceId: string | null;
  surfaces: Record<AppearanceSurface, string>;
  foreground: ForegroundPair;
  selectedForeground: ForegroundPair;
  interactions: InteractionColors;
  frameInteractions: InteractionColors;
  status: Record<AppearanceStatus, StatusColors>;
  cssVars: Record<string, string>;
  terminal: Record<string, string>;
  cm: { dark: boolean; background: string; foreground: string; cursor: string; selection: string; gutter: string };
  nativeChrome: { panel: string; ink: string; appearance: ThemeAppearance };
  material: { enabled: boolean; nativeTint: string; nativeTintAlpha: number };
  contrastReport: ContrastCheck[];
}

const hex = (rgb: RGB): string => '#' + rgb.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('');
const linear = (channel: number): number => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
const encoded = (channel: number): number => 255 * (channel <= .0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - .055);
function channels(value: string): RGB {
  const parsed = parseCssColor(value);
  return parsed ? [parsed.r, parsed.g, parsed.b] : [0, 0, 0];
}
/** CSS sRGB mixing for opaque surfaces. The result is concrete and cannot accumulate tint. */
export function mixAppearanceColors(base: string, overlay: string, weight: number): string {
  const a = channels(base), b = channels(overlay), amount = Math.max(0, Math.min(1, weight));
  return hex(a.map((value, index) => value * (1 - amount) + b[index] * amount) as RGB);
}
function oklab(value: string): RGB {
  const [r, g, b] = channels(value).map(linear);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
/** Preserve the production frame's 28% oklab mix, independently from the native alpha layer. */
export function mixFrameColors(base: string, accent: string, weight = .28): string {
  const a = oklab(base), b = oklab(accent);
  const [L, A, B] = a.map((value, index) => value * (1 - weight) + b[index] * weight);
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3;
  const m = (L - .1055613458 * A - .0638541728 * B) ** 3;
  const s = (L - .0894841775 * A - 1.291485548 * B) ** 3;
  return hex([encoded(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s), encoded(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s), encoded(-.0041960863 * l - .7034186147 * m + 1.707614701 * s)]);
}
export function appearanceContrast(a: string, b: string): number {
  const luminance = (value: string): number => channels(value).map(linear).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function opaque(value: string, backdrop: string): string {
  const color = parseCssColor(value);
  return color ? mixAppearanceColors(backdrop, hex([color.r, color.g, color.b]), color.a) : backdrop;
}
function readable(seed: string, background: string, minimum = 4.5): string {
  if (appearanceContrast(seed, background) >= minimum) return seed;
  const target = appearanceContrast('#ffffff', background) >= appearanceContrast('#000000', background) ? '#ffffff' : '#000000';
  for (let step = 1; step <= 100; step++) {
    const candidate = mixAppearanceColors(seed, target, step / 100);
    if (appearanceContrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

function readableAcross(seed: string, backgrounds: string[], minimum = 4.5): string {
  const score = (value: string): number => Math.min(...backgrounds.map(background => appearanceContrast(value, background)));
  if (score(seed) >= minimum) return seed;
  const target = score('#ffffff') >= score('#000000') ? '#ffffff' : '#000000';
  for (let step = 1; step <= 100; step++) {
    const candidate = mixAppearanceColors(seed, target, step / 100);
    if (score(candidate) >= minimum) return candidate;
  }
  return target;
}

/** Keep custom interaction fills on a side of the contrast threshold shared with rest. */
function sharedReadableStates(background: string, states: string[], minimum = 4.5): string[] {
  const endpoints = ['#ffffff', '#000000'];
  if (endpoints.some(fg => [background, ...states].every(bg => appearanceContrast(fg, bg) >= minimum))) return states;
  const candidates = endpoints.filter(fg => appearanceContrast(fg, background) >= minimum).map(fg => {
    let distance = 0;
    const adjusted = states.map(state => {
      if (appearanceContrast(fg, state) >= minimum) return state;
      for (let step = 1; step <= 100; step++) {
        const candidate = mixAppearanceColors(state, background, step / 100);
        if (appearanceContrast(fg, candidate) >= minimum) { distance += step; return candidate; }
      }
      distance += 100;
      return background;
    });
    return { adjusted, distance };
  });
  // Every opaque RGB background has at least one black/white endpoint above 4.5:1.
  // Select the least total retraction; the reading surface and editable seeds stay intact.
  return candidates.sort((a, b) => a.distance - b.distance)[0].adjusted;
}

/** Outset zero-blur rings duplicate the control border; retain only cast shadows. */
function castShadow(value: string): string {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')') depth--;
    if (index === value.length || (value[index] === ',' && depth === 0)) {
      const part = value.slice(start, index).trim();
      if (part && !/^0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+1px\s/.test(part)) parts.push(part);
      start = index + 1;
    }
  }
  return parts.join(', ') || 'none';
}

/** Pure, sole derivation point for every host surface and renderer theme. */
export function resolveAppearance(theme: WorkbenchTheme, workspace: AppearanceWorkspace = { accent: '#8b7bff', enabled: false }, revision = 0): ResolvedAppearance {
  const fallback = builtinTheme(theme.appearance)!;
  const dark = theme.appearance === 'dark';
  const neutralBackdrop = fallback.colors['bg-panel'];
  const color = (key: keyof WorkbenchTheme['colors']): string => opaque(theme.colors[key], fallback.colors[key] || neutralBackdrop);
  const accent = opaque(workspace.accent, '#8b7bff');
  const ink = color('ink');
  const frame = workspace.enabled ? mixFrameColors(color('bg-frame'), accent) : color('bg-frame');
  const tint = (base: string, amount: number): string => workspace.enabled ? mixAppearanceColors(base, frame, amount) : base;
  const canvas = tint(color('bg-panel'), .12);
  const input = tint(color(dark ? 'bg-raised' : 'bg-input'), .12);
  // A board is one work surface. Columns organise it without introducing dark
  // wells; repeated content cards have a quieter lift than editable inputs.
  // The panel shares the session canvas; only cards get a separate gentle lift.
  // Start from the resolved canvas so custom themes and workspace tint survive.
  const cardBase = mixAppearanceColors(canvas, ink, dark ? .025 : .04);
  const surfaces = {
    frame, canvas, chrome: mixAppearanceColors(canvas, ink, .04),
    raised: tint(color('bg-raised'), .08),
    input,
    overlay: tint(color('bg-overlay'), .08),
    'board-column': canvas,
    'board-card': dark ? mixAppearanceColors(cardBase, ink, .04) : mixAppearanceColors(cardBase, canvas, .85)
  };
  const pair = (background: string, otherBackgrounds: string[] = []): ForegroundPair => ({
    primary: readableAcross(ink, [background, ...otherBackgrounds]),
    secondary: readableAcross(color('text-2'), [background, ...otherBackgrounds]),
    muted: readableAcross(color('text-3'), [background, ...otherBackgrounds])
  });
  const interaction = (background: string, quiet = false): InteractionColors => {
    const selected = mixAppearanceColors(background, ink, .15);
    const [hover, pressed] = sharedReadableStates(background, quiet
      ? [mixAppearanceColors(background, ink, .035), mixAppearanceColors(background, ink, .065)]
      : [opaque(theme.colors['hover-fill'], background), opaque(theme.colors['hover-fill-strong'], background)]);
    const [selectedHover] = sharedReadableStates(selected, [mixAppearanceColors(selected, ink, .035)]);
    return { hover, pressed,
      selected, selectedHover };
  };
  const interactions = interaction(canvas), frameInteractions = interaction(frame);
  const foreground = pair(canvas, [interactions.hover, interactions.pressed]), selectedForeground = pair(interactions.selected, [interactions.selectedHover]);
  const statusSeeds = { neutral: color('ink-soft'), success: color('green'), warning: color('yellow'), danger: color('red'), info: color('blue') };
  const statusFor = (background: string): Record<AppearanceStatus, StatusColors> => Object.fromEntries(Object.entries(statusSeeds).map(([name, seed]) => {
    const bg = mixAppearanceColors(background, name === 'neutral' ? ink : seed, name === 'neutral' ? .06 : .12);
    return [name, { bg, fg: readable(seed, bg), border: mixAppearanceColors(background, seed, name === 'neutral' ? .14 : .24) }];
  })) as Record<AppearanceStatus, StatusColors>;
  const status = statusFor(canvas);
  const actionFg = readable('#0f0f10', accent);
  // The generated CSS defaults and extension handshake include the editable seed vocabulary.
  // Resolved roles below override only values that need a final host representation.
  const cssVars: Record<string, string> = Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [`--${key}`, value]));
  const put = (name: string, value: string): void => { cssVars[`--${name}`] = value; };
  for (const [name, value] of Object.entries(surfaces)) put(`surface-${name}`, value);
  for (const [name, value] of Object.entries(foreground)) put(`fg-${name}`, value);
  for (const [name, value] of Object.entries(selectedForeground)) put(`fg-selected-${name}`, value);
  put('fg-disabled', mixAppearanceColors(canvas, foreground.muted, .78));
  for (const [name, background] of Object.entries(surfaces)) {
    const contextInteraction = interaction(background, name.startsWith('board-')), contextStatus = statusFor(background);
    const contextPair = pair(background, [contextInteraction.hover, contextInteraction.pressed]);
    for (const [key, value] of Object.entries(contextPair)) put(`${name}-fg-${key}`, value);
    for (const [key, value] of Object.entries(pair(contextInteraction.selected, [contextInteraction.selectedHover]))) put(`${name}-fg-selected-${key}`, value);
    for (const [key, value] of Object.entries(contextInteraction)) put(`${name}-interaction-${key === 'selectedHover' ? 'selected-hover' : key}`, value);
    for (const [state, values] of Object.entries(contextStatus)) for (const [key, value] of Object.entries(values)) put(`${name}-status-${state}-${key}`, value);
    put(`${name}-border-focus`, readableAcross(mixAppearanceColors(color('hairline'), ink, .22), [background, contextInteraction.hover, contextInteraction.pressed], 3));
  }
  for (const [key, value] of Object.entries(interactions)) put(`interaction-${key === 'selectedHover' ? 'selected-hover' : key}`, value);
  const selectedTab = mixAppearanceColors(canvas, ink, .11);
  put('selected-tab', selectedTab);
  for (const [key, value] of Object.entries(pair(selectedTab))) put(`fg-selected-tab-${key}`, value);
  put('border-subtle', opaque(theme.colors.hairline, canvas));
  put('border-control', mixAppearanceColors(color('hairline'), ink, .06));
  put('board-card-border', mixAppearanceColors(surfaces['board-card'], ink, .065));
  put('input-focus-border', `color-mix(in srgb, ${cssVars['--border-control']} 70%, ${cssVars['--input-border-focus']})`);
  put('border-focus', cssVars['--canvas-border-focus']);
  put('identity-surface', color('bg-raised'));
  put('identity-fg', readable(color('text-2'), color('bg-raised')));
  put('identity-border', color('hairline'));
  put('identity-hover', mixAppearanceColors(color('bg-raised'), ink, .14));
  put('identity-hover-fg', readable(color('text-2'), cssVars['--identity-hover']));
  put('surface-handle-glow', `rgba(${channels(canvas).join(', ')}, 0.85)`);
  put('surface-drag-preview', `rgba(${channels(canvas).join(', ')}, 0.37)`);
  // Decorations over terminal content retain alpha; their seed is resolved once here.
  put('scan-hover-bg', `rgba(${channels(status.warning.fg).join(', ')}, 0.12)`);
  put('scan-selected-bg', `rgba(${channels(status.info.fg).join(', ')}, 0.16)`);
  put('divider-rest', mixAppearanceColors(canvas, ink, .12));
  put('divider-active', mixAppearanceColors(canvas, ink, .28));
  put('divider-focus', cssVars['--border-focus']);
  for (const [state, values] of Object.entries(status)) for (const [key, value] of Object.entries(values)) put(`status-${state}-${key}`, value);
  put('action-bg', accent); put('action-fg', actionFg);
  const userBubble = workspace.enabled ? accent : surfaces.raised;
  put('user-bubble-bg', userBubble);
  put('user-bubble-fg', foreground.primary);
  put('user-bubble-link', readable(color('syn-blue'), userBubble));
  put('action-hover', mixAppearanceColors(accent, ink, .14));
  put('action-pressed', mixAppearanceColors(accent, ink, .22));
  put('action-hover-fg', readable(actionFg, cssVars['--action-hover']));
  put('action-pressed-fg', readable(actionFg, cssVars['--action-pressed']));
  put('primary-bg', ink); put('primary-fg', readable(canvas, ink));
  put('primary-hover', color('ink-soft')); put('primary-hover-fg', readable(canvas, color('ink-soft')));
  put('primary-pressed', mixAppearanceColors(ink, canvas, .2));
  put('primary-pressed-fg', readable(canvas, cssVars['--primary-pressed']));
  for (const role of ['page', 'card', 'pop'] as const) put(`shadow-${role}`, castShadow(theme.colors[`shadow-${role}`]));
  // 页面共用同一紧凑投影，已保存主题也统一生效。
  put('shadow-page', '0 1px 4px rgba(0, 0, 0, 0.4)');
  // 浅色白底输入靠主题轻投影建立层次；深色继续由实底明暗差成形。
  put('shadow-input', dark ? 'none' : castShadow(theme.colors['shadow-input']));
  put('shadow-tooltip', dark ? '0 4px 12px rgba(0, 0, 0, 0.28)' : '0 4px 12px rgba(0, 0, 0, 0.12)');
  put('workspace-frame-color', frame); put('ws-accent', accent); put('on-accent', actionFg);
  const nativeTint = workspace.enabled ? `rgba(${channels(accent).join(', ')}, 0.28)` : 'transparent';
  put('workspace-native-tint', nativeTint);
  // Decorative edges follow the enabled workspace hue; semantic/focus borders
  // remain independent. A frame edge must be paired with frame, not canvas.
  const edgeInk = workspace.enabled ? mixAppearanceColors(ink, accent, .65) : ink;
  put('material-rim', `rgba(${channels(edgeInk).join(', ')}, 0.10)`);
  put('frame-edge', mixAppearanceColors(frame, edgeInk, .12));
  put('syntax-fg', readable(color('syn-fg'), canvas));
  for (const key of ['muted', 'blue', 'cyan', 'red', 'purple', 'orange', 'yellow'] as const) put(`syntax-${key}`, readable(color(`syn-${key}`), canvas));
  for (const key of ['fg', 'muted', 'blue', 'cyan', 'red', 'purple', 'orange', 'yellow'] as const) put(`syn-${key}`, cssVars[`--syntax-${key}`]);
  for (const [role, seed] of [['add', color('green')], ['remove', color('red')]] as const) {
    const bg = mixAppearanceColors(canvas, seed, .12);
    put(`diff-${role}-bg`, bg); put(`diff-${role}-fg`, readable(seed, bg)); put(`diff-${role}-edit-bg`, mixAppearanceColors(canvas, seed, .18));
  }
  const terminal = { ...theme.terminal,
    background: canvas, foreground: foreground.primary, cursor: readable(opaque(theme.terminal.cursor, canvas), canvas), cursorAccent: canvas,
    selectionBackground: interactions.selected, selectionInactiveBackground: interactions.hover };
  // Preserve ANSI identities and explicit TUI cell backgrounds; xterm enforces contrast at draw time.
  const cm = { dark, background: canvas, foreground: foreground.primary, cursor: foreground.primary, selection: interactions.selected, gutter: foreground.muted };
  const contrastReport: ContrastCheck[] = [];
  const check = (role: string, fg: string, bg: string, minimum = 4.5): void => {
    const ratio = appearanceContrast(fg, bg); contrastReport.push({ role, foreground: fg, background: bg, ratio, minimum, ok: ratio >= minimum });
  };
  for (const [surface, background] of Object.entries(surfaces)) {
    const normalBackgrounds = { rest: background, hover: cssVars[`--${surface}-interaction-hover`], pressed: cssVars[`--${surface}-interaction-pressed`] };
    for (const [state, bg] of Object.entries(normalBackgrounds)) {
      for (const level of ['primary', 'secondary', 'muted']) check(`${surface}.${state}.${level}`, cssVars[`--${surface}-fg-${level}`], bg);
      check(`${surface}.${state}.focus`, cssVars[`--${surface}-border-focus`], bg, 3);
    }
    for (const state of ['selected', 'selected-hover']) for (const level of ['primary', 'secondary', 'muted']) check(`${surface}.${state}.${level}`, cssVars[`--${surface}-fg-selected-${level}`], cssVars[`--${surface}-interaction-${state}`]);
    for (const state of Object.keys(status)) check(`${surface}.status.${state}`, cssVars[`--${surface}-status-${state}-fg`], cssVars[`--${surface}-status-${state}-bg`]);
  }
  for (const [level, fg] of Object.entries(pair(selectedTab))) check(`selected-tab.${level}`, fg, selectedTab);
  // Bubble text keeps the shared body ink instead of choosing opposite black/white ink.
  check('user-bubble.link', cssVars['--user-bubble-link'], cssVars['--user-bubble-bg']);
  for (const role of ['action', 'primary']) {
    check(role, cssVars[`--${role}-fg`], cssVars[`--${role}-bg`]);
    for (const state of ['hover', 'pressed']) check(`${role}.${state}`, cssVars[`--${role}-${state}-fg`], cssVars[`--${role}-${state}`]);
  }
  return { revision, appearance: theme.appearance, workspaceId: workspace.workspaceId || null, surfaces, foreground, selectedForeground, interactions, frameInteractions, status,
    cssVars, terminal, cm, nativeChrome: { panel: frame, ink: cssVars['--frame-fg-primary'], appearance: theme.appearance },
    material: { enabled: workspace.enabled, nativeTint, nativeTintAlpha: workspace.enabled ? .28 : 0 }, contrastReport };
}

export const DEFAULT_RESOLVED_DARK = resolveAppearance(builtinTheme('dark')!);
