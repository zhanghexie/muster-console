/**
 * GUI Worker 后台任务工具：bgtasks.shell（后台终端）/ .wait（定时唤醒）/ .list / .kill。
 * 真正执行在 BackgroundTaskManager；这里只做参数校验与结果文案。
 * C1：shell 支持 timeoutMs 超时自动转后台（返回 foreground|backgrounded 判别联合）；
 * kill 支持 initiator 标记谁终止（model|user）。
 *
 * 子代理（bgtasks.spawn）已于 2026-10-20 移除：子代理不再是「会话内后门」，
 * 而是带 `parentSessionId` 的普通 worker 会话，由 delegate/sessions.create 拉活
 * （见 docs/plans/subagent-generalization-plan.md）。shell/wait/list/kill 与子代理
 * 无关，保留。
 * 权限类：list='read'、shell='shell'（与 bash 同审批/只读白名单语义）、wait/kill='status'。
 */
import type { AppContext } from '../../context';
import type { BackgroundTaskManager } from '../background/manager';
import type { GuiHostTool, GuiToolExecContext } from '../types';
import {
  BG_TIMER_MAX_MS,
  BG_SHELL_TIMEOUT_MS_CAP,
  formatShellRunResult,
  parseBgWakeOn,
  parseTimerDelayMs,
  type BgKillInitiator
} from '../../../shared/backgroundTasks';
import { BG_TOOL_IDS, getHostToolMeta } from '../../../shared/hostTools';

export { BG_TOOL_IDS };

