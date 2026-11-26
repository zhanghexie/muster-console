import os from 'node:os';
import type { BrowserWindow } from 'electron';

export type WindowMaterial = 'mica' | 'vibrancy' | 'solid';
export type WindowAppearance = 'dark' | 'light';

export interface WindowChromeColors {
  panel: string;
  ink: string;
  appearance?: WindowAppearance;
}

interface NativeThemeController {
  themeSource: 'system' | WindowAppearance;
}

interface MaterialEnvironment {
  platform?: NodeJS.Platform;
  release?: string;
  titleBarOverlay?: boolean;
  logger?: Pick<Console, 'info' | 'warn'>;
}

type MaterialWindow = Pick<BrowserWindow, 'setBackgroundColor'> &
  Partial<Pick<BrowserWindow, 'setBackgroundMaterial' | 'setTitleBarOverlay' | 'setVibrancy'>>;

interface WindowMaterialState {
  material: WindowMaterial;
  appearance: WindowAppearance;
  titleBarOverlay: boolean;
  nativeTheme: NativeThemeController;
  logger: Pick<Console, 'info' | 'warn'>;
}

const windowStates = new WeakMap<MaterialWindow, WindowMaterialState>();
const TRANSPARENT_BACKGROUND = '#00000000';
const CHROME_HEIGHT = 36;
/** macOS 框材质：原生侧栏毛玻璃，露出面（会话栏/顶栏）语义一致；under-window 更暗更平，备选。 */
const MAC_VIBRANCY = 'sidebar';

/** Electron's Mica backdrop requires Windows 11 22H2 (build 22621) or newer. */
export function supportsMica(platform: NodeJS.Platform, release: string): boolean {
  if (platform !== 'win32') return false;
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)*$/.exec(release);
  if (!version) return false;
  const [, major, minor, build] = version.map(Number);
  return major > 10 || (major === 10 && minor === 0 && build >= 22621);
}

/** The strongest native frame material a platform can composite, before any native call. */
export function nativeMaterialFor(platform: NodeJS.Platform, release: string): WindowMaterial {
  if (supportsMica(platform, release)) return 'mica';
  if (platform === 'darwin') return 'vibrancy';
  return 'solid';
}

function hasNativeBackdrop(material: WindowMaterial): boolean {
  return material !== 'solid';
}

function fallBackToSolid(win: MaterialWindow, state: WindowMaterialState, error: unknown): void {
  state.material = 'solid';
  state.logger.warn('[window-material] native backdrop unavailable; using solid background:', error);
  // Enabling may have succeeded before a later native operation failed.
  try { win.setBackgroundMaterial?.('none'); }
  catch (resetError) { state.logger.warn('[window-material] backdrop reset failed:', resetError); }
  try { win.setVibrancy?.(null); }
  catch (resetError) { state.logger.warn('[window-material] vibrancy reset failed:', resetError); }
}

/** Install once, before renderer loading; remember what actually succeeded for this window. */
export function initializeWindowMaterial(
  win: MaterialWindow,
  nativeTheme: NativeThemeController,
  colors: WindowChromeColors,
  environment: MaterialEnvironment = {}
): WindowMaterial {
  const platform = environment.platform ?? process.platform;
  const release = environment.release ?? os.release();
  const state: WindowMaterialState = {
    material: 'solid',
    appearance: colors.appearance ?? 'dark',
    titleBarOverlay: environment.titleBarOverlay === true,
    nativeTheme,
    logger: environment.logger ?? console
  };
  windowStates.set(win, state);
  const target = nativeMaterialFor(platform, release);
  if (target === 'solid') {
    state.logger.info(`[window-material] ${platform} ${release} has no supported native backdrop; using solid background`);
  } else if (target === 'vibrancy' && typeof win.setVibrancy !== 'function') {
    state.logger.warn('[window-material] Electron has no setVibrancy; using solid background');
  } else if (target === 'mica' && typeof win.setBackgroundMaterial !== 'function') {
    state.logger.warn('[window-material] Electron has no setBackgroundMaterial; using solid background');
  } else {
    try {
      nativeTheme.themeSource = state.appearance;
      if (target === 'vibrancy') {
        win.setVibrancy?.(MAC_VIBRANCY);
        state.logger.info(`[window-material] Vibrancy (${MAC_VIBRANCY}) enabled`);
      } else {
        win.setBackgroundMaterial?.('mica');
        state.logger.info('[window-material] Mica enabled');
      }
      state.material = target;
    } catch (error) {
      fallBackToSolid(win, state, error);
    }
  }
  return applyWindowChrome(win, colors);
}

/** ThemeService and renderer frame-color updates must share this path to preserve the backdrop. */
export function applyWindowChrome(win: MaterialWindow, colors: WindowChromeColors): WindowMaterial {
  const state = windowStates.get(win);
  if (state) {
    state.appearance = colors.appearance ?? state.appearance;
    try {
      state.nativeTheme.themeSource = state.appearance;
    } catch (error) {
      if (hasNativeBackdrop(state.material)) fallBackToSolid(win, state, error);
      else state.logger.warn('[window-material] native theme sync failed:', error);
    }
    try {
      win.setBackgroundColor(hasNativeBackdrop(state.material) ? TRANSPARENT_BACKGROUND : colors.panel);
    } catch (error) {
      if (!hasNativeBackdrop(state.material)) throw error;
      fallBackToSolid(win, state, error);
      win.setBackgroundColor(colors.panel);
    }
  } else {
    // Other windows and older mocks retain their existing opaque background.
    win.setBackgroundColor(colors.panel);
  }
  // Linux exposes the method even on windows using the system title bar.
  if (state?.titleBarOverlay && typeof win.setTitleBarOverlay === 'function') {
    // Electron preserves CSS alpha for native caption buttons. With no button fill,
    // the same renderer frame tint is visible under the controls and the ChromeBar.
    const overlay = {
      color: hasNativeBackdrop(state.material) ? TRANSPARENT_BACKGROUND : colors.panel,
      symbolColor: colors.ink,
      height: CHROME_HEIGHT
    };
    try {
      win.setTitleBarOverlay(overlay);
    } catch (error) {
      if (!hasNativeBackdrop(state.material)) throw error;
      fallBackToSolid(win, state, error);
      win.setBackgroundColor(colors.panel);
      win.setTitleBarOverlay({ ...overlay, color: colors.panel });
    }
  }
  return state?.material ?? 'solid';
}
