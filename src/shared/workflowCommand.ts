/**
 * 工作流输入框命令（dynamic-workflow W1，调度对话框）：`/workflow-new <描述>`（别名 `/新建工作流`）
 * 与 `/workflow <名字> <参数>`（别名 `/工作流`）。渲染层据此放行发送，主进程在调度回合
 * 进引擎前展开成指令（只进引擎，界面显示用户原文）。零依赖纯函数，渲染层可直接引用。
 */

export const WORKFLOWS_DIR = '.muster/workflows';
export const WORKFLOW_SKILL_PATH = '~/.muster/skills/workflow/SKILL.md';
export const WORKFLOW_DOC_FILE = 'WORKFLOW.md';
export const WORKFLOW_SCRIPT_FILE = 'run.mjs';

export type WorkflowCommand = { kind: 'new'; description: string } | { kind: 'run'; name: string; args: string };

export function parseWorkflowCommand(text: string): WorkflowCommand | null {
  const s = text.trim();
  const mNew = /^\/(?:workflow-new|新建工作流)(?:\s+([\s\S]*))?$/i.exec(s);
  if (mNew) return { kind: 'new', description: (mNew[1] ?? '').trim() };
  const mRun = /^\/(?:workflow|工作流)(?:\s+([\s\S]*))?$/i.exec(s);
  if (!mRun) return null;
  const rest = (mRun[1] ?? '').trim();
  const sp = rest.search(/\s/);
  const name = sp < 0 ? rest : rest.slice(0, sp);
  const args = sp < 0 ? '' : rest.slice(sp + 1).trim();
  return { kind: 'run', name, args };
}

/** 展开成给调度引擎的指令 */
export function expandWorkflowCommand(cmd: WorkflowCommand): string {
  if (cmd.kind === 'new') {
    return [
      `【工作流命令 · 新建】用户要新建一个工作流：${cmd.description || '（未写描述——先问用户这个工作流要做什么）'}`,
      `做法：先读 ${WORKFLOW_SKILL_PATH}（创作说明，含 wf API 与可重跑写法），在 ${WORKFLOWS_DIR}/<名字>/ 下写 ${WORKFLOW_DOC_FILE} 与 ${WORKFLOW_SCRIPT_FILE}；写完用 host.workflow.run 的 validate 动作校验，再向用户说明阶段、要在哪里停下来问谁、大概派几个 Worker。新建或改动内容后，执行型校验和运行都遵循该版本的信任审核。`
    ].join('\n');
  }
  if (!cmd.name) {
    return '【工作流命令 · 运行】用户想运行工作流但没给名字：先用 host.workflow.run 的 list 动作列出可用工作流，再问用户选哪个。';
  }
  return [
    `【工作流命令 · 运行】用户要运行工作流「${cmd.name}」，参数原文：${cmd.args || '（无）'}`,
    '做法：先用 host.workflow.run 的 list 动作核对名字与参数（名字对不上就列出相近的问用户），把参数原文按 WORKFLOW.md 的 args 整理成对象后用 start 动作启动。启动后进度与待答问题会以【编排事件】送来。'
  ].join('\n');
}
