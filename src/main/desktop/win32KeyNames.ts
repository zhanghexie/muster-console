/** Translate supported key labels to the existing Windows virtual-key input contract. */
const named = new Map<string, number>([
  ['backspace', 0x08], ['tab', 0x09], ['enter', 0x0d], ['return', 0x0d],
  ['shift', 0x10], ['shiftleft', 0xa0], ['shiftright', 0xa1],
  ['ctrl', 0x11], ['control', 0x11], ['controlleft', 0xa2], ['ctrlleft', 0xa2], ['controlright', 0xa3], ['ctrlright', 0xa3],
  ['alt', 0x12], ['altleft', 0xa4], ['altright', 0xa5],
  ['pause', 0x13], ['capslock', 0x14], ['esc', 0x1b], ['escape', 0x1b], ['space', 0x20],
  ['pageup', 0x21], ['pagedown', 0x22], ['end', 0x23], ['home', 0x24],
  ['left', 0x25], ['arrowleft', 0x25], ['up', 0x26], ['arrowup', 0x26],
  ['right', 0x27], ['arrowright', 0x27], ['down', 0x28], ['arrowdown', 0x28],
  ['printscreen', 0x2c], ['insert', 0x2d], ['delete', 0x2e], ['del', 0x2e],
  ['meta', 0x5b], ['win', 0x5b], ['metaleft', 0x5b], ['winleft', 0x5b], ['metaright', 0x5c], ['winright', 0x5c],
  ['contextmenu', 0x5d], ['numlock', 0x90], ['scrolllock', 0x91]
]);

/** Numbers retain their previous meaning; names describe keys, not text or keyboard layouts. */
export function normalizeWin32Keys(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new Error('Invalid desktop key chord');
  const keys = raw.map(value => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 255) return value;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new Error('Invalid desktop key name');
    const name = value.replace(/[_-]/g, '').toLowerCase();
    const exact = named.get(name);
    if (exact !== undefined) return exact;
    const character = /^(?:key)?([a-z])$/.exec(name) ?? /^(?:digit)?([0-9])$/.exec(name);
    if (character) return character[1]!.toUpperCase().charCodeAt(0);
    const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name);
    if (fn) return 0x6f + Number(fn[1]);
    throw new Error(`Unsupported desktop key name: ${value}`);
  });
  if (new Set(keys).size !== keys.length) throw new Error('Desktop key chord contains duplicate keys');
  return keys;
}
