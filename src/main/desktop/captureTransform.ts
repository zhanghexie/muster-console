/** Versioned screenshot coordinates are valid only for the exact captured surface geometry. */
export interface CaptureTransform {
  captureId: string;
  surfaceId: string;
  surfaceGeneration: string;
  geometryRevision: string;
  expiresAt: number;
  width: number;
  height: number;
  coordinateSpace: 'capture-pixel-v1';
  targetSpace: 'platform-input-v1';
  /** Maps pixels in the returned image to platform input coordinates, after crop and scale. */
  transform: { originX: number; originY: number; scaleX: number; scaleY: number };
}

export function capturePointToInput(
  capture: CaptureTransform,
  current: { surfaceId: string; surfaceGeneration: string; geometryRevision: string },
  point: { x: number; y: number },
  now = Date.now()
): { x: number; y: number; coordinateSpace: 'platform-input-v1' } {
  if (!capture.captureId || !capture.surfaceId || !capture.surfaceGeneration || !capture.geometryRevision ||
      capture.surfaceId !== current.surfaceId || capture.surfaceGeneration !== current.surfaceGeneration ||
      capture.geometryRevision !== current.geometryRevision || !Number.isFinite(capture.expiresAt) ||
      !Number.isFinite(now) || capture.expiresAt <= now) throw new Error('Stale capture or surface geometry');
  if (capture.coordinateSpace !== 'capture-pixel-v1' || capture.targetSpace !== 'platform-input-v1' ||
      !Number.isSafeInteger(capture.width) || capture.width <= 0 || !Number.isSafeInteger(capture.height) || capture.height <= 0 ||
      !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
      point.x >= capture.width || point.y >= capture.height) {
    throw new Error(`Invalid capture point or coordinate space. Use pixels from the top-left of the returned ${capture.width}×${capture.height} image, including when it is cropped.`);
  }
  const { originX, originY, scaleX, scaleY } = capture.transform ?? {};
  if (typeof originX !== 'number' || typeof originY !== 'number' || typeof scaleX !== 'number' || typeof scaleY !== 'number' ||
      ![originX, originY, scaleX, scaleY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) {
    throw new Error('Invalid capture transform');
  }
  const x = originX + point.x * scaleX, y = originY + point.y * scaleY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Capture transform overflow');
  return { x, y, coordinateSpace: 'platform-input-v1' };
}
