import { promises as fs } from 'node:fs';
import path from 'node:path';
import { attachmentDir, type NativeManifest } from './service';

/** Only server-created manifests in the current conversation can resolve a marker. */
export async function expandAttachmentPayload(payload: any, api: string, dir: string): Promise<any> {
  const copy = { ...payload };
  const listKey = api === 'google-generative-ai' ? 'contents' : api.includes('responses') ? 'input' : 'messages';
  if (!Array.isArray(copy[listKey])) return payload;
  copy[listKey] = copy[listKey].map((m: any) => ({ ...m,
    ...(Array.isArray(m.content) ? { content: m.content.map((b: any) => ({ ...b })) } : {}),
    ...(Array.isArray(m.parts) ? { parts: m.parts.map((b: any) => ({ ...b })) } : {}) }));
  const messages = api === 'google-generative-ai' ? copy.contents : api.includes('responses') ? copy.input : copy.messages;
  if (!Array.isArray(messages)) return payload;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const key = api === 'google-generative-ai' ? 'parts' : 'content';
    if (!(JSON.stringify(message[key]) ?? '').includes('[muster-attachment:')) continue;
    if (typeof message[key] === 'string') message[key] = [{ type: 'text', text: message[key] }];
    if (!Array.isArray(message[key])) continue;
    const additions: unknown[] = [];
    for (const block of message[key]) {
      if (typeof block.text !== 'string') continue;
      const matches = [...block.text.matchAll(/\[muster-attachment:([a-f0-9]{12}|[a-f0-9]{64})\]/g)];
      for (const match of matches) {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, `${match[1]}.json`), 'utf8')) as NativeManifest;
        if (path.dirname(path.resolve(manifest.path)) !== path.resolve(dir)) throw new Error('附件源文件超出会话目录');
        const data = (await fs.readFile(manifest.path)).toString('base64');
        if (api === 'google-generative-ai') additions.push({ inlineData: { mimeType: manifest.mimeType, data } });
        else if (api === 'anthropic-messages' && manifest.kind === 'file') additions.push({ type: 'document', source: { type: 'base64', media_type: manifest.mimeType, data } });
        else if (api.includes('responses') && manifest.kind === 'file') additions.push({ type: 'input_file', filename: manifest.name, file_data: `data:${manifest.mimeType};base64,${data}` });
        else if (api === 'openai-completions' && manifest.kind === 'file') additions.push({ type: 'file', file: { filename: manifest.name, file_data: `data:${manifest.mimeType};base64,${data}` } });
        else if (api === 'openai-completions' && manifest.kind === 'audio') additions.push({ type: 'input_audio', input_audio: { data, format: manifest.mimeType === 'audio/wav' ? 'wav' : 'mp3' } });
        else if (api === 'openai-completions' && manifest.kind === 'video') additions.push({ type: 'video_url', video_url: { url: `data:${manifest.mimeType};base64,${data}` } });
        else throw new Error('当前协议无法发送历史原生附件，请切回原模型或开启新会话');
        block.text = block.text.replace(match[0], '');
      }
    }
    message[key].push(...additions);
  }
  return copy;
}

export function installAttachmentPayload(session: any, userData: string, scope: string): void {
  const agent = session.agent;
  if (!agent) throw new Error('Pi 缺少附件请求适配入口');
  const previous = agent.onPayload;
  agent.onPayload = async (payload: unknown, model: { api: string }) => {
    const prepared = await previous?.(payload, model);
    return expandAttachmentPayload(prepared ?? payload, model.api, attachmentDir(userData, scope));
  };
}
