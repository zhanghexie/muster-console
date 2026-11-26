import type { DesktopCaptureArtifacts } from './captureArtifacts';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface DisplayCaptureTarget {
  taskId: string;
  surfaceId: string;
  surfaceGeneration: string;
  geometryRevision: string;
  displayId: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}
export interface DisplayCaptureRegion { x: number; y: number; width: number; height: number }
export interface DisplayCaptureStability { intervalMs: number; timeoutMs: number }
export interface CaptureImage {
  isEmpty(): boolean; getSize(): { width: number; height: number }; toPNG(): Buffer;
  crop?(region: DisplayCaptureRegion): CaptureImage;
}
interface ImageSource {
  display_id: string;
  thumbnail: CaptureImage;
}
export interface DisplayCaptureDependencies {
  /** getSources obtains thumbnails for all screens, not only the selected display. */
  getSources: (options: { types: ['screen']; thumbnailSize: { width: number; height: number } }) => Promise<ImageSource[]>;
  /** Decode the source PNG into a single 1x pixel representation. */
  normalizePng: (png: Buffer) => CaptureImage;
  confirmAllDisplays: (target: Readonly<DisplayCaptureTarget>, signal?: AbortSignal) => Promise<boolean>;
  audit: (target: Readonly<DisplayCaptureTarget>, stage: 'approved' | 'denied' | 'capture-start' | 'capture-ready' | 'capture-failed') => Promise<void>;
  artifacts: Pick<DesktopCaptureArtifacts, 'create' | 'remove'>;
}

export function assertDisplayCaptureOptions(ttlMs: number, region?: DisplayCaptureRegion, waitForStable?: DisplayCaptureStability): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) throw new Error('Invalid capture lifetime');
  if (region !== undefined && (!region || typeof region !== 'object' || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
      region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1)) throw new Error('Invalid capture region');
  if (waitForStable !== undefined && (!waitForStable || typeof waitForStable !== 'object' || !Number.isSafeInteger(waitForStable.intervalMs) || waitForStable.intervalMs < 20 || waitForStable.intervalMs > 1000 ||
      !Number.isSafeInteger(waitForStable.timeoutMs) || waitForStable.timeoutMs < waitForStable.intervalMs || waitForStable.timeoutMs > 5000)) {
    throw new Error('Invalid capture stability policy');
  }
}

