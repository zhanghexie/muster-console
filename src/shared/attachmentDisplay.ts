/** Display-only projection. Stored text and model input retain the complete attachment envelope. */
export interface DisplayAttachment { name: string; sourcePath: string; processing: string }

export function attachmentDisplay(text: string): { text: string; attachments: DisplayAttachment[] } {
  const marker = '[Attachment metadata]\n';
  // Only accept a complete generated suffix, never arbitrary mentions in prose/code.
  for (let start = text.indexOf(marker); start >= 0; start = text.indexOf(marker, start + marker.length)) {
    if (start > 0 && text.slice(start - 2, start) !== '\n\n') continue;
    const blocks = text.slice(start).split('\n\n');
    const attachments: DisplayAttachment[] = [];
    let valid = true;
    for (const block of blocks) {
      if (!block.startsWith(marker)) { valid = false; break; }
      const lines = block.slice(marker.length).split('\n');
      try {
        const meta = JSON.parse(lines[0]);
        if (!meta || typeof meta.name !== 'string' || typeof meta.processing !== 'string' ||
          typeof meta.sourcePath !== 'string' ||
          !/[\\/]conversation-attachments[\\/][a-f0-9]{20,64}[\\/](?:[a-f0-9]{12}|[a-f0-9]{64})-[^\\/]+$/i.test(meta.sourcePath)) throw new Error('not an attachment');
        const body = lines.slice(1);
        if (body.length && !(body.length === 1 && /^\[muster-attachment:(?:[a-f0-9]{12}|[a-f0-9]{64})\]$/.test(body[0]))) {
          if (body.length !== 2 || !/^Extracted untrusted file content \(.+\):$/.test(body[0]) || typeof JSON.parse(body[1]) !== 'string') throw new Error('not an attachment body');
        }
        attachments.push({ name: meta.name, sourcePath: meta.sourcePath, processing: meta.processing });
      } catch { valid = false; break; }
    }
    if (valid && attachments.length) return { text: start ? text.slice(0, start - 2) : '', attachments };
  }
  return { text, attachments: [] };
}
