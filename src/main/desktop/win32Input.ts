import koffi from 'koffi';

/** Win32 INPUT records for SendInput. The process architecture fixes the union alignment. */
export function win32InputRecords(events: readonly ({ kind: 'mouse'; flags: number; data?: number } |
  { kind: 'key'; vk?: number; scan?: number; flags?: number })[], pointerBytes = process.arch === 'ia32' ? 4 : 8): Buffer {
  if (![4, 8].includes(pointerBytes) || !Array.isArray(events) || !events.length || events.length > 4096) throw new Error('Invalid Windows input batch');
  const size = pointerBytes === 8 ? 40 : 28, union = pointerBytes === 8 ? 8 : 4;
  const bytes = Buffer.alloc(size * events.length);
  events.forEach((event, index) => {
    const offset = index * size;
    if (event.kind === 'mouse') {
      if (!Number.isSafeInteger(event.flags) || event.flags < 0 || event.flags > 0xffffffff ||
          !Number.isInteger(event.data ?? 0) || (event.data ?? 0) < -2147483648 || (event.data ?? 0) > 0xffffffff) throw new Error('Invalid mouse input');
      bytes.writeUInt32LE(0, offset);
      bytes.writeUInt32LE((event.data ?? 0) >>> 0, offset + union + 8);
      bytes.writeUInt32LE(event.flags, offset + union + 12);
    } else if (event.kind === 'key') {
      const { vk = 0, scan = 0, flags = 0 } = event;
      if (![vk, scan].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff) ||
          !Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) throw new Error('Invalid keyboard input');
      bytes.writeUInt32LE(1, offset);
      bytes.writeUInt16LE(vk, offset + union);
      bytes.writeUInt16LE(scan, offset + union + 2);
      bytes.writeUInt32LE(flags, offset + union + 4);
    } else throw new Error('Invalid Windows input event');
  });
  return bytes;
}

export interface Win32InputApi {
  cursor(x: number, y: number): number;
  send(count: number, bytes: Buffer, size: number): number;
}

/** Low-level adapter only. Callers must establish authority and current target before dispatch. */
export class Win32Input {
  constructor(private readonly api: Win32InputApi) {}
  move(x: number, y: number): void {
    if (![x, y].every(Number.isSafeInteger) || [x, y].some(value => value < -2147483648 || value > 2147483647)) throw new Error('Invalid desktop point');
    if (!this.api.cursor(x, y)) throw new Error('SetCursorPos failed');
  }
  send(events: Parameters<typeof win32InputRecords>[0]): void {
    const data = win32InputRecords(events), size = data.length / events.length;
    if (this.api.send(events.length, data, size) !== events.length) throw new Error('SendInput did not dispatch the complete batch');
  }
}

export type Win32InputAction =
  | { action: 'move' | 'hover'; x: number; y: number }
  | { action: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number; button?: 'left' | 'right' | 'middle' }
  | { action: 'scroll'; x: number; y: number; delta: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keys: number[] };

/** Serial input executor; a failed or cancelled press always attempts its matching release. */
export async function performWin32Input(input: Pick<Win32Input, 'move' | 'send'>, request: Win32InputAction, signal?: AbortSignal): Promise<void> {
  if (!request || typeof request !== 'object') throw new Error('Invalid desktop action');
  const check = (): void => { signal?.throwIfAborted(); };
  const buttons = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] } as const;
  check();
  switch (request.action) {
    case 'move': case 'hover': input.move(request.x, request.y); return;
    case 'click': case 'drag': {
      const button = buttons[request.button ?? 'left'];
      if (!button) throw new Error('Invalid desktop mouse button');
      // Validate the destination before pressing a button.
      if (request.action === 'drag' && ![request.toX, request.toY].every(value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647)) throw new Error('Invalid desktop point');
      input.move(request.x, request.y); check();
      try {
        input.send([{ kind: 'mouse', flags: button[0] }]); check();
        if (request.action === 'drag') input.move(request.toX, request.toY);
        check();
      } finally { input.send([{ kind: 'mouse', flags: button[1] }]); }
      return;
    }
    case 'scroll':
      if (!Number.isSafeInteger(request.delta) || !request.delta || Math.abs(request.delta) > 12000) throw new Error('Invalid desktop scroll delta');
      input.move(request.x, request.y); check(); input.send([{ kind: 'mouse', flags: 0x0800, data: request.delta }]); return;
    case 'type':
      if (typeof request.text !== 'string' || !request.text.length || request.text.length > 1024) throw new Error('Invalid desktop text');
      for (let i = 0; i < request.text.length; i++) {
        check(); const scan = request.text.charCodeAt(i);
        try { input.send([{ kind: 'key', scan, flags: 4 }]); }
        finally { input.send([{ kind: 'key', scan, flags: 6 }]); }
        // Let the monitor's pipe and the host abort handler run during long
        // text entry. Every yield is after the corresponding key release.
        if ((i + 1) % 16 === 0 && i + 1 < request.text.length) await new Promise<void>(resolve => setImmediate(resolve));
      }
      return;
    case 'key': {
      if (!Array.isArray(request.keys) || request.keys.length < 1 || request.keys.length > 8 ||
          request.keys.some(key => !Number.isInteger(key) || key < 1 || key > 255) || new Set(request.keys).size !== request.keys.length) throw new Error('Invalid desktop key chord');
      const pressed: number[] = [];
      const extended = (vk: number): number => [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x6f, 0x90, 0xa3, 0xa5].includes(vk) ? 1 : 0;
      try {
        for (const vk of request.keys) { check(); pressed.push(vk); input.send([{ kind: 'key', vk, flags: extended(vk) }]); }
      } finally {
        const failures: unknown[] = [];
        for (const vk of pressed.reverse()) {
          try { input.send([{ kind: 'key', vk, flags: 2 | extended(vk) }]); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'Desktop key release failed');
      }
      return;
    }
    default: throw new Error('Unsupported desktop action');
  }
}

export function createWin32Input(): Win32Input {
  if (process.platform !== 'win32') throw new Error('Windows input is unavailable on this platform');
  const user = koffi.load('user32.dll');
  const cursor = user.func('__stdcall', 'SetCursorPos', 'int', ['int32', 'int32']);
  const send = user.func('__stdcall', 'SendInput', 'uint32', ['uint32', 'void *', 'int32']);
  return new Win32Input({ cursor, send });
}
