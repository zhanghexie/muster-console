import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { TurnChangeTracker } from '../../../turnChanges/service';
import { nativeWritePaths } from '../../../turnChanges/pathCapture';

type Pending = { tracker: TurnChangeTracker; turn: string };

/** SDK hooks are awaited by Claude before/after the tool; stream events remain observations. */
export function createClaudeReviewHooks(options: {
  tracker: () => TurnChangeTracker | undefined | Promise<TurnChangeTracker | undefined>;
  turnId: () => string | undefined;
  isCurrent: () => boolean;
  log: (message: string) => void;
}): NonNullable<Options['hooks']> {
  const pending = new Map<string, Pending>();
  const pre: HookCallback = async (event, callId, { signal }) => {
    if (event.hook_event_name !== 'PreToolUse') return {};
    const id = event.tool_use_id || callId || '';
    const input = event.tool_input && typeof event.tool_input === 'object' && !Array.isArray(event.tool_input)
      ? event.tool_input as Record<string, unknown> : {};
    if (!id || !nativeWritePaths(event.tool_name, input).length || !options.isCurrent() || signal.aborted) return {};
    const turn = options.turnId();
    for (const [pendingId, value] of pending) {
      if (value.turn !== turn) pending.delete(pendingId);
    }
    if (!pending.has(id) && pending.size >= 512) {
      options.log('Claude 文件审阅并发工具数量超过上限，部分改动可能未记录'); return {};
    }
    let tracker: TurnChangeTracker | undefined;
    try { tracker = await options.tracker(); }
    catch (error) { options.log(`Claude 文件审阅写前采集不可用：${(error as Error).message}`); return {}; }
    if (!turn || !tracker || signal.aborted || !options.isCurrent() || options.turnId() !== turn) {
      options.log('Claude 文件审阅写前采集不可用'); return {};
    }
    const current = { tracker, turn }; pending.set(id, current);
    const abandon = () => {
      if (pending.get(id) === current) pending.delete(id);
      void tracker.toolEnd(id, false, undefined, true);
    };
    signal.addEventListener('abort', abandon, { once: true });
    try {
      await tracker.toolStart(id, event.tool_name, input, undefined, true);
      if (signal.aborted || !options.isCurrent() || options.turnId() !== turn) abandon();
    } catch (error) { abandon(); options.log(`Claude 文件审阅写前采集失败：${(error as Error).message}`); }
    finally { signal.removeEventListener('abort', abandon); }
    return {};
  };
  const post: HookCallback = async (event, callId) => {
    if (event.hook_event_name !== 'PostToolUse' && event.hook_event_name !== 'PostToolUseFailure') return {};
    const id = event.tool_use_id || callId || '', current = pending.get(id);
    if (!current) return {};
    pending.delete(id);
    const ok = event.hook_event_name === 'PostToolUse' && options.isCurrent() && options.turnId() === current.turn;
    try { await current.tracker.toolEnd(id, ok, undefined, true); }
    catch (error) { options.log(`Claude 文件审阅写后采集失败：${(error as Error).message}`); }
    return {};
  };
  return { PreToolUse: [{ hooks: [pre] }], PostToolUse: [{ hooks: [post] }], PostToolUseFailure: [{ hooks: [post] }] };
}
