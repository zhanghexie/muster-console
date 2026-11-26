import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

function parseRange(rangeHeader, fileSize) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start;
  let end;
  if (!hasStart) {
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : fileSize - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable';
  if (start < 0 || start >= fileSize || end < start) return 'unsatisfiable';
  end = Math.min(end, fileSize - 1);
  return { start, end };
}

async function serve(absPath, request) {
  const st = await fsp.stat(absPath);
  const fileSize = st.size;
  const rangeHeader = request.headers.get('range');
  if (rangeHeader && fileSize > 0) {
    const parsed = parseRange(rangeHeader, fileSize);
    if (parsed === 'unsatisfiable' || parsed === null) {
      return new Response('bad', { status: 416 });
    }
    const { start, end } = parsed;
    const body = Readable.toWeb(fs.createReadStream(absPath, { start, end }));
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes'
      }
    });
  }
  const body = Readable.toWeb(fs.createReadStream(absPath));
  return new Response(body, {
    status: 200,
    headers: { 'Content-Length': String(fileSize), 'Accept-Ranges': 'bytes' }
  });
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ma-media-range-'));
const file = path.join(root, 'clip.bin');
await fsp.writeFile(file, Buffer.from('0123456789ABCDEFGHIJ'));
try {
  const ranged = await serve(file, new Request('x://y', { headers: { Range: 'bytes=4-8' } }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('Content-Range'), 'bytes 4-8/20');
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('utf8'), '45678');
  console.log('ok: media-range');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
