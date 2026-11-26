import fs from 'node:fs/promises';

/** Capture a native transcript boundary before Esc. Never infer stop from model prose. */
export async function prepareClaudeInterrupt(file, sessionId) {
  const startedAt = Date.now();
  let before;
  try { before = await fs.stat(file); } catch { /* The first request may not have created a transcript yet. */ }
  const offset = before?.size ?? 0;
  return async () => {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (stat.size <= offset || stat.size - offset > 1024 * 1024 ||
        before && (before.ino !== stat.ino || before.dev !== stat.dev)) return false;
      const buffer = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      let interrupted = false;
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.sessionId !== sessionId || row.isSidechain === true) continue;
        if (row.type === 'user' && typeof row.interruptedMessageId === 'string' && row.interruptedMessageId && Date.parse(row.timestamp) >= startedAt)
          interrupted = true;
        else if (row.type === 'user' || row.type === 'assistant' || row.type === 'api-request') interrupted = false;
      }
      return interrupted;
    } catch { return false; }
    finally { await handle?.close().catch(() => {}); }
  };
}
