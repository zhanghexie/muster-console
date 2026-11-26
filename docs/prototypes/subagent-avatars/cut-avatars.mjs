/** Rebuild approved flat glyph assets. Run from any cwd with repo dependencies installed. */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const manifest = JSON.parse(await fs.readFile(path.join(here, 'crops.json'), 'utf8'));
const source = path.join(here, manifest.source);
const dimensions = await sharp(source).metadata();
if (dimensions.width !== manifest.sourceSize[0] || dimensions.height !== manifest.sourceSize[1]) throw new Error('Approved sheet dimensions differ');
let total = 0;
for (const { id, left, top, width, height } of manifest.crops) {
  const { data, info } = await sharp(source).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Colored glyphs against a near-neutral backdrop. Preserve opaque interiors;
  // only recover edge alpha using the nearest interior color, including two-tone marks.
  const solid = new Uint8Array(width * height), interior = new Uint8Array(width * height);
  for (let n = 0; n < solid.length; n++) {
    const rgb = [data[n * info.channels], data[n * info.channels + 1], data[n * info.channels + 2]];
    solid[n] = Math.max(...rgb) > 80 && Math.max(...rgb) - Math.min(...rgb) > 25 ? 1 : 0;
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let all = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!solid[(y + dy) * width + x + dx]) all = false;
    interior[y * width + x] = all ? 1 : 0;
  }
  if (interior.reduce((n, v) => n + v, 0) < 200) throw new Error(`Missing glyph: ${id}`);
  const rgba = Buffer.alloc(width * height * 4);
  for (let n = 0; n < width * height; n++) {
    const rgb = [data[n * info.channels], data[n * info.channels + 1], data[n * info.channels + 2]];
    const range = Math.max(...rgb) - Math.min(...rgb);
    if (range < 6) continue;
    let alpha = 1;
    if (!interior[n]) {
      const x = n % width, y = Math.floor(n / width);
      let nearest = -1, distance = Infinity;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const other = (y + dy) * width + x + dx, d = dx * dx + dy * dy;
        if (interior[other] && d < distance) { nearest = other; distance = d; }
      }
      if (nearest < 0) continue;
      let dot = 0, norm = 0;
      for (let c = 0; c < 3; c++) { const fg = data[nearest * info.channels + c] - 22; dot += (rgb[c] - 22) * fg; norm += fg * fg; }
      alpha = Math.max(0, Math.min(1, dot / norm));
    }
    if (alpha < 0.025) continue;
    for (let c = 0; c < 3; c++) rgba[n * 4 + c] = Math.round(Math.max(0, Math.min(255, (rgb[c] - 22 * (1 - alpha)) / alpha)));
    rgba[n * 4 + 3] = Math.round(alpha * 255);
  }
  const output = path.join(root, 'src/renderer/src/assets/subagents', `${id}.webp`);
  await sharp(rgba, { raw: { width, height, channels: 4 } }).trim({ background: '#00000000', threshold: 8 })
    .resize(manifest.glyphSize, manifest.glyphSize, { fit: 'contain', background: '#00000000' })
    .extend({ top: manifest.padding, bottom: manifest.padding, left: manifest.padding, right: manifest.padding, background: '#00000000' })
    .webp({ quality: manifest.quality, alphaQuality: 100 }).toFile(output);
  total += (await fs.stat(output)).size;
}
console.log(`${manifest.crops.length} transparent avatars, ${manifest.outputSize.join('×')}, ${total} bytes`);
