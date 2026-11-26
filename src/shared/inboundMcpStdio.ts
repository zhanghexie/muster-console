/**
 * Official MCP SDK uses NDJSON. Legacy Content-Length clients remain supported.
 */
export type McpStdioFormat = 'ndjson' | 'content-length';

export function encodeMcpStdioFrame(payload: unknown, format: McpStdioFormat = 'ndjson'): Buffer {
  const json = JSON.stringify(payload);
  if (format === 'ndjson') return Buffer.from(json + '\n', 'utf8');
  const body = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
}

export function createMcpStdioFramer(onMessage: (msg: unknown, format: McpStdioFormat) => void): {
  push: (chunk: Buffer) => void;
} {
  let buf = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length > 0) {
        if (!buf.subarray(0, 15).toString('utf8').toLowerCase().startsWith('content-length:')) {
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim();
          buf = buf.subarray(nl + 1);
          if (!line || line.toLowerCase().startsWith('content-length:')) continue;
          if (line.startsWith('{')) {
            try {
              onMessage(JSON.parse(line), 'ndjson');
            } catch {
              // 半包或噪声
            }
          }
          continue;
        }
        // Keep a fragmented header intact; never consume its first CRLF early.
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = buf.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          buf = buf.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(match[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) return;
        const body = buf.subarray(start, start + len).toString('utf8');
        buf = buf.subarray(start + len);
        try {
          onMessage(JSON.parse(body), 'content-length');
        } catch {
          // 坏 JSON 丢弃
        }
      }
    }
  };
}
