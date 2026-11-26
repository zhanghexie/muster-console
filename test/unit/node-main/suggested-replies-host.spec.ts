import { describe, expect, it, vi } from 'vitest';
import { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } from '../../../src/main/agent/agentScope';
import { suggestedRepliesHost } from '../../../src/main/capabilities/hosts/suggestedReplies';
import type { AppContext } from '../../../src/main/context';
import { currentSuggestedReplies } from '../../../src/renderer/src/chatSurface/currentSuggestedReplies';
import { buildGuiWorkerSystemPrompt } from '../../../src/shared/guiWorkerPrompt';
import { buildCatalogAppendix } from '../../../src/main/agent/systemPrompt';
import { buildHostIntro, buildTaskBriefText } from '../../../src/shared/workerBrief';
import { UI_APP_EXTENSIONS_TOOL_DEFS } from '../../../src/main/capabilities/catalog/uiAppExtensions';

describe('建议回复的宿主身份和会话边界', () => {
  it('GUI 只写入可信调用者，规整去重并限制数量', async () => {
    const setSuggestedReplies = vi.fn(() => true);
    const ctx = { agentSessions: { setSuggestedReplies } } as unknown as AppContext;
    const result = await runAsAgentSession('gui-a', async () =>
      suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: [' 继续 ', '继续', '稍后'] }));
    expect(result.count).toBe(2);
    expect(setSuggestedReplies).toHaveBeenCalledWith('gui-a', ['继续', '稍后']);
  });

  it('CLI 建议只投递给可信调用者自己的会话', async () => {
    const setSuggestedReplies = vi.fn(() => false);
    const setCliSuggestedReplies = vi.fn(() => true);
    const ctx = { agentSessions: { setSuggestedReplies }, sessions: { setCliSuggestedReplies } } as unknown as AppContext;
    await runAsAgentSession('cli-a', async () => suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: [' 继续 ', '继续', '稍后'] }));
    expect(setCliSuggestedReplies).toHaveBeenCalledWith('cli-a', ['继续', '稍后']);
    setCliSuggestedReplies.mockReturnValue(false);
    await expect(runAsAgentSession('cli-b', async () => suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: ['继续'] }))).rejects.toThrow();
    expect(setCliSuggestedReplies).toHaveBeenLastCalledWith('cli-b', ['继续']);
  });

  it('调度只写入回合绑定的工作区，未绑定或过期会话会失败', async () => {
    const setSuggestedReplies = vi.fn(() => true);
    const ctx = { orchestrator: { setSuggestedReplies } } as unknown as AppContext;
    await runAsAgentWorkspace('ws-a', () => runAsSchedulerTool(async () =>
      suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: ['继续'] })));
    expect(setSuggestedReplies).toHaveBeenCalledWith('ws-a', ['继续']);
    expect(() => suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: ['继续'] })).toThrow();
    setSuggestedReplies.mockReturnValue(false);
    await expect(runAsAgentWorkspace('ws-a', () => runAsSchedulerTool(async () =>
      suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: ['继续'] })))).rejects.toThrow();
  });

  it('拒绝空列表、过多或无效文本，不触碰宿主', async () => {
    const setSuggestedReplies = vi.fn(() => true);
    const ctx = { agentSessions: { setSuggestedReplies } } as unknown as AppContext;
    for (const replies of [[], [' ', ''], ['一', '二', '三', '四'], [1]]) {
      await expect(runAsAgentSession('gui-a', async () =>
        suggestedRepliesHost['ui.suggestReplies'](ctx, { replies }))).rejects.toThrow();
    }
    expect(setSuggestedReplies).not.toHaveBeenCalled();
  });

  it('按 UTF-16 单位限制单条建议，包含代理对边界', async () => {
    const setSuggestedReplies = vi.fn(() => true);
    const ctx = { agentSessions: { setSuggestedReplies } } as unknown as AppContext;
    const atLimit = '😀'.repeat(150);
    await runAsAgentSession('gui-a', async () => suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: [atLimit] }));
    expect(setSuggestedReplies).toHaveBeenCalledWith('gui-a', [atLimit]);
    await expect(runAsAgentSession('gui-a', async () => suggestedRepliesHost['ui.suggestReplies'](ctx, { replies: [atLimit + 'a'] }))).rejects.toThrow();
  });
});

it('Worker 首条输入保留建议回复调用时机，调度和工具定义提供完整规则', () => {
  const prompt = buildGuiWorkerSystemPrompt({
    cwd: '/work', mode: 'default', tools: [{ id: 'host.ui.suggestReplies' }],
    hostToolNamePrefix: 'mcp__muster__'
  });
  expect(prompt).toContain('Before sending each final reply to the user, call mcp__muster__host_ui_suggestReplies exactly once.');
  for (const text of [buildHostIntro(), buildTaskBriefText('test')]) {
    expect(text).toContain('If available, call host_ui_suggestReplies once before a user-facing reply.');
    expect(text).not.toContain('300 UTF-16 code units');
  }
  const description = UI_APP_EXTENSIONS_TOOL_DEFS.find(tool => tool.name === 'ui.suggestReplies')!.description;
  for (const text of [buildCatalogAppendix(), description]) {
    expect(text).toContain('natural and complete');
    expect(text).toContain('rather than filling all three slots');
    expect(text).toContain('300 UTF-16 code units');
    expect(text).toContain('never send or act on them yourself');
  }
});

it('Ask 提示词只引用实际提供的工具', () => {
  const prompt = buildGuiWorkerSystemPrompt({
    cwd: '/work', mode: 'ask', tools: [{ id: 'host.ui.suggestReplies' }]
  });
  expect(prompt).toContain('host_ui_suggestReplies');
  expect(prompt).not.toContain('host_sessions_setStatus');
  expect(buildGuiWorkerSystemPrompt({ mode: 'ask', tools: [] })).not.toContain('host_ui_suggestReplies');
});
