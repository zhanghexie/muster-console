import type { ToolDef } from './types';
export const ATTACHMENT_TOOL_DEFS: ToolDef[] = [{
  name: 'attachments.convert', dangerous: false,
  description: "Convert managed attachments without modifying originals: PDF/slides -> page images/text, documents -> text chunks, video -> timed frames. Returns ranges, continuation and coverage gaps; open image paths with an image tool. Max 16 pages/frames, 6000 text chars. Slide images require LibreOffice; fall back to text.",
  parameters: { type: 'object', required: ['sourcePath', 'mode'], properties: {
    sourcePath: { type: 'string', description: "Managed source path from attachment metadata." }, mode: { type: 'string', enum: ['images', 'text', 'video'] },
    startPage: { type: 'integer', minimum: 1, description: "1-based page." },
    count: { type: 'integer', minimum: 1, maximum: 16 },
    offset: { type: 'integer', minimum: 0, description: "Character offset for non-PDF text." },
    maxChars: { type: 'integer', minimum: 1, maximum: 6000 },
    startSeconds: { type: 'number', minimum: 0 }, intervalSeconds: { type: 'number', minimum: 1 }
  } }
}];
