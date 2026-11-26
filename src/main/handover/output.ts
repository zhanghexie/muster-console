/** Limit a single exported tool result after JSON escaping, so it stays readable as a line. */
const MAX_OUTPUT_JSON_BYTES = 16 * 1024;
const KEEP_OUTPUT_JSON_BYTES = 4 * 1024;

type Truncated<T> = { value: T; truncated: false } | { value: string; truncated: true };

function jsonBytes(character: string): number {
  return Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
}

/** Count and cut at Unicode code point boundaries; the omitted length is in original UTF-8 bytes. */
export function truncateToolOutput(output: string): Truncated<string> {
  const originalBytes = Buffer.byteLength(output, 'utf8');
  if (originalBytes <= MAX_OUTPUT_JSON_BYTES && Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_OUTPUT_JSON_BYTES) {
    return { value: output, truncated: false };
  }
  let headEnd = 0;
  let headBytes = 0;
  for (const character of output) {
    const bytes = jsonBytes(character);
    if (headBytes + bytes > KEEP_OUTPUT_JSON_BYTES) break;
    headEnd += character.length;
    headBytes += bytes;
  }
  let tailStart = output.length;
  let tailBytes = 0;
  while (tailStart > headEnd) {
    let start = tailStart - 1;
    const low = output.charCodeAt(start);
    if (low >= 0xdc00 && low <= 0xdfff && start > headEnd) {
      const high = output.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start--;
    }
    const bytes = jsonBytes(output.slice(start, tailStart));
    if (tailBytes + bytes > KEEP_OUTPUT_JSON_BYTES) break;
    tailStart = start;
    tailBytes += bytes;
  }
  const omittedBytes = originalBytes - Buffer.byteLength(output.slice(0, headEnd), 'utf8') - Buffer.byteLength(output.slice(tailStart), 'utf8');
  return { value: `${output.slice(0, headEnd)}\n\n[交接快照：工具输出已截断，原始 ${originalBytes} 字节，省略 ${omittedBytes} 字节（UTF-8）]\n\n${output.slice(tailStart)}`, truncated: true };
}

/** Structured results are preserved as-is unless the complete serialized result needs clipping. */
export function truncateToolPayload<T>(payload: T): Truncated<T> {
  if (typeof payload === 'string') return truncateToolOutput(payload) as Truncated<T>;
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) return { value: payload, truncated: false };
  const clipped = truncateToolOutput(serialized);
  if (!clipped.truncated) return { value: payload, truncated: false };
  return { value: `[交接快照：原工具输出为 JSON，以下是截断后的序列化文本]\n${clipped.value}`, truncated: true };
}