function specParams(id: string): Record<string, unknown> {
  const schema = getHostToolMeta(id)?.schema;
  return (schema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
}

function managerOf(ctx: AppContext): BackgroundTaskManager {
  if (!ctx.bgTasks) throw new Error('后台任务宿主未就绪');
  return ctx.bgTasks;
}

function shortLabel(s: string | undefined, fallback: string): string {
  const t = (s ?? '').trim();
  return t || fallback;
}

export function buildBgTaskTools(ctx: AppContext): GuiHostTool[] {
  const tools: GuiHostTool[] = [
    {
      id: 'bgtasks.shell',
      label: '后台执行命令',
      description:
        '在后台终端跑一条命令（独立 PTY，支持 dev server 等长驻进程）。不传 timeoutMs 时立即返回不阻塞当前回合。传 timeoutMs 则等待命令完成或超时：超时前跑完返回 foreground（含输出摘要与 outputPath），超时自动转后台返回 backgrounded（sleep 命令超时判失败）。完成后默认静默。wake=true 仅在成功时唤醒；失败默认静默，需跟进时传 wakeOn=fail 或 always。',
      argsHint: getHostToolMeta('bgtasks.shell')?.argsHint,
      parameters: specParams('bgtasks.shell'),
      permissionClass: getHostToolMeta('bgtasks.shell')?.permissionClass ?? 'shell',
      async execute(args, exec: GuiToolExecContext) {
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('失败：command 不能为空');
        // 等待窗口上限 10 分钟：无上限会让一条工具调用阻塞回合近乎无限并占住并发槽
        const timeoutMs =
          typeof args.timeoutMs === 'number' && args.timeoutMs > 0
            ? Math.min(Math.floor(args.timeoutMs), BG_SHELL_TIMEOUT_MS_CAP)
            : undefined;
        const name = shortLabel(args.name as string | undefined, command);
        const wake = args.wake === true;
        const wakeOn = parseBgWakeOn(args.wakeOn);

        if (timeoutMs !== undefined) {
          const r = await managerOf(ctx).runShellWithTimeout(
            exec.sessionId,
            exec.cwd,
            command,
            name,
            wake,
            wakeOn,
            timeoutMs
          );
          if ('ok' in r && !r.ok) throw new Error(`启动失败：${r.error}`);
          return formatShellRunResult(r as Parameters<typeof formatShellRunResult>[0]);
        }

        const r = managerOf(ctx).spawnShell(exec.sessionId, exec.cwd, command, name, wake, wakeOn);
        if (!r.ok) throw new Error(`启动失败：${r.error}`);
        return `后台命令已启动（${r.id}），唤醒策略：${wake ? (wakeOn ?? 'success') : '静默'}`;
      }
    },
    {
      id: 'bgtasks.wait',
      label: '定时唤醒',
      description:
        '设定时器：到点后自动唤醒本会话继续处理（等待期零消耗、完全不阻塞用户对话）。适合「10 分钟后再检查部署」「下午 3 点提醒我汇总」。',
      argsHint: getHostToolMeta('bgtasks.wait')?.argsHint,
      parameters: specParams('bgtasks.wait'),
      permissionClass: getHostToolMeta('bgtasks.wait')?.permissionClass ?? 'status',
      async execute(args, exec: GuiToolExecContext) {
        const reason = String(args.reason ?? '').trim();
        if (!reason) throw new Error('失败：reason 不能为空');
        const delayMs = parseTimerDelayMs(args.at as string | undefined, args.delaySec as number | undefined);
        if (delayMs === null) throw new Error('失败：delaySec 或 at 必须提供一个合法值');
        if (delayMs > BG_TIMER_MAX_MS) throw new Error('失败：定时时长上限 24 小时');
        const r = managerOf(ctx).addTimer(exec.sessionId, delayMs, reason);
        if (!r.ok) throw new Error(`设置失败：${r.error}`);
        return `定时器已设（${r.id}），${delayMs} ms 后唤醒`;
      }
    },
    {
      id: 'bgtasks.list',
      label: '查后台任务',
      description: '列出本会话的后台任务（状态/退出码/结果摘要）。',
      argsHint: getHostToolMeta('bgtasks.list')?.argsHint,
      parameters: specParams('bgtasks.list'),
      permissionClass: getHostToolMeta('bgtasks.list')?.permissionClass ?? 'read',
      async execute(_args, exec: GuiToolExecContext) {
        const tasks = managerOf(ctx).listFor(exec.sessionId);
        if (tasks.length === 0) return '当前没有后台任务。';
        return tasks
          .map((t) => {
            const state =
              t.status === 'running'
                ? '运行中'
                : t.status === 'done'
                  ? `完成${typeof t.exitCode === 'number' && t.exitCode !== 0 ? `(exit ${t.exitCode})` : ''}`
                  : t.status === 'cancelled'
                    ? '已取消'
                    : `失败${typeof t.exitCode === 'number' ? `(exit ${t.exitCode})` : ''}`;
            const usage = t.usage
              ? `；轮次 ${t.usage.turns}${t.budget?.maxTurns !== undefined ? `/${t.budget.maxTurns}` : ''}，token ${t.usage.tokens}${t.budget?.tokenCap !== undefined ? `/${t.budget.tokenCap}` : ''}`
              : '';
            return `- [${t.id}] ${t.kind}「${t.label}」 ${state}${usage}${t.summary ? `\n  摘要：${t.summary}` : ''}`;
          })
          .join('\n');
      }
    },
    {
      id: 'bgtasks.kill',
      label: '终止后台任务',
      description: '终止一个运行中的后台任务（子代理 / 后台终端 / 定时器）。initiator 标记谁发起终止。',
      argsHint: getHostToolMeta('bgtasks.kill')?.argsHint,
      parameters: specParams('bgtasks.kill'),
      permissionClass: getHostToolMeta('bgtasks.kill')?.permissionClass ?? 'status',
      async execute(args) {
        const taskId = String(args.taskId ?? '').trim();
        const raw = String(args.initiator ?? '').trim();
        const initiator: BgKillInitiator = raw === 'user' ? 'user' : 'model';
        const ok = await managerOf(ctx).killAndWait(taskId, initiator);
        if (!ok) throw new Error(`终止失败：任务不存在（${taskId}）`);
        return `已终止 ${taskId}（${initiator === 'user' ? '用户终止' : '模型终止'}）`;
      }
    }
  ];
  return tools;
}
