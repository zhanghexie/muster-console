import { AsyncLocalStorage } from 'node:async_hooks';

/** Only host execution can stage a screenshot; paths or bytes from model arguments are never used. */
export interface DesktopCaptureImage { readonly type: 'image'; readonly mimeType: 'image/png'; readonly data: string }
type Candidate = { readonly data: Buffer; readonly current: () => boolean };
type Scope = { open: boolean; image?: Candidate };
const scopes = new AsyncLocalStorage<Scope>();
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function desktopCaptureImageRequested(): boolean { return scopes.getStore()?.open === true; }

/** Must be called with validated artifact bytes and the live capture authorization. */
export function stageDesktopCaptureImage(data: Buffer, current: () => boolean): void {
  const scope = scopes.getStore();
  if (!scope) return;
  if (!scope.open || scope.image || !Buffer.isBuffer(data) || data.length < 45 || data.length > 20 * 1024 * 1024 ||
      !data.subarray(0, 8).equals(png) || typeof current !== 'function' || current() !== true) {
    throw new Error('Desktop screenshot image is unavailable');
  }
  scope.image = { data: Buffer.from(data), current };
}

/** Nested host projections share one scope so the outer engine receives the same screenshot. */
export async function withDesktopCaptureImageScope<T>(execute: () => Promise<T>): Promise<{ value: T; image?: DesktopCaptureImage; imageCurrent?: () => boolean }> {
  if (typeof execute !== 'function') throw new Error('Desktop image execution is unavailable');
  const existing = scopes.getStore();
  if (existing) {
    if (!existing.open) throw new Error('Desktop screenshot execution has ended');
    return { value: await execute() };
  }
  const scope: Scope = { open: true };
  return scopes.run(scope, async () => {
    try {
      const value = await execute();
      if (!scope.image) return { value };
      try { if (scope.image.current() !== true) throw new Error('Desktop screenshot authorization changed'); }
      catch { throw new Error('Desktop screenshot authorization changed'); }
      return { value, image: { type: 'image' as const, mimeType: 'image/png' as const, data: scope.image.data.toString('base64') },
        imageCurrent: scope.image.current };
    } finally { scope.open = false; scope.image = undefined; }
  });
}
