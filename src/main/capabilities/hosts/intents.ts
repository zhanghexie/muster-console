/**
 * intent 工具（standing intents，memory-refactor §9，B7）：创建/列出/取消前瞻意图。
 * 身份门：**调度调用链或带会话身份的 Worker**（2026-10-23 开放 Worker，用户拍板；
 * meta 层 GUI+PTY preset 控制可见面，此处 handler 检查是第二道兜底——匿名调用拒）。
 * 核心逻辑在 memory/intentTool.ts（node-only，.mjs 可直测）：创建须本回合用户证据
 * （turnScope 守卫，host/bg/无头回合一律拒建，与调用者身份无关）；纯时间型意图拒绝
 * 并指路现有定时任务。
 */
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import { isSchedulerInvocation, currentAgentSessionId } from '../../agent/agentScope';
import { controlRootFor, requireWorkspace } from '../../workspacePaths';
import { getMemoryService } from '../../memory/runtime';
import { runIntentTool, type IntentToolArgs } from '../../memory/intentTool';

export const intentsHost = {
  intent: (ctx: AppContext, args: { workspaceId?: string } & Record<string, unknown>) => {
    if (!isSchedulerInvocation() && !currentAgentSessionId()) {
      throw new Error(t('该工具需要调度或 Worker 会话身份（前瞻意图随会话触发）'));
    }
    const svc = getMemoryService();
    if (!svc) throw new Error(t('记忆服务尚未就绪'));
    const root = controlRootFor(requireWorkspace(ctx.config.get(), args?.workspaceId));
    return runIntentTool(svc.init(root), (args ?? {}) as IntentToolArgs);
  }
};
