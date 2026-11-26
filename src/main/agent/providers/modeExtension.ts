/**
 * 调度 Agent 的 ask / plan 模式（pi 内联扩展）。
 *
 * pi 核心不内置权限弹窗与计划模式，官方通过扩展 API 提供：
 * - `setActiveTools` + `tool_call` 拦截：ask（只读）与 plan（计划）模式都禁用
 *   edit/write，并把 bash 限制为只读白名单；
 * - `before_agent_start`：回合前注入模式提示（plan 要求输出编号计划）；
 * - `agent_end`：从回复中提取「Plan:」步骤 / 追踪 [DONE:n] 执行进度。
 *
 * 状态由 ModeController 持有（每工作区一个，piProvider 注册表管理），
 * orchestrator 通过 controller 与扩展通信（setMode / executePlan / 回调通知）。
 * 执行计划走 orchestrator.send 正常管道（不使用 pi.sendMessage 自触发回合，
 * 保证 UI 消息流、busy 状态与停止按钮行为一致）。
 */

import type { AgentMode, PlanStepView } from '../../../shared/types';
import { isReadOnlyShellCommand } from '../../../shared/guiWorkerPolicy';
import { extractPlan, markCompletedSteps, type ExtractedPlan } from '../../../shared/planExtract';

/** plan 模式直接禁用的工具（ask 同样禁用；bash 保留但走只读白名单） */
const READONLY_DISABLED_TOOLS = new Set(['edit', 'write']);

const PLAN_CONTEXT = `[PLAN MODE ACTIVE]
你正处于计划模式——只读探索，用于安全地分析代码。
限制：
- 内置 edit / write 工具已禁用
- bash 仅允许只读命令（查看/搜索类）
请先探索代码，然后输出一份带编号的详细计划，格式：
Plan:
1. 第一步……
2. 第二步……
不要尝试做任何修改，只描述你将怎么做。如需澄清可以提问。
用户可能对计划提出修改意见：收到反馈后输出修订后的完整计划（同格式，不要只回差异）。`;

const ASK_CONTEXT = `[READ-ONLY MODE]
用户开启了只读模式：你不允许修改任何东西。
- 内置 edit / write 工具已禁用
- bash 仅允许只读命令（查看/搜索类）
请只做阅读、搜索、分析类工作；如需修改，先向用户说明并获得同意（用户会切换模式后再执行）。`;

/** pi 扩展 API 的最小结构（与 piProvider 的 PiApi 同风格：宽松类型） */
interface ModeExtApi {
  on: (event: string, handler: (event: never, ctx?: unknown) => unknown) => void;
  getActiveTools: () => string[];
  setActiveTools: (names: string[]) => void;
}

type ToolCallEvent = { toolName?: string; toolCallId?: string; input?: Record<string, unknown> };
type BeforeAgentStartResult = {
  message?: { customType?: string; content: string; display?: boolean };
};
type AgentEndEvent = { messages?: Array<{ role?: string; content?: unknown }> };

function assistantText(messages: AgentEndEvent['messages']): string {
  if (!messages) return '';
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const c = m.content;
    if (typeof c === 'string') parts.unshift(c);
    else if (Array.isArray(c)) {
      parts.unshift(
        c
          .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
          .join('\n')
      );
    }
    // 只取最后一条 assistant
    break;
  }
  return parts.join('\n');
}

export class ModeController {
  mode: AgentMode;
  planSteps: PlanStepView[] = [];
  executing = false;
  /** 由扩展 factory 注入：切换工具集 */
  applyTools: (() => void) | null = null;
  /** 计划提取 / 进度更新 / 全部完成回调（orchestrator 更新计划卡消息） */
  onPlanExtracted: ((plan: ExtractedPlan) => void) | null = null;
  onPlanUpdated: ((steps: PlanStepView[]) => void) | null = null;
  onPlanCompleted: (() => void) | null = null;

  constructor(initial: AgentMode = 'default') {
    this.mode = initial;
  }

  setMode(mode: AgentMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // 离开 plan 时清掉旧计划状态
    if (mode !== 'plan') {
      this.planSteps = [];
      this.executing = false;
    }
    this.applyTools?.();
  }

  /** 开始执行计划：置 executing、恢复工具集，返回执行 prompt（走 orchestrator.send） */
  executePlan(): string | null {
    if (this.mode !== 'plan' || this.executing || this.planSteps.length === 0) return null;
    this.executing = true;
    this.applyTools?.();
    const remaining = this.planSteps
      .filter((s) => !s.completed)
      .map((s) => `${s.step}. ${s.text}`)
      .join('\n');
    return `执行以下计划：

${remaining}

按顺序执行每一步。每完成一步，在回复中包含 [DONE:${this.planSteps[0].step}] 样式的标记（数字为步骤号）。`;
  }

  abandonPlan(): void {
    this.planSteps = [];
    this.executing = false;
    this.applyTools?.();
  }
}

