/**
 * GUI Worker 的 catalog 背书宿主工具（状态四件套 / 会话创建与留言 / 观察 / 状态共享 /
 * 记忆检索 / 内置浏览器）：schema 与 description 取自 catalog，执行走进程内 executeTool，
 * 与 CLI Worker 的 Shell API /v1/tool 等价。
 * 身份绑定统一经 bindWorkerToolArgs（规则表在 shared/hostTools meta 的 bind 字段），
 * 权限档取 meta 的 permissionClass；本文件不按工具名分叉绑定规则。
 * 工具权限由原执行器及宿主可信身份边界判定。
 */
import type { AppContext } from '../../context';
import { executeTool, serializeModelToolResult } from '../../capabilities/executor';
import { getToolDef } from '../../capabilities/catalog';
import { bindWorkerToolArgs } from '../../capabilities/workerBinding';
import { expandRunToolCall } from '../../capabilities/runRouter';
import { runToolDomainOf } from '../../capabilities/catalog/runTools';
import { recordBrowserToolUse } from '../../browser/turnShotCapture';
import { t } from '../../../shared/i18n';
import type { GuiHostTool } from '../types';
import { hostToolPermissionClass } from '../../../shared/hostTools';
import { residentHostToolIds } from '../../../shared/toolDiscovery';
import { migrateHostToolName } from '../../../shared/hostToolNames';

/**
 * 注册顺序即政策层目录顺序（R4 按常驻终态清单 §2.1 家族序重排）：
 * 会话通信 → 会话状态 → 观察与事件 → 记忆 → 智能界面 → 状态共享 → 浏览器 run 入口 → MCP 中转。
 * bgtasks/node_repl 由 registry.ts 追加（后台任务在持久执行之前）。
 */
// These two resident entries were not in the legacy GUI projection. Keep that
// exact visibility during migration; expanding GUI authority is a separate
// product decision. Background and REPL handlers are assembled separately.
const GUI_CATALOG_EXCLUSIONS = new Set([
  'terminal.create', 'intent', 'bgtasks.shell', 'bgtasks.wait', 'bgtasks.list', 'bgtasks.kill', 'node_repl.js'
]);
export const CATALOG_HOST_TOOL_IDS: readonly string[] = residentHostToolIds('worker')
  .filter((id) => !GUI_CATALOG_EXCLUSIONS.has(id));

function catalogHostTool(ctx: AppContext, dotName: string): GuiHostTool {
  const def = getToolDef(dotName);
  if (!def) throw new Error(t('catalog 缺少工具定义: {{name}}', { name: dotName }));
  return {
    id: dotName,
    label: dotName,
    description: def.description,
    parameters: def.parameters as Record<string, unknown>,
    permissionClass: hostToolPermissionClass(dotName) ?? 'read',
    resultFormat: 'execute-result-json',
    async execute(args, exec) {
      // R2 run 入口（browser.run…）：先展开真实目标，身份绑定/执行/证据/统计都按
      // 真实目标走（与直调同名工具完全同路径）。
      const route = runToolDomainOf(dotName)
        ? expandRunToolCall(dotName, args, { ctx, sessionId: exec.sessionId })
        : null;
      const targetName = route?.targetTool ?? dotName;
      const bound = route ? route.args : bindWorkerToolArgs(ctx, dotName, args, exec.sessionId);
      // A run domain may contain an action with the same name as its entry.
      // Give the executor the validated envelope in that case so it expands
      // exactly once instead of interpreting target arguments as an envelope.
      const selfParams = { ...bound };
      delete selfParams.__actorSessionId;
      const executorArgs = route && targetName === dotName ? { ...args, params: selfParams } : bound;
      const result = await executeTool(ctx, targetName, JSON.stringify(executorArgs), {
        signal: exec.signal,
        // 会话作用域：asSubagent 等宿主自判场景据此取「父是谁」
        callingSessionId: exec.sessionId
      });
      // 回合截图证据（任务 D）：browser.* 成功即记本回合实际用过的 tab（收口时采集）
      recordBrowserToolUse(exec.sessionId, targetName, bound, result);
      // 证据归集（T4.4）：browser 截图副本进调用方会话的证据链（默认关，开关在收集器内判）
      if (targetName === 'browser.screenshot' && result.ok) {
        const previewPath = (result.result as { previewPath?: unknown } | null)?.previewPath;
        if (typeof previewPath === 'string' && previewPath) {
          ctx.evidence?.recordBrowserShot(exec.sessionId, previewPath);
        }
      }
      return serializeModelToolResult(result, migrateHostToolName(dotName).name, args);
    }
  };
}

export function buildCatalogHostTools(ctx: AppContext): GuiHostTool[] {
  return CATALOG_HOST_TOOL_IDS.map((id) => catalogHostTool(ctx, id));
}
