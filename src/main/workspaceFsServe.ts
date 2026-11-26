import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { mimeForPath } from '../shared/mediaKinds';

function parseRange(
  rangeHeader: string,
  fileSize: number
): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start: number;
  let end: number;
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

/**
 * 本地文件响应：显式支持 Range / 206，否则 Chromium `<video>` 会播几秒后卡住。
 */
export async function serveWorkspaceFile(absPath: string, request: Request): Promise<Response> {
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  }
  if (!st.isFile()) {
    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  }

  const fileSize = st.size;
  const mime = mimeForPath(absPath);
  const rangeHeader = request.headers.get('range');

  if (rangeHeader && fileSize > 0) {
    const parsed = parseRange(rangeHeader, fileSize);
    if (parsed === 'unsatisfiable' || parsed === null) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: {
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }
    const { start, end } = parsed;
    const chunkSize = end - start + 1;
    const nodeStream = fs.createReadStream(absPath, { start, end });
    const body = Readable.toWeb(nodeStream) as ReadableStream;
    return new Response(body, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': mime,
        'Content-Length': String(chunkSize),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes'
      }
    });
  }

  if (fileSize === 0) {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': '0',
        'Accept-Ranges': 'bytes'
      }
    });
  }

  const nodeStream = fs.createReadStream(absPath);
  const body = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes'
    }
  });
}
