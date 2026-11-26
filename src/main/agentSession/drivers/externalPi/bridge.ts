/** This file is written to a connection-owned temporary directory at launch. */
export const EXTERNAL_PI_BRIDGE_SOURCE = String.raw`
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
export default async function (api) {
  const raw = process.env.MUSTER_EXTERNAL_PI_BRIDGE;
  delete process.env.MUSTER_EXTERNAL_PI_BRIDGE;
  if (!raw) throw new Error('muster external Pi bridge configuration is missing');
  const config = JSON.parse(readFileSync(raw, 'utf8'));
  unlinkSync(raw);
  const names = new Set();
  for (const tool of config.tools || []) {
    if (!tool || typeof tool.name !== 'string' || names.has(tool.name)) throw new Error('Invalid or duplicate muster tool');
    names.add(tool.name);
    api.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      loadMode: 'essential',
      async execute(_id, args, signal) {
        const response = await fetch(config.url, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: config.token, name: tool.name, arguments: args })
        });
        if (!response.ok) throw new Error('muster 宿主工具连接失败');
        const result = await response.json();
        if (result.isError) throw new Error(String(result.text || '宿主工具调用失败'));
        return { content: [{ type: 'text', text: String(result.text || '') }], details: {} };
      }
    });
  }
  api.on('before_agent_start', (_event, ctx) => {
    ctx.ui.setStatus('muster-turn-bridge', 'ready');
  });
  if (config.captureForkPoints) {
    let pendingForkInput;
    const digest = value => createHash('sha256').update(value).digest('hex');
    api.on('input', (event, ctx) => {
      pendingForkInput = event.source === 'rpc' && typeof event.text === 'string'
        ? { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(), hash: digest(event.text) }
        : undefined;
    });
    const emitForkPoints = (event, ctx) => {
      const pending = pendingForkInput;
      if (config.captureForkPoints === 'pi') pendingForkInput = undefined;
      if (!pending || event.aborted || pending.sessionId !== ctx.sessionManager.getSessionId()) return;
      // A stop hook can be followed by an extension-requested continuation.
      // Clear the earlier candidate before evaluating the newest branch.
      ctx.ui.setStatus('muster-fork-points', JSON.stringify({ sessionId: pending.sessionId, hash: pending.hash }));
      const branch = ctx.sessionManager.getBranch();
      const start = pending.leafId == null ? -1 : branch.findIndex(entry => entry.id === pending.leafId);
      if (pending.leafId != null && start < 0) return;
      const messages = branch.slice(start + 1).filter(entry => entry.type === 'message');
      const users = messages.filter(entry => entry.message?.role === 'user');
      const assistants = messages.filter(entry => entry.message?.role === 'assistant');
      if (users.length !== 1 || !assistants.length || messages[messages.length - 1] !== assistants[assistants.length - 1]) return;
      const content = users[0].message.content;
      const userText = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('') : '';
      if (digest(userText) !== pending.hash) return;
      ctx.ui.setStatus('muster-fork-points', JSON.stringify({ sessionId: pending.sessionId, hash: pending.hash,
        userEntryId: users[0].id, assistantEntryId: assistants[assistants.length - 1].id }));
    };
    api.on(config.captureForkPoints === 'omp' ? 'session_stop' : 'agent_settled', emitForkPoints);
  }
  api.on('session_start', (_event, ctx) => ctx.ui.setStatus('muster-external-bridge', 'ready'));
}
`;
