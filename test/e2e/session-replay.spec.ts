import http from 'node:http';
import { once } from 'node:events';
import { test, expect } from './fixtures/electron';
import type { SessionReplayHandle, SessionReplayMaterial } from '../../src/shared/sessionReplay';

test.use({ isolatedSandbox: true });

test('普通工作台从已有 GUI 会话取材，在另一个会话重拍并还原', async ({ appCtx }, info) => {
  const { win } = appCtx;
  const priorPrompt = '先定片头色调', priorAnswer = '先用暖色，再检查字幕。';
  const prompt = '复核片头素材', answer = '片头素材已经核对，可以开始拍摄。';
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({
      id: 'test-replay', object: 'chat.completion.chunk', model: 'replay-test', choices: [{ index: 0, delta, finish_reason }]
    }) + '\n\n');
    const last = body.messages.at(-1);
    emit({ role: 'assistant' });
    if (last?.role === 'user' && JSON.stringify(last.content).includes(priorPrompt)) {
      emit({ content: priorAnswer }); emit({}, 'stop');
    } else if (last?.role === 'user' && JSON.stringify(last.content).includes(prompt)) {
      emit({ content: '先核对会话。' });
      emit({ tool_calls: [{ index: 0, id: 'observe-take', type: 'function',
        function: { name: 'host_sessions_observe', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ content: answer.slice(0, 5) });
      await new Promise(resolve => setTimeout(resolve, 900));
      emit({ content: answer.slice(5) });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
    const { source, target } = await win.evaluate(async baseUrl => {
      await window.api.config.update({ locale: 'zh-CN', openai: { baseUrl, apiKey: 'fixture', model: 'replay-test' },
        llm: { activeProviderId: 'replay', activeModelId: 'replay-test', providers: [{ id: 'replay', name: 'Fixture',
          enabled: true, api: 'openai-completions', baseUrl, apiKey: 'fixture', models: [{ id: 'replay-test', name: 'Replay' }] }] } });
      const { activeWorkspaceId, workspaces } = await window.api.workspaces.list();
      const rootId = workspaces.find(w => w.id === activeWorkspaceId)?.defaultRootId;
      const scope = { workspaceId: activeWorkspaceId, rootId, runtime: 'pi' };
      const source = await window.api.sessions.create({ ...scope, name: '片头原始会话' });
      const target = await window.api.sessions.create({ ...scope, name: '拍摄视角' });
      await window.api.agentSession.setMode(source.id, 'auto');
      return { source: source.id, target: target.id };
    }, baseUrl);
    expect((await win.evaluate(({ source, priorPrompt }) => window.api.agentSession.send(source, priorPrompt), { source, priorPrompt })).ok).toBe(true);
    await expect.poll(() => win.evaluate(async ({ source, priorAnswer }) => {
      const page = await window.api.agentSession.historyRange(source);
      return !page?.busy && page?.messages.some(m => m.parts.some(p => p.kind === 'text' && p.text === priorAnswer));
    }, { source, priorAnswer })).toBe(true);
    const send = await win.evaluate(({ source, prompt }) => window.api.agentSession.send(source, prompt), { source, prompt });
    expect(send.ok).toBe(true);
    await expect.poll(async () => win.evaluate(async ({ source, answer }) => {
      const page = await window.api.agentSession.historyRange(source);
      return !page?.busy && page?.messages.some(m => m.parts.some(p => p.kind === 'text' && p.text.includes(answer)));
    }, { source, answer }), { timeout: 30_000 }).toBe(true);
    const material = await win.evaluate(source => window.api.agentSession.replayMaterial(source), source);
    expect(material.tracks?.some(track => track.steps.some(step => 'tool' in step))).toBe(true);
    const before = requests;
    const pane = win.locator(`.agent-chat-view.is-shown[data-session-id="${target}"]`);
    async function play(input: string | SessionReplayMaterial) {
      await win.evaluate(async ({ input, target, answer }) => {
        const local = window as Window & { testTake?: SessionReplayHandle; replaySamples?: string[] };
        const samples = local.replaySamples = [] as string[];
        const observer = new MutationObserver(() => {
          const rows = document.querySelectorAll(`.agent-chat-view.is-shown[data-session-id="${target}"] .chat-msg.assistant`);
          for (const row of rows) {
            const text = row.textContent ?? '';
            const prefix = answer.slice(0, 3);
            const position = text.lastIndexOf(prefix);
            if (position >= 0) {
              const seen = text.slice(position, position + answer.length);
              if (samples.at(-1) !== seen && samples.length < 30) samples.push(seen);
            }
          }
        });
        observer.observe(document.body, { subtree: true, characterData: true, childList: true });
        local.testTake = await window.replaySession(input, target, { speed: 1 });
        void local.testTake.finished.finally(() => observer.disconnect());
      }, { input, target, answer });
      await expect(pane.getByText(prompt, { exact: true }).first()).toBeVisible();
      await expect(pane.getByText(answer, { exact: true }).first()).toBeVisible();
      const samples = await win.evaluate(() => (window as Window & { replaySamples?: string[] }).replaySamples);
      expect(samples?.some(text => !text.includes(answer)), JSON.stringify({ samples, steps: material.tracks?.map(t =>
        t.steps.map(s => [s.at - t.steps[0].at, s.partIndex, 'end' in s ? s.end : s.tool.status])) })).toBe(true);
      await expect(pane.locator('.agent-chat-composer-wrap')).toHaveAttribute('inert', '');
    }
    await play(source);
    const toolGroup = pane.getByRole('button', { name: /工具调用/ }).first();
    await toolGroup.click();
    await expect(toolGroup).toHaveAttribute('aria-expanded', 'true');
    await win.screenshot({ path: info.outputPath('真实工作台-会话回放.png') });
    await play(material);
    await expect(pane.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(toolGroup).toHaveAttribute('aria-expanded', 'false');
    await win.evaluate(() => (window as Window & { testTake?: SessionReplayHandle }).testTake!.stop());
    await expect(pane.getByText(prompt, { exact: true })).toHaveCount(0);
    await expect(pane.locator('.agent-chat-composer-wrap')).not.toHaveAttribute('inert', '');
    const saved = await win.evaluate(id => window.api.agentSession.historyRange(id), target);
    expect(saved?.messages).toHaveLength(0);

    const sourcePane = win.locator(`.agent-chat-view.is-shown[data-session-id="${source}"]`);
    await win.evaluate(async ({ source, material, prompt }) => {
      const start = material.messages.findIndex(m => m.role === 'user' && m.parts.some(p => p.kind === 'text' && p.text === prompt));
      if (start < 1) throw new Error('缺少第二轮测试素材');
      const clip = { ...material, messages: material.messages.slice(start) };
      (window as Window & { testTake?: SessionReplayHandle }).testTake = await window.replaySession(clip, source, { speed: 0.5 });
    }, { source, material, prompt });
    await expect(sourcePane.getByText(priorPrompt, { exact: true })).toBeVisible();
    await expect(sourcePane.getByText(priorAnswer, { exact: true })).toBeVisible();
    await expect(sourcePane.getByText(prompt, { exact: true })).toBeVisible();
    await expect(sourcePane.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(sourcePane.getByText(answer, { exact: true })).toBeVisible();
    await expect(sourcePane.locator('.chat-msg.user')).toHaveCount(2);
    await win.screenshot({ path: info.outputPath('回放第二轮-保留上轮问答.png') });
    await win.evaluate(() => (window as Window & { testTake?: SessionReplayHandle }).testTake!.stop());
    await expect(sourcePane.locator('.agent-chat-composer-wrap')).not.toHaveAttribute('inert', '');
    expect(await win.evaluate(id => window.api.agentSession.replayMaterial(id), source)).toEqual(material);
    expect(requests).toBe(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
