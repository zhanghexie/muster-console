/** Fully decode a PNG before claiming a capture artifact is valid. */
export async function decodeDesktopPng(data: Buffer): Promise<{ width: number; height: number }> {
  let sharp: typeof import('sharp').default;
  try { sharp = (await import('sharp')).default; }
  catch { throw new Error('PNG decoder is unavailable; reinstall the workbench for this platform'); }
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: 40_000_000, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new Error('Expected a single PNG frame');
    const result = await image.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    if (!result.info.width || !result.info.height) throw new Error('Invalid decoded dimensions');
    return { width: result.info.width, height: result.info.height };
  } catch (error) {
    throw new Error(`Cannot decode PNG capture: ${error instanceof Error ? error.message : String(error)}`);
  }
}
