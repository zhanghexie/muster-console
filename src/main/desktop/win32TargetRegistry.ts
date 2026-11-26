import type { TrustedDisplayActor } from './displayService';
import type { DisplayCaptureTarget } from './displayCapture';
import type { CuaSemanticActor } from './cuaSemanticRuntime';
import { enumerateWin32WindowsPhysical } from './win32Inventory';
import { resolveWin32SemanticTarget } from './win32SemanticTarget';
import { Win32Targets, type Win32CaptureFrame } from './win32Targets';
import { createWin32WindowGeneration } from './win32WindowGeneration';

type Point = { x: number; y: number };
type FrameResult = { captureId: string; surfaceId: string; surfaceGeneration: string; geometryRevision: string; expiresAt: number;
  width: number; height: number; sourceSize: { width: number; height: number }; region: { x: number; y: number; width: number; height: number } };
type Generation = ConstructorParameters<typeof Win32Targets>[1];

/** Reuse capture-bound Windows identities without opening the legacy action writer. */
export class Win32TargetRegistry {
  private readonly targets: Win32Targets;
  constructor(physicalToDip: (point: Point) => Point, createGenerations: () => Generation = createWin32WindowGeneration,
    inventory = enumerateWin32WindowsPhysical) {
    this.targets = new Win32Targets(() => {
      const snapshot = inventory();
      return { ...snapshot, windows: snapshot.windows.map(window => {
        const left = physicalToDip({ x: window.bounds.x, y: window.bounds.y });
        const right = physicalToDip({ x: window.bounds.x + window.bounds.width, y: window.bounds.y + window.bounds.height });
        return { ...window, bounds: { x: left.x, y: left.y, width: right.x - left.x, height: right.y - left.y } };
      }) };
    }, createGenerations());
  }

  register(actor: TrustedDisplayActor, capture: FrameResult, display: DisplayCaptureTarget, isCurrent: () => boolean, offset = 0) {
    if (!actor.isCurrent() || !isCurrent()) throw new Error('Desktop capture changed');
    const frame: Win32CaptureFrame = { ...capture, sessionId: actor.sessionId, taskId: actor.taskId, bounds: { ...display.bounds },
      isCurrent: () => actor.isCurrent() && isCurrent() };
    return this.targets.register(frame, offset);
  }

  resolve(sessionId: string, taskId: string, windowId: string) { return this.targets.resolve(sessionId, taskId, windowId); }
  semanticTarget(actor: CuaSemanticActor, windowId: string) { return resolveWin32SemanticTarget(this.targets, actor, windowId); }
  visibleTarget(actor: TrustedDisplayActor, windowId: string) {
    if (actor.isCurrent() !== true) throw new Error('Desktop caller is no longer current');
    const selected = this.targets.resolve(actor.sessionId, actor.taskId, windowId);
    return { ...selected, isCurrent: () => actor.isCurrent() === true && selected.isCurrent() === true };
  }
  close(): void { this.targets.close(); }
}
