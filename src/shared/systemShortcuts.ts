import { formatChordSerialized, parseChord, serializeChord } from './keybindings';

export interface SystemShortcut { id: string; name: string; chord: string }

export function formatSystemShortcut(chord: string, platform: string): string {
  return formatChordSerialized(chord).split('+').map(part => part === 'Win'
    ? /mac|darwin/i.test(platform) ? 'Cmd' : /linux/i.test(platform) ? 'Super' : part
    : part === 'Alt' && /mac|darwin/i.test(platform) ? 'Option' : part).join('+');
}

const KEYS: Record<string, number> = {
  printscreen: 0x2c, escape: 0x1b, enter: 0x0d, tab: 9, space: 0x20,
  backspace: 8, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, arrowleft: 0x25, arrowup: 0x26,
  arrowright: 0x27, arrowdown: 0x28,
};

/** Explicit virtual-key allowlist; no user text is executable. */
export function systemShortcutKeys(input: string): number[] | null {
  if (typeof input !== 'string' || input.length > 100) return null;
  const chord = parseChord(input);
  if (!chord) return null;
  const key = /^[a-z0-9]$/.test(chord.key) ? chord.key.toUpperCase().charCodeAt(0)
    : /^f([1-9]|1[0-9]|2[0-4])$/.test(chord.key) ? 0x6f + Number(chord.key.slice(1))
      : KEYS[chord.key];
  if (!key) return null;
  if (!chord.ctrl && !chord.alt && !chord.meta && !chord.shift && key !== 0x2c && !/^f\d+$/.test(chord.key)) return null;
  return [...(chord.ctrl ? [0x11] : []), ...(chord.alt ? [0x12] : []),
    ...(chord.shift ? [0x10] : []), ...(chord.meta ? [0x5b] : []), key];
}

export function normalizeSystemShortcuts(value: unknown): SystemShortcut[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 20).flatMap(row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 80 || ids.has(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 40
      || typeof row.chord !== 'string' || !systemShortcutKeys(row.chord)) return [];
    ids.add(row.id);
    return [{ id: row.id, name: row.name.trim(), chord: serializeChord(parseChord(row.chord)!) }];
  });
}
