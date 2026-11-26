/** 真 Electron/preload/调度工具等待链；mock LLM 只负责可重复发起 askQuestion。 */
import { test as base, expect } from './fixtures/electron';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// 独立动态端口，避免复用其他测试的 mock 服务或子进程退出竞态。
const test = base.extend<{}, { questionPort: number }>({
  questionPort: [async ({}, use) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const messages = JSON.parse(body).messages ?? [];
        const last = messages.at(-1) ?? {};
        const text = typeof last.content === 'string' ? last.content : (last.content ?? []).map((b: any) => b.text ?? '').join('');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
        if (last.role === 'user' && text.includes('tool:askQuestion')) {
          emit({ tool_calls: [{ index: 0, id: 'question', type: 'function', function: { name: 'askQuestion', arguments: JSON.stringify({ questions: [{ id: 'which', question: '选择方案？', options: [{ label: '方案A' }, { label: '方案B' }] }] }) } }] });
          emit({}, 'tool_calls');
        } else {
          emit({ content: last.role === 'tool' ? '【mock】提问已结算' : '【mock】收到：' + text });
          emit({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await use((server.address() as AddressInfo).port); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, { scope: 'worker' }]
});

test('普通消息保留原文并解除挂起提问，后续回合能完成', async ({ appCtx, questionPort }) => {
  const { win } = appCtx;
  await win.evaluate(async baseUrl => {
    const api = (window as any).api;
    await api.config.update({
      openai: { baseUrl, apiKey: 'mock-key', model: 'mock' },
      llm: { activeProviderId: 'question-fixture', activeModelId: 'mock', providers: [{
        id: 'question-fixture', name: 'Question fixture', enabled: true, api: 'openai-completions',
        baseUrl, apiKey: 'mock-key', models: [{ id: 'mock', name: 'Mock' }]
      }] }
    });
    await api.chat.clear();
    await api.chat.send('tool:askQuestion ' + JSON.stringify({ questions: [{ id: 'which', question: '选择方案？', options: [{ label: '方案A' }, { label: '方案B' }] }] }));
  }, `http://127.0.0.1:${questionPort}/v1`);
  const history = () => win.evaluate(() => (window as any).api.chat.historyRange().then((page: { messages: unknown[] }) => page.messages));
  await expect.poll(async () => {
    const messages = await history();
    const failed = messages.find((m: any) => m.error);
    if (failed) throw new Error(JSON.stringify(failed));
    return messages.some((m: any) => m.userQuestion?.status === 'pending') ? 'pending' : JSON.stringify(messages);
  }, { timeout: 15000 }).toBe('pending');
  const text = '- [会话批注] 原文：“方案A”；用户批注：先检查日志';
  expect(await win.evaluate(t => (window as any).api.chat.send(t), text)).toMatchObject({ accepted: true });
  await expect.poll(async () => (await history()).some((m: any) => m.userQuestion?.abortReason === 'superseded'), { timeout: 10000 }).toBe(true);
  await expect.poll(async () => {
    const messages = await history();
    const user = messages.findIndex((m: any) => m.role === 'user' && m.content === text && !m.queued);
    return user >= 0 && messages.slice(user + 1).some((m: any) => m.role === 'assistant' && m.content?.includes('【mock】收到'));
  }, { timeout: 30000 }).toBe(true);
  const card = (await history()).find((m: any) => m.userQuestion?.abortReason === 'superseded').userQuestion;
  expect(card.status).toBe('aborted');
  expect(card.answers).toBeUndefined();
});
