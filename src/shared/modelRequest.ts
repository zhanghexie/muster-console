const SCHEDULER_REQUEST_PREFIX = 'scheduler:';

export function schedulerModelRequestId(workspaceId: string): string {
  return SCHEDULER_REQUEST_PREFIX + workspaceId;
}

export function modelRequestSchedulerWorkspace(id: string): string | null {
  return id.startsWith(SCHEDULER_REQUEST_PREFIX) ? id.slice(SCHEDULER_REQUEST_PREFIX.length) : null;
}

export interface ModelRequestRow {
  id: number;
  at: number;
  model: string;
  protocol: string;
  bytes: number;
  complete: boolean;
  omitted?: boolean;
  compressionCount?: number;
}

export type ModelRequestExportResult =
  | { ok: true; path: string; count: number; omitted: number }
  | { ok: false; canceled?: boolean; error?: string };

export interface ModelRequestExportManifest {
  format: 'muster-model-requests';
  version: 1;
  exportedAt: string;
  sessionId: string;
  requests: (ModelRequestRow & {
    bodyFile: string | null;
    sha256: string | null;
    compression: RequestCompression[];
  })[];
}

export interface CompressionSource { id: string; role: string; chars: number }
export const COMPRESSION_SOURCE_PAGE = 6000;
export interface RequestCompression {
  kind: 'excerpt' | 'summary' | 'checkpoint' | 'native' | 'expanded';
  path: string;
  id: string;
  tool?: string;
  level?: number;
  previous?: string;
  sources: CompressionSource[];
}

/** Only protocol fields that deliver tool output or user text to the model. */
export function compressionFields(body: unknown): Map<string, string> {
  const fields = new Map<string, string>();
  if (!body || typeof body !== 'object') return fields;
  const record = body as Record<string, unknown>;
  const add = (path: string, value: unknown, tool: boolean) => {
    if (typeof value !== 'string') return;
    if (tool ? /^\[Core (excerpt|summary) · source /.test(value)
      : value.startsWith('The conversation history before this point was compacted into the following summary:\n\n<summary>\n')) fields.set(path, value);
  };
  function textParts(path: string, value: unknown, tool: boolean) {
    if (!Array.isArray(value)) return add(path, value, tool);
    value.forEach((part, i) => {
      if (part?.type === 'text' || part?.type === 'input_text') add(path + '[' + i + '].text', part.text, tool);
    });
  }
  for (const key of ['messages', 'input', 'contents']) {
    const messages = record[key];
    if (!Array.isArray(messages)) continue;
    messages.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const path = key + '[' + i + ']';
      if (m.type === 'function_call_output') textParts(path + '.output', m.output, true);
      if (m.role === 'tool' || m.role === 'user') textParts(path + '.content', m.content, m.role === 'tool');
      if (m.role !== 'user') return;
      const content: unknown = m.content;
      const parts: unknown = m.parts;
      if (Array.isArray(content)) content.forEach((p, j) => {
        if (p?.type === 'tool_result') textParts(path + '.content[' + j + '].content', p.content, true);
      });
      if (Array.isArray(parts)) parts.forEach((p, j) => {
        add(path + '.parts[' + j + '].text', p?.text, false);
        add(path + '.parts[' + j + '].functionResponse.response.output', p?.functionResponse?.response?.output, true);
      });
    });
  }
  return fields;
}
