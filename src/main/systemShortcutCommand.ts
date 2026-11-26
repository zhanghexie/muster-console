import { parseChord } from '../shared/keybindings';
import { systemShortcutKeys } from '../shared/systemShortcuts';
import { t } from '../shared/i18n';

export interface ShortcutCommand { file: string; args: string[]; help: string }

const MAC_KEYS: Record<string, number> = {
  escape: 53, enter: 36, tab: 48, space: 49, backspace: 51, delete: 117,
  insert: 114, home: 115, end: 119, pageup: 116, pagedown: 121,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};
const X_KEYS: Record<string, string> = {
  printscreen: 'Print', escape: 'Escape', enter: 'Return', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'Prior', pagedown: 'Next', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down',
};
// Linux input-event-codes.h (physical US key positions, also used by ydotool).
const EV_KEYS: Record<string, number> = {
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  escape: 1, enter: 28, tab: 15, space: 57, backspace: 14, delete: 111,
  insert: 110, home: 102, end: 107, pageup: 104, pagedown: 109,
  arrowleft: 105, arrowright: 106, arrowup: 103, arrowdown: 108, printscreen: 99,
};

/** Only canonical, allowlisted keys enter argv / AppleScript. Never execute user shell text. */
export function unixShortcutCommand(input: string, platform: string, env: NodeJS.ProcessEnv): ShortcutCommand {
  if (!systemShortcutKeys(input)) throw new Error(t('不支持的系统快捷键'));
  const c = parseChord(input)!;
  if (platform === 'darwin') {
    const key = /^[a-z0-9]$/.test(c.key) ? `keystroke "${c.key}"`
      : MAC_KEYS[c.key] !== undefined ? `key code ${MAC_KEYS[c.key]}` : null;
    if (!key) throw new Error(t('macOS 不支持此按键，请使用 Command+Shift+3/4/5 等组合键或 F1–F20'));
    const modifiers = [c.ctrl && 'control down', c.alt && 'option down', c.shift && 'shift down', c.meta && 'command down'].filter(Boolean);
    return { file: '/usr/bin/osascript', args: ['-e', `tell application "System Events" to ${key}${modifiers.length ? ` using {${modifiers.join(', ')}}` : ''}`],
      help: t('请在 macOS 系统设置 → 隐私与安全性中允许工作台的辅助功能及自动化（System Events）权限') };
  }
  if (platform !== 'linux') throw new Error(t('当前操作系统不支持系统快捷操作'));
  if (env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || env.WAYLAND_DISPLAY) {
    const f = /^f\d+$/.test(c.key) ? Number(c.key.slice(1)) : 0;
    const key = f ? (f <= 10 ? 58 + f : f <= 12 ? 76 + f : 170 + f) : EV_KEYS[c.key];
    if (key === undefined) throw new Error(t('不支持的 Linux 按键'));
    const keys = [...(c.ctrl ? [29] : []), ...(c.alt ? [56] : []), ...(c.shift ? [42] : []), ...(c.meta ? [125] : []), key];
    return { file: 'ydotool', args: ['key', ...keys.map(k => `${k}:1`), ...[...keys].reverse().map(k => `${k}:0`)],
      help: t('Wayland 需安装 ydotool 1.x 并启动 ydotoold，允许其访问 /dev/uinput 及当前用户连接 socket；自定义键盘布局需匹配物理按键') };
  }
  if (!env.DISPLAY) throw new Error(t('未检测到 Linux 图形会话，请在 X11 或 Wayland 桌面中使用'));
  const key = X_KEYS[c.key] ?? (/^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key);
  const keys = [c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.meta && 'super', key].filter(Boolean);
  return { file: 'xdotool', args: ['key', '--clearmodifiers', keys.join('+')],
    help: t('X11 需安装 xdotool，并允许工作台访问当前 DISPLAY；Wayland 请使用 ydotool') };
}
