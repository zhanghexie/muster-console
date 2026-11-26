import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/main/memory/runtime', () => ({ getMemoryService: () => null, resolveMemoryWorkspaceRoot: () => null }));
import { send } from '../../../src/main/agent/orchestrator/sendPipeline';
import { requestUserQuestion } from '../../../src/main/agent/orchestrator/askQuestions';
import type { OrchestratorHost } from '../../../src/main/agent/orchestrator/internal';
import type { ChatMessage } from '../../../src/shared/types';
import { MAX_AGENT_QUEUE } from '../../../src/main/agent/orchestrator/types';

function setup() {
  const assistant: ChatMessage = { id: 'a1', role: 'assistant', content: '', createdAt: 1 };
  const bucket = { busy: true, display: [assistant], queue: [] as unknown[] };
  const host = {
    ctx: { ui: { setBubble: vi.fn() }, notify: { push: vi.fn() } },
    ensureBucket: () => bucket, buckets: new Map([['ws', bucket]]), pendingAsks: new Map(),
    emit: vi.fn(), persistBucket: vi.fn(), maybeIdleMicrocompact: vi.fn(async () => {}),
    checkSendImages: vi.fn(() => ({ ok: true })),
  } as unknown as OrchestratorHost;
  const outcome = requestUserQuestion(host, { questions: [{ id: 'q', question: '选择？', options: [{ label: 'A' }] }] }, 'ws');
  return { host, bucket, assistant, outcome };
}

describe('普通消息结算提问，不吞原文、不悬挂工具', () => {
  it.each([undefined, [{ id: 'img', data: 'YQ==', mimeType: 'image/png' }]])('成功入队后解除等待，保留消息与附件 %s', async images => {
    const { host, bucket, assistant, outcome } = setup();
    await send(host, '改为检查日志', 'ws', images);
    expect(await outcome).toEqual({ kind: 'aborted', reason: 'superseded' });
    expect(host.pendingAsks.size).toBe(0);
    expect(assistant.userQuestion).toMatchObject({ status: 'aborted', abortReason: 'superseded' });
    expect(assistant.userQuestion?.answers).toBeUndefined();
    expect(bucket.queue).toEqual([expect.objectContaining({ text: '改为检查日志', images })]);
    expect(host.emit).toHaveBeenCalledWith('agent:message', expect.objectContaining({ userQuestion: expect.objectContaining({ abortReason: 'superseded' }) }));
  });
  it('宿主通知不取代用户问题', async () => {
    const { host, assistant } = setup();
    await send(host, '收到邮件', 'ws', undefined, { host: true });
    expect(host.pendingAsks.size).toBe(1);
    expect(assistant.userQuestion?.status).toBe('pending');
  });
  it('队列满而拒收时保留提问', async () => {
    const { host, bucket, assistant } = setup();
    bucket.queue = Array.from({ length: MAX_AGENT_QUEUE }, () => ({}));
    await send(host, '新指令', 'ws');
    expect(host.pendingAsks.size).toBe(1);
    expect(assistant.userQuestion?.status).toBe('pending');
  });
});
