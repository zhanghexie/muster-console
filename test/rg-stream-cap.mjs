import assert from 'node:assert/strict';

/**
 * 模拟「整段 stdout += chunk」在超大输出时会炸；流式按行消费则安全。
 */
function consumeLines(chunks, maxHits, onMatchLine) {
  let pending = '';
  let hits = 0;
  let stopped = false;
  const MAX_PENDING = 1024 * 1024;

  for (const chunk of chunks) {
    if (stopped) break;
    pending += chunk;
    assert.ok(pending.length <= MAX_PENDING, 'pending overflow');
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl < 0) break;
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line) continue;
      if (onMatchLine(line)) {
        hits += 1;
        if (hits >= maxHits) {
          stopped = true;
          break;
        }
      }
    }
  }
  return { hits, stopped };
}

const lines = Array.from({ length: 5000 }, (_, i) =>
  JSON.stringify({ type: 'match', data: { i } })
);
const chunks = [];
for (let i = 0; i < lines.length; i += 50) {
  chunks.push(lines.slice(i, i + 50).join('\n') + '\n');
}

const r = consumeLines(chunks, 200, (line) => {
  const msg = JSON.parse(line);
  return msg.type === 'match';
});
assert.equal(r.hits, 200);
assert.equal(r.stopped, true);

let boom = false;
try {
  let s = '';
  const piece = 'x'.repeat(16 * 1024 * 1024);
  for (let i = 0; i < 80; i++) s += piece;
} catch (err) {
  boom = err instanceof RangeError;
}
assert.equal(boom, true);

console.log('ok: rg-stream-cap');
