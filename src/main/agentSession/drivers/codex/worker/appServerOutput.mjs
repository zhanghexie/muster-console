// The native app-server sends MCP image results to the model itself, then may
// repeat their base64 bytes in an item/completed event. Keep those bytes out of
// the workbench event stream while retaining a small, bounded event summary.
export const MAX_APP_SERVER_FRAME_BYTES = 1024 * 1024;
export const MAX_APP_SERVER_IMAGE_FRAME_BYTES = MAX_APP_SERVER_FRAME_BYTES + Math.ceil(20 * 1024 * 1024 / 3) * 4 + 4096;
export const DESKTOP_IMAGE_EVENT_SUMMARY = '[Desktop screenshot image omitted from host event]';

export function projectAppServerOutput(value, frameBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(frameBytes) || frameBytes < 0 ||
      frameBytes > MAX_APP_SERVER_IMAGE_FRAME_BYTES) throw new Error('Codex app-server 输出超限');
  const item = value?.params?.item, result = item?.result, content = result?.content;
  // Codex 0.166 serializes oversized MCP results as a single truncated text
  // preview in its event, while delivering the original result to the model.
  // Recognize only the screenshot tool's successful PNG preview; never turn
  // other large output or a failed tool result into an apparent success.
  const preview = Array.isArray(content) && content.length === 1 ? content[0] : null;
  if (value.method === 'item/completed' && item?.type === 'mcpToolCall' && item.server === 'muster' &&
      item.tool === 'host_desktop_look' && item.status === 'completed' && !item.error && result?.isError !== true &&
      preview?.type === 'text' && typeof preview.text === 'string' &&
      preview.text.length >= MAX_APP_SERVER_FRAME_BYTES - 4096 &&
      preview.text.startsWith('{"content":[') && preview.text.includes('"type":"image"') &&
      preview.text.includes('iVBORw0KGgo') && /…\d+ chars truncated…/.test(preview.text)) {
    const projected = { ...value, params: { ...value.params, item: { ...item, result: { ...result,
      content: [{ type: 'text', text: DESKTOP_IMAGE_EVENT_SUMMARY }] } } } };
    if (Buffer.byteLength(JSON.stringify(projected)) > MAX_APP_SERVER_FRAME_BYTES) throw new Error('Codex app-server 输出超限');
    return projected;
  }
  if (value.method === 'item/completed' && item?.type === 'mcpToolCall' && item.server === 'muster' &&
      item.tool === 'host_desktop_look' && Array.isArray(content) && content.some(part => part?.type === 'image')) {
    const images = content.filter(part => part?.type === 'image');
    const image = images[0];
    if (images.length !== 1 || content.length !== 2 || content.some(part => !part || typeof part !== 'object' || Array.isArray(part)) ||
        content.filter(part => part.type === 'text' && typeof part.text === 'string').length !== 1 ||
        image.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length < 60 ||
        image.data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 || image.data.length % 4 !== 0 ||
        !image.data.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      throw new Error('Codex screenshot image event is invalid');
    }
    const projected = { ...value, params: { ...value.params, item: { ...item, result: { ...result,
      content: content.map(part => part.type === 'image' ? { type: 'text', text: DESKTOP_IMAGE_EVENT_SUMMARY } : part) } } } };
    if (Buffer.byteLength(JSON.stringify(projected)) > MAX_APP_SERVER_FRAME_BYTES) throw new Error('Codex app-server 输出超限');
    return projected;
  }
  if (frameBytes > MAX_APP_SERVER_FRAME_BYTES) throw new Error('Codex app-server 输出超限');
  return value;
}
