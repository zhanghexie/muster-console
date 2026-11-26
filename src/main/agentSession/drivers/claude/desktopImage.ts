import type { DesktopCaptureImage } from '../../../desktop/captureImageScope';

const MAX_ENCODED_BYTES = 4_000_000; // Below the documented 5 MB partner limit.
const MAX_EDGE = 1568, MAX_TOKENS = 1568, PATCH = 28;

/** Keep the delivered image within even the standard Claude resolution tier. */
function fits(width: number, height: number): boolean {
  return Math.ceil(width / PATCH) * PATCH <= MAX_EDGE && Math.ceil(height / PATCH) * PATCH <= MAX_EDGE &&
    Math.ceil(width / PATCH) * Math.ceil(height / PATCH) <= MAX_TOKENS;
}

function fitSize(width: number, height: number): { width: number; height: number } {
  if (fits(width, height)) return { width, height };
  if (height > width) { const swapped = fitSize(height, width); return { width: swapped.height, height: swapped.width }; }
  let low = 1, high = width;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2), candidateHeight = Math.max(Math.round(mid * height / width), 1);
    if (fits(mid, candidateHeight)) low = mid; else high = mid;
  }
  return { width: low, height: Math.max(Math.round(low * height / width), 1) };
}

/** Return both pixel spaces; desktop actions continue to use original capture pixels. */
export async function projectClaudeDesktopImage(image: DesktopCaptureImage, text: string): Promise<{
  image: DesktopCaptureImage; dimensions: { width: number; height: number; captureWidth: number; captureHeight: number }
}> {
  const bytes = Buffer.from(image.data, 'base64');
  if (image.mimeType !== 'image/png' || bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      bytes.toString('base64') !== image.data) throw new Error('Desktop screenshot image is invalid');
  const captureWidth = bytes.readUInt32BE(16), captureHeight = bytes.readUInt32BE(20);
  if (!captureWidth || !captureHeight || captureWidth > 32768 || captureHeight > 32768 || captureWidth * captureHeight > 40_000_000) {
    throw new Error('Desktop screenshot dimensions are invalid');
  }
  let envelope: { ok?: boolean; result?: { width?: number; height?: number } };
  try { envelope = JSON.parse(text); } catch { throw new Error('Desktop screenshot metadata is invalid'); }
  if (envelope?.ok !== true || envelope.result?.width !== captureWidth || envelope.result?.height !== captureHeight) {
    throw new Error('Desktop screenshot dimensions do not match its metadata');
  }
  let size = fitSize(captureWidth, captureHeight);
  let projected: Buffer = bytes;
  if (size.width !== captureWidth || size.height !== captureHeight || image.data.length > MAX_ENCODED_BYTES) {
    let sharp: typeof import('sharp').default;
    try { sharp = (await import('sharp')).default; }
    catch { throw new Error('Desktop screenshot scaling is unavailable; reinstall the workbench for this platform'); }
    for (let attempt = 0; attempt < 12; attempt++) {
      projected = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer();
      if (Math.ceil(projected.length / 3) * 4 <= MAX_ENCODED_BYTES) break;
      size = { width: Math.max(1, Math.floor(size.width * 0.8)), height: Math.max(1, Math.floor(size.height * 0.8)) };
    }
    if (Math.ceil(projected.length / 3) * 4 > MAX_ENCODED_BYTES) throw new Error('Desktop screenshot is too large for Claude; capture a smaller region');
  }
  return { image: { type: 'image', mimeType: 'image/png', data: projected.toString('base64') },
    dimensions: { ...size, captureWidth, captureHeight } };
}
