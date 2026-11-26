/**
 * run 入口执行路由（R2 browser 域试点，plan §3 R2）：把 `X.run({action, params})`
 * 调用展开为真实 catalog 目标（browser.run → browser.click…），身份绑定以**真实
 * 目标名**走 bindWorkerToolArgs（browser.* 目标由此拿到 __browserOwner，
 * actor/self 目标拿到会话身份），再交回调用方按原名执行原 handler。
 * 权限决策表的按目标展开在 agentSession/tools/policy.ts（先展开后决策；R5 起与
 * executor 内的 run 展开同一路径口径，发现层代理已退役）。
 */
import { resolveRunToolCall } from './catalog/runFactory';
import { runToolDomainOf } from './catalog/runTools';
import { bindWorkerToolArgs } from './workerBinding';
import { ACTOR_SESSION_ID_ARG } from './hosts/actors';

export interface RunToolRoute {
  action: string;
  /** 展开出的真实 catalog 工具 id（如 browser.click） */
  targetTool: string;
  /** 绑定身份后的目标参数（浅拷贝，不改调用方对象） */
  args: Record<string, unknown>;
}

/** 匿名（无令牌/无会话）调用：剥掉模型伪造的身份字段，不落入宿主特权 */
export function stripForgedIdentity(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  delete out[ACTOR_SESSION_ID_ARG];
  delete out.__browserOwner;
  return out;
}

/**
 * 展开一次 run 调用（只解析与绑定，不执行）：
 * - identity 给出已认证会话：bindWorkerToolArgs 以真实目标名绑定；
 * - 无身份：剥掉伪造身份（与 shellApi 匿名分支同语义）。
 * 未知 action / params 校验失败抛可纠正的英文错误（runFactory resolveRunToolCall）。
 * 只传 identity.sessionId 而省略绑定（先解析后统一绑定）时传 undefined。
 */
export function expandRunToolCall(
  runName: string,
  rawArgs: Record<string, unknown>,
  identity?: { ctx: Parameters<typeof bindWorkerToolArgs>[0]; sessionId: string }
): RunToolRoute {
  const domain = runToolDomainOf(runName);
  if (!domain) throw new Error(`${runName} is not a run tool entry.`);
  const resolved = resolveRunToolCall(domain, rawArgs);
  const args = identity
    ? bindWorkerToolArgs(identity.ctx, resolved.targetTool, resolved.args, identity.sessionId)
    : stripForgedIdentity(resolved.args);
  return { action: resolved.action, targetTool: resolved.targetTool, args };
}