/** Staged read-only adapter. Its result cannot authorize coordinate input. */
export async function captureDisplay(deps: DisplayCaptureDependencies, raw: DisplayCaptureTarget,
  isCurrent: () => boolean, ttlMs: number, signal?: AbortSignal, region?: DisplayCaptureRegion, waitForStable?: DisplayCaptureStability): Promise<{
    captureId: string; surfaceId: string; surfaceGeneration: string; geometryRevision: string;
    artifactId: string; path: string; mimeType: 'image/png'; width: number; height: number;
    capturedAt: number; expiresAt: number; coordinateSpace: 'capture-pixel-v1'; limitations: string[];
    sourceSize: { width: number; height: number }; region: DisplayCaptureRegion;
    stability: { status: 'not_requested' | 'observed_stable' | 'timeout'; samples: number };
  }> {
  if (!raw || [raw.taskId, raw.surfaceId, raw.surfaceGeneration, raw.geometryRevision].some(v => typeof v !== 'string' || !v.trim()) ||
      !Number.isSafeInteger(raw.displayId) || raw.displayId < 0 || !raw.bounds ||
      ![raw.bounds.x, raw.bounds.y, raw.bounds.width, raw.bounds.height, raw.scaleFactor].every(Number.isFinite) ||
      raw.bounds.width <= 0 || raw.bounds.height <= 0 || raw.scaleFactor <= 0 ||
      typeof isCurrent !== 'function' ||
      !deps || typeof deps.getSources !== 'function' || typeof deps.normalizePng !== 'function' || typeof deps.confirmAllDisplays !== 'function' || typeof deps.audit !== 'function' ||
      typeof deps.artifacts?.create !== 'function' || typeof deps.artifacts?.remove !== 'function') throw new Error('Invalid display capture request');
  assertDisplayCaptureOptions(ttlMs, region, waitForStable);
  const requestedRegion = region && Object.freeze({ ...region });
  const stablePolicy = waitForStable && Object.freeze({ ...waitForStable });
  const target = Object.freeze({ ...raw, bounds: Object.freeze({ ...raw.bounds }) });
  const width = Math.ceil(target.bounds.width * target.scaleFactor), height = Math.ceil(target.bounds.height * target.scaleFactor);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('Display capture exceeds supported dimensions');
  const assertCurrent = (): void => {
    signal?.throwIfAborted();
    if (!isCurrent()) throw new Error('Display identity or geometry changed');
  };
  assertCurrent();
  const allowed = await deps.confirmAllDisplays(target, signal) === true;
  await deps.audit(target, allowed ? 'approved' : 'denied');
  assertCurrent();
  if (!allowed) throw new Error('Screen capture declined');
  await deps.audit(target, 'capture-start');
  try {
    const sample = async () => {
      assertCurrent();
      const sources = await deps.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      assertCurrent();
      if (!Array.isArray(sources)) throw new Error('Screen capture returned invalid sources');
      const matches = sources.filter(source => source?.display_id === String(target.displayId));
      if (matches.length !== 1) throw new Error('Screen source cannot be matched uniquely to the display; check screen capture permissions and portal selection');
      const source = matches[0].thumbnail;
      if (!source || typeof source.isEmpty !== 'function' || source.isEmpty() || typeof source.toPNG !== 'function') {
        throw new Error('Screen capture returned an empty image; check screen recording permission');
      }
      const sourcePng = source.toPNG();
      if (!Buffer.isBuffer(sourcePng) || sourcePng.length < 24 || sourcePng.length > 20 * 1024 * 1024 ||
          !sourcePng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          sourcePng.readUInt32BE(8) !== 13 || sourcePng.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Capture returned invalid image bytes');
      const pngWidth = sourcePng.readUInt32BE(16), pngHeight = sourcePng.readUInt32BE(20);
      if (pngWidth < 1 || pngHeight < 1 || pngWidth > 8192 || pngHeight > 8192 || pngWidth * pngHeight > 40_000_000) {
        throw new Error('Screen capture returned invalid image dimensions');
      }
      const image = deps.normalizePng(sourcePng);
      if (!image || typeof image.isEmpty !== 'function' || image.isEmpty() || typeof image.getSize !== 'function' || typeof image.toPNG !== 'function') {
        throw new Error('Cannot normalize capture to pixel coordinates');
      }
      const sourceSize = image.getSize();
      if (!Number.isSafeInteger(sourceSize?.width) || !Number.isSafeInteger(sourceSize?.height) || sourceSize.width < 1 || sourceSize.height < 1 ||
          sourceSize.width > 8192 || sourceSize.height > 8192 || sourceSize.width * sourceSize.height > 40_000_000) throw new Error('Screen capture returned invalid image dimensions');
      if (sourceSize.width !== pngWidth || sourceSize.height !== pngHeight) {
        throw new Error('Capture normalization does not match source PNG pixels');
      }
      const selected = requestedRegion ?? { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height };
      if (selected.x + selected.width > sourceSize.width || selected.y + selected.height > sourceSize.height) throw new Error('Capture region is outside the source image');
      if (requestedRegion && typeof image.crop !== 'function') throw new Error('Capture region is unsupported by this image backend');
      const output = requestedRegion ? image.crop!(selected) : image;
      if (!output || typeof output.isEmpty !== 'function' || output.isEmpty() || typeof output.getSize !== 'function' || typeof output.toPNG !== 'function') throw new Error('Capture region returned an empty image');
      const size = output.getSize();
      if (size.width !== selected.width || size.height !== selected.height) throw new Error('Capture region dimensions changed');
      const png = output.toPNG();
      if (!Buffer.isBuffer(png) || png.length > 20 * 1024 * 1024) throw new Error('Capture returned invalid image bytes');
      assertCurrent();
      return { png, size, sourceSize, selected };
    };
    const deadline = performance.now() + (stablePolicy?.timeoutMs ?? 0);
    let frame = await sample(), samples = 1;
    let status: 'not_requested' | 'observed_stable' | 'timeout' = stablePolicy ? 'timeout' : 'not_requested';
    if (stablePolicy) {
      const fingerprint = (value: typeof frame) => createHash('sha256').update(JSON.stringify([value.sourceSize, value.selected])).update(value.png).digest('hex');
      let previous = fingerprint(frame);
      while (performance.now() < deadline) {
        await delay(Math.min(stablePolicy.intervalMs, Math.max(1, deadline - performance.now())), undefined, { signal });
        assertCurrent();
        if (performance.now() >= deadline) break;
        frame = await sample(); samples++;
        const next = fingerprint(frame);
        if (performance.now() <= deadline && next === previous) { status = 'observed_stable'; break; }
        previous = next;
      }
    }
    const { png, size, sourceSize, selected } = frame;
    const artifact = await deps.artifacts.create(target.taskId, png, ttlMs);
    try {
      assertCurrent();
      if (artifact.width !== size.width || artifact.height !== size.height) throw new Error('Screen capture image dimensions changed');
      await deps.audit(target, 'capture-ready');
      assertCurrent();
      // One capture has exactly one persisted artifact: the same opaque ID enables scoped
      // taskId + captureId reads without an in-memory mapping lost on restart.
      return { ...artifact, captureId: artifact.artifactId, surfaceId: target.surfaceId, surfaceGeneration: target.surfaceGeneration,
        geometryRevision: target.geometryRevision, coordinateSpace: 'capture-pixel-v1', sourceSize: { ...sourceSize }, region: { ...selected }, stability: { status, samples },
        limitations: ['all_display_thumbnails_requested', 'input_coordinate_mapping_unverified'] };
    } catch (error) {
      try { await deps.artifacts.remove(target.taskId, artifact.artifactId); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Capture was not published and cleanup failed'); }
      throw error;
    }
  } catch (error) {
    try { await deps.audit(target, 'capture-failed'); }
    catch (auditError) { throw new AggregateError([error, auditError], 'Screen capture failed and failure audit could not be recorded'); }
    throw error;
  }
}
