/**
 * terminal.capture 截图路径旁路：按 toolCallId 暂存，不进模型 tool result。
 *
 * 没有 toolCallId 的调用只能进 FIFO 兜底认领，而认领方未必来取；无上限时
 * 这两个容器会随会话时长单调增长，因此按 MAX_PENDING 淘汰最旧的。
 */
const MAX_PENDING = 32;

const byId = new Map<string, string>();
const fifo: string[] = [];

function evictOldest(): void {
  while (fifo.length > MAX_PENDING) {
    const dropped = fifo.shift();
    if (!dropped) break;
    for (const [id, p] of byId) {
      if (p === dropped) byId.delete(id);
    }
  }
}

export function rememberCapturePreview(toolCallId: string, imagePath: string): void {
  const p = imagePath.trim();
  if (!p) return;
  fifo.push(p);
  const id = toolCallId.trim();
  if (id) byId.set(id, p);
  evictOldest();
}

export function takeCapturePreview(toolCallId: string): string | undefined {
  const id = toolCallId.trim();
  if (id && byId.has(id)) {
    const v = byId.get(id)!;
    byId.delete(id);
    const idx = fifo.indexOf(v);
    if (idx >= 0) fifo.splice(idx, 1);
    return v;
  }
  return fifo.shift();
}
