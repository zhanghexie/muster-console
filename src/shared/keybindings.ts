/**
 * 快捷键：和弦解析、动作目录、覆盖合并、冲突与双向搜索。
 * 纯函数，渲染层 / 主进程 / 单测共用；禁止碰 process。
 */

export type KeybindingWhen = 'always' | 'notTyping' | 'filesPanel' | 'sideTools' | 'chatFind';

export interface KeyChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** 规范化后的键名：字母数字小写；Escape→escape；空格→space；+→plus；\\→backslash */
  key: string;
}

export type KeyEventLike = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

export interface KeybindingAction {
  id: string;
  title: string;
  group: string;
  when: KeybindingWhen;
  /** 序列化和弦；null = 默认不绑定 */
  defaultChord: string | null;
}

export type KeybindingOverrides = Record<string, string | null>;

export type KeybindingSearchRow = {
  id: string;
  title: string;
  group: string;
  chord: string | null;
};

const MODIFIER_KEYS = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'altgraph',
  'os',
  'hyper',
  'super'
]);

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  ' ': 'space',
  spacebar: 'space',
  '+': 'plus',
  '\\': 'backslash',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown'
};

const DISPLAY_KEYS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  plus: '+',
  backslash: '\\',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓'
};

/** US 布局下按住 Shift 产生的字形 → 基准键；事件匹配/录制归一化用（非 US 布局仍可改绑绕开）。 */
const SHIFT_GLYPHS: Record<string, string> = {
  '|': '\\', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': '-', '+': '=', '~': '`', '{': '[', '}': ']', ':': ';', '"': "'",
  '<': ',', '>': '.', '?': '/'
};

export const KEYBINDING_ACTIONS: readonly KeybindingAction[] = [
  {
    id: 'overlay.close',
    title: '关闭当前弹出层',
    group: '弹层',
    when: 'always',
    defaultChord: 'escape'
  },
  {
    id: 'settings.open',
    title: '打开设置',
    group: '应用',
    when: 'always',
    defaultChord: 'ctrl+,'
  },
  {
    id: 'terminal.releaseFocus',
    title: '退出终端焦点',
    group: '应用',
    when: 'always',
    defaultChord: 'ctrl+shift+f8'
  },
  {
    id: 'palette.commands',
    title: '打开命令面板',
    group: '应用',
    when: 'always',
    defaultChord: 'ctrl+shift+p'
  },
  {
    id: 'palette.goto',
    title: '跳转会话或工作区',
    group: '应用',
    when: 'notTyping',
    defaultChord: 'ctrl+p'
  },
  {
    id: 'utility.tasks',
    title: '实用功能：定时任务',
    group: '实用功能',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+t'
  },
  {
    id: 'utility.memory',
    title: '实用功能：记忆整理',
    group: '实用功能',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+m'
  },
  {
    id: 'utility.extManager',
    title: '实用功能：扩展管理',
    group: '实用功能',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+x'
  },
  {
    id: 'utility.usage',
    title: '实用功能：使用统计',
    group: '实用功能',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+u'
  },
  {
    id: 'globalBoard.toggle',
    title: '开关全局看板',
    group: '应用',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+g'
  },
  {
    id: 'processMonitor.toggle',
    title: '开关运行监视器',
    group: '应用',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+r'
  },
  {
    id: 'center.split',
    title: '分屏显示当前面板',
    group: '应用',
    when: 'notTyping',
    defaultChord: 'ctrl+backslash'
  },
  {
    id: 'session.newTask',
    title: '新建任务',
    group: '应用',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+n'
  },
  {
    id: 'files.quickOpen',
    title: '快速打开文件',
    group: '文件',
    when: 'notTyping',
    defaultChord: null
  },
  {
    id: 'files.find',
    title: '当前文件查找',
    group: '文件',
    when: 'filesPanel',
    defaultChord: 'ctrl+f'
  },
  {
    id: 'chat.find',
    title: '会话内查找',
    group: '会话',
    when: 'chatFind',
    defaultChord: 'ctrl+f'
  },
  {
    id: 'files.findInFiles',
    title: '所有文件中搜索',
    group: '文件',
    when: 'always',
    defaultChord: 'ctrl+shift+f'
  },
  {
    id: 'sideTools.files',
    title: '侧栏切到文件',
    group: '侧栏',
    when: 'sideTools',
    defaultChord: 'f'
  },
  {
    id: 'sideTools.git',
    title: '侧栏切到 Git',
    group: '侧栏',
    when: 'sideTools',
    defaultChord: 'g'
  },
  {
    id: 'sideTools.browser',
    title: '侧栏切到浏览器',
    group: '侧栏',
    when: 'sideTools',
    defaultChord: 'b'
  },
  {
    id: 'sideTools.back',
    title: '右侧面板撤销',
    group: '侧栏',
    when: 'sideTools',
    defaultChord: 'ctrl+alt+arrowleft'
  },
  {
    id: 'sideTools.forward',
    title: '右侧面板重做',
    group: '侧栏',
    when: 'sideTools',
    defaultChord: 'ctrl+alt+arrowright'
  },
  {
    id: 'virtualScreen.toggle',
    title: '虚拟屏切 Git / 终端',
    group: '导航',
    when: 'notTyping',
    defaultChord: 'ctrl+shift+backslash'
  },
  {
    id: 'panel.back',
    title: '面板后退',
    group: '导航',
    when: 'notTyping',
    defaultChord: 'alt+arrowleft'
  },
  {
    id: 'panel.forward',
    title: '面板前进',
    group: '导航',
    when: 'notTyping',
    defaultChord: 'alt+arrowright'
  }
];

const ACTION_IDS = new Set(KEYBINDING_ACTIONS.map((a) => a.id));
const ACTION_BY_ID = new Map(KEYBINDING_ACTIONS.map((a) => [a.id, a]));

export function getKeybindingAction(id: string): KeybindingAction | undefined {
  return ACTION_BY_ID.get(id);
}

const NAMED_KEYS = new Set([
  'escape',
  'enter',
  'tab',
  'space',
  'plus',
  'backslash',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'capslock',
  'contextmenu',
  'pause',
  'printscreen',
  'scrolllock',
  'numlock'
]);

function isAllowedKey(key: string): boolean {
  if (key.length === 1) return true;
  if (NAMED_KEYS.has(key)) return true;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  return false;
}

function canonKey(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (MODIFIER_KEYS.has(t)) return null;
  const key = KEY_ALIASES[t] ?? t;
  return isAllowedKey(key) ? key : null;
}

export function serializeChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('ctrl');
  if (chord.alt) parts.push('alt');
  if (chord.shift) parts.push('shift');
  if (chord.meta) parts.push('meta');
  parts.push(chord.key);
  return parts.join('+');
}

export function parseChord(input: string): KeyChord | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, '');
  const tokens = compact.split('+').filter((t) => t.length > 0);
  if (!tokens.length) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  const keyTokens: string[] = [];
  for (const t of tokens) {
    if (t === 'ctrl' || t === 'control' || t === 'cmdorctrl') ctrl = true;
    else if (t === 'alt' || t === 'option') alt = true;
    else if (t === 'shift') shift = true;
    else if (t === 'meta' || t === 'cmd' || t === 'command' || t === 'win' || t === 'super')
      meta = true;
    else keyTokens.push(t);
  }
  if (keyTokens.length !== 1) return null;
  const key = canonKey(keyTokens[0]);
  if (!key) return null;
  return { ctrl, alt, shift, meta, key };
}

/** 搜索框里「ctrl shift b」也能当成和弦 */
export function parseChordLoose(input: string): KeyChord | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  if (t.includes('+')) return parseChord(t);
  return parseChord(t.replace(/\s+/g, '+'));
}

export function eventToChord(ev: KeyEventLike): KeyChord | null {
  // Shift 修饰会把键位报告成字形（Ctrl+Shift+\ 报 '|'）：归一回基准键，默认和弦才能命中。
  const rawKey = ev.shiftKey && SHIFT_GLYPHS[ev.key] ? SHIFT_GLYPHS[ev.key] : ev.key;
  const key = canonKey(rawKey);
  if (!key) return null;
  return {
    ctrl: !!ev.ctrlKey,
    alt: !!ev.altKey,
    shift: !!ev.shiftKey,
    meta: !!ev.metaKey,
    key
  };
}

function displayKey(key: string): string {
  if (DISPLAY_KEYS[key]) return DISPLAY_KEYS[key];
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * meta 修饰键显示名：按平台映射（macOS=Cmd / Linux=Super / 其余=Win），
 * 与 systemShortcuts.formatSystemShortcut 同一口径；platform 缺省按 Win
 * （本模块禁碰 process，平台上下文由调用方传入）。
 */
function metaKeyLabel(platform?: string): string {
  if (/mac|darwin/i.test(platform ?? '')) return 'Cmd';
  if (/linux/i.test(platform ?? '')) return 'Super';
  return 'Win';
}

/** 和弦显示文本；platform（如 navigator.platform）用于 meta 键平台化显示 */
export function formatChord(chord: KeyChord, platform?: string): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push(metaKeyLabel(platform));
  parts.push(displayKey(chord.key));
  return parts.join('+');
}

export function formatChordSerialized(
  serialized: string | null | undefined,
  platform?: string
): string {
  if (!serialized) return '';
  const chord = parseChord(serialized);
  return chord ? formatChord(chord, platform) : '';
}

export function normalizeKeybindingOverrides(raw: unknown): KeybindingOverrides | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: KeybindingOverrides = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ACTION_IDS.has(id)) continue;
    if (v === null) {
      out[id] = null;
      continue;
    }
    if (typeof v !== 'string') continue;
    const chord = parseChord(v);
    if (!chord) continue;
    out[id] = serializeChord(chord);
  }
  return Object.keys(out).length ? out : undefined;
}

/** 缺省用默认；overrides[id] === null 表示用户显式解绑 */
export function resolveBinding(
  id: string,
  overrides?: KeybindingOverrides | null
): string | null {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id] ?? null;
  }
  return ACTION_BY_ID.get(id)?.defaultChord ?? null;
}

export function resolveAllBindings(
  overrides?: KeybindingOverrides | null
): KeybindingSearchRow[] {
  return KEYBINDING_ACTIONS.map((a) => ({
    id: a.id,
    title: a.title,
    group: a.group,
    chord: resolveBinding(a.id, overrides)
  }));
}

/** 同一和弦绑了多个动作 → chord → action ids */
export function findConflicts(overrides?: KeybindingOverrides | null): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const a of KEYBINDING_ACTIONS) {
    const chord = resolveBinding(a.id, overrides);
    if (!chord) continue;
    const list = byChord.get(chord);
    if (list) list.push(a.id);
    else byChord.set(chord, [a.id]);
  }
  for (const [k, ids] of [...byChord.entries()]) {
    if (ids.length < 2) {
      byChord.delete(k);
      continue;
    }
    // 不同 when 且都不是 always：按场景分流（如 Ctrl+F = 文件查找 / 会话查找），不算冲突
    const whens = ids.map((id) => ACTION_BY_ID.get(id)?.when);
    const unique = new Set(whens);
    if (unique.size === ids.length && !unique.has('always')) {
      byChord.delete(k);
    }
  }
  return byChord;
}

function compact(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * 双线搜索：动作名/分组 或 和弦（Ctrl+Shift+T / ctrl shift t / 按下捕获的序列化串）。
 */
export function matchKeybindingSearch(
  query: string,
  rows: KeybindingSearchRow[]
): KeybindingSearchRow[] {
  const q = query.trim();
  if (!q) return rows;
  const needle = compact(q);
  const asChord = parseChordLoose(q);
  const asSerialized = asChord ? serializeChord(asChord) : null;

  return rows.filter((row) => {
    if (compact(row.title).includes(needle)) return true;
    if (compact(row.group).includes(needle)) return true;
    if (compact(row.id).includes(needle)) return true;
    if (!row.chord) return false;
    if (asSerialized && row.chord === asSerialized) return true;
    if (compact(row.chord).includes(needle)) return true;
    const labeled = formatChordSerialized(row.chord);
    if (labeled && compact(labeled).includes(needle)) return true;
    return false;
  });
}

export function findActionsByChord(
  serialized: string,
  overrides?: KeybindingOverrides | null
): string[] {
  const want = parseChord(serialized);
  if (!want) return [];
  const canon = serializeChord(want);
  return KEYBINDING_ACTIONS.filter((a) => resolveBinding(a.id, overrides) === canon).map(
    (a) => a.id
  );
}
