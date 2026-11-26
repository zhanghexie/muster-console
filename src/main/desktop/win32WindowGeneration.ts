import { randomUUID } from 'node:crypto';
import koffi from 'koffi';

export interface WindowPropertyApi {
  get(handle: bigint, name: string): bigint | number | null;
  set(handle: bigint, name: string, value: bigint): number;
  remove(handle: bigint, name: string): bigint | number | null;
}

/** A per-runtime property stays attached to a window instance, not a recycled HWND. */
export class Win32WindowGeneration {
  private readonly name = `Muster-${randomUUID()}`;
  private next = 1n;
  private readonly live = new Map<string, bigint>();
  constructor(private readonly api: WindowPropertyApi) {}
  observe(nativeId: string): string | null {
    const handle = BigInt(nativeId), existing = BigInt(this.api.get(handle, this.name) ?? 0);
    if (existing) return existing.toString();
    // Stay within 32-bit pointer range on either architecture, never wrap in one runtime.
    if (this.next > 0x7fffffffn) throw new Error('Window generation capacity exhausted');
    const marker = this.next++;
    if (!this.api.set(handle, this.name, marker) || BigInt(this.api.get(handle, this.name) ?? 0) !== marker) return null;
    this.live.set(nativeId, marker);
    return marker.toString();
  }
  current(nativeId: string, marker: string): boolean {
    try { return BigInt(marker) !== 0n && BigInt(this.api.get(BigInt(nativeId), this.name) ?? 0) === BigInt(marker); }
    catch { return false; }
  }
  release(nativeId: string, marker: string): void {
    const expected = BigInt(marker);
    if (this.live.get(nativeId) !== expected) return;
    const actual = BigInt(this.api.get(BigInt(nativeId), this.name) ?? 0);
    if (actual === expected && BigInt(this.api.remove(BigInt(nativeId), this.name) ?? 0) !== expected) {
      throw new Error('Could not remove desktop window identity marker');
    }
    this.live.delete(nativeId);
  }
  close(): void {
    const failures: unknown[] = [];
    for (const [id, marker] of this.live) {
      try { this.release(id, marker.toString()); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Could not remove desktop window identity markers');
  }
}

export function createWin32WindowGeneration(): Win32WindowGeneration {
  if (process.platform !== 'win32') throw new Error('Windows window identity is unavailable on this platform');
  const user = koffi.load('user32.dll');
  return new Win32WindowGeneration({
    get: user.func('__stdcall', 'GetPropW', 'intptr_t', ['intptr_t', 'str16']),
    set: user.func('__stdcall', 'SetPropW', 'int', ['intptr_t', 'str16', 'intptr_t']),
    remove: user.func('__stdcall', 'RemovePropW', 'intptr_t', ['intptr_t', 'str16'])
  });
}