/** 每 wsId 一个 controller；session 重建时由 piProvider 更新 */
const controllers = new Map<string, ModeController>();

export function getModeController(wsId?: string): ModeController | undefined {
  return wsId ? controllers.get(wsId) : undefined;
}

export function ensureModeController(wsId: string | undefined, initial: AgentMode): ModeController {
  const key = wsId || 'default';
  let c = controllers.get(key);
  if (!c) {
    c = new ModeController(initial);
    controllers.set(key, c);
  }
  // 已有 controller 的模式同步由 orchestrator.bindModeController 负责（需触发 applyTools）
  return c;
}

/** 创建 mode 扩展 factory（加入 DefaultResourceLoader.extensionFactories） */
export function createModeExtensionFactory(
  controller: ModeController
): (api: ModeExtApi) => void {
  return (api) => {
    let toolsBeforeReadonly: string[] | undefined;

    /** ask / plan（非执行态）都进入只读工具集：禁 edit/write */
    const readonlyActive = (): boolean =>
      controller.mode === 'ask' || (controller.mode === 'plan' && !controller.executing);

    const applyTools = (): void => {
      if (readonlyActive()) {
        if (toolsBeforeReadonly === undefined) {
          toolsBeforeReadonly = api.getActiveTools();
        }
        api.setActiveTools(
          toolsBeforeReadonly.filter((name) => !READONLY_DISABLED_TOOLS.has(name))
        );
      } else if (toolsBeforeReadonly !== undefined) {
        api.setActiveTools(toolsBeforeReadonly);
        toolsBeforeReadonly = undefined;
      }
    };
    controller.applyTools = applyTools;

    // 会话建立/恢复时若已在只读类模式（ask/plan），立即收掉写工具
    api.on('session_start', () => {
      if (readonlyActive()) applyTools();
    });

    // 只读类模式：bash 仅放行只读白名单（powershell 同判——无 Git Bash 时 driver 会
    // 把 bash 换成 pi 自带 powershell，只判 bash 该门控会整体失效，M-2）
    api.on('tool_call', async (raw: never) => {
      const event = raw as ToolCallEvent;
      const tool = String(event.toolName ?? '');
      if (readonlyActive() && (tool === 'bash' || tool === 'powershell')) {
        const command = String(event.input?.command ?? '');
        if (!isReadOnlyShellCommand(command)) {
          return {
            block: true,
            reason: `当前为${controller.mode === 'ask' ? '只读' : '计划'}模式，仅允许只读命令（被拒：${command.slice(0, 120)}）。如需修改请先经用户切换模式/批准执行。`
          };
        }
      }
      return;
    });

    // 回合前注入模式上下文
    api.on('before_agent_start', (raw: never) => {
      // pi>=1.2：idle 的 sendCustomMessage({triggerTurn:true}) 触发的 run（memory 回执/安全审查）
      // 也走本钩子；此类结构化 run 不注入模式上下文，维持旧版注入面
      const startEvent = raw as { messageType?: 'user' | 'custom' };
      if (startEvent.messageType === 'custom') return undefined;
      if (controller.mode === 'plan' && !controller.executing) {
        const result: BeforeAgentStartResult = {
          message: { customType: 'agent-mode-context', content: PLAN_CONTEXT, display: false }
        };
        return result;
      }
      if (controller.mode === 'ask') {
        const result: BeforeAgentStartResult = {
          message: { customType: 'agent-mode-context', content: ASK_CONTEXT, display: false }
        };
        return result;
      }
      if (controller.mode === 'plan' && controller.executing && controller.planSteps.length > 0) {
        const remaining = controller.planSteps
          .filter((s) => !s.completed)
          .map((s) => `${s.step}. ${s.text}`)
          .join('\n');
        const result: BeforeAgentStartResult = {
          message: {
            customType: 'agent-mode-context',
            content: `[EXECUTING PLAN - 已授权完整工具]\n剩余步骤：\n${remaining}\n按顺序执行，完成后用 [DONE:n] 标记。`,
            display: false
          }
        };
        return result;
      }
      return;
    });

    // 回合结束：提取计划 / 追踪进度
    api.on('agent_end', (raw: never) => {
      const event = raw as AgentEndEvent;
      const text = assistantText(event.messages);
      if (controller.mode === 'plan' && !controller.executing) {
        const extracted = extractPlan(text);
        if (extracted) {
          controller.planSteps = extracted.steps;
          controller.onPlanExtracted?.(extracted);
        }
        return;
      }
      if (controller.executing && controller.planSteps.length > 0) {
        if (markCompletedSteps(text, controller.planSteps)) {
          controller.onPlanUpdated?.(controller.planSteps);
        }
        if (controller.planSteps.every((s) => s.completed)) {
          controller.executing = false;
          controller.onPlanCompleted?.();
        }
      }
    });
  };
}
