/**
 * workflow 组（dynamic-workflow W1）：脚本工作流的查看/校验/启动/取消/答复。仅调度调用链
 * （不进任何 Worker 白名单）。创作合同由宿主 workflow 技能提供，描述只给路径。
 */
import type { ToolDef } from './types';
import { WORKFLOW_SKILL_PATH } from '../../../shared/workflowCommand';

const runIdProp = { runId: { type: 'string', description: 'run id (returned by workflow.start / listed in workflow.list active)' } };

export const WORKFLOW_TOOL_DEFS: ToolDef[] = [
  {
    name: 'workflow.list',
    summary: 'List this workspace\'s available workflows and running runs',
    description:
      `List workflows under .muster/workflows/ (name, description, parameters, limits, schedule/event triggers, trust state trusted|changed|never; errors included when the definition is broken) plus running/recently finished runs. Read ${WORKFLOW_SKILL_PATH} before writing a new workflow. Scheduler only`,
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'workflow.validate',
    summary: 'Validate a workflow definition (static parse + executable smoke import, gated by current-content business approval)',
    description:
      'Validate a workflow: statically parse the WORKFLOW.md frontmatter (no script execution); then import run.mjs in an isolated kernel to check the default export — note this is executable validation, module top-level code really runs (the worker thread is not a sandbox), so new or changed content needs business approval bound to the current fingerprint; unchanged trusted content reuses trust; on refusal the import is skipped and noted in the result exec field. Call after writing or editing a workflow; once it passes, explain the flow to the user. Scheduler only',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Workflow name (directory name)' } },
      required: ['name']
    }
  },
  {
    name: 'workflow.start',
    summary: 'Start a workflow (new or changed content needs fingerprint-bound business approval)',
    description:
      'Start a workflow run; it returns the runId immediately and needs no watching afterwards: progress, pending questions, completion, and failure arrive as orchestration events (kind "workflow"). New or changed content requires fingerprint-bound business approval before execution; unchanged trusted content reuses trust. At most 3 concurrent runs per workspace. Scheduler only',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        args: { type: 'object', description: 'Parameter object; keys per workflow.list args (? marks optional)' }
      },
      required: ['name']
    }
  },
  {
    name: 'workflow.get',
    summary: 'View run status, stage, what it waits on, pending questions, and log tail',
    description: 'View a run\'s status (running/waiting/completed/failed/cancelled/interrupted), current stage, what it waits on, pending questions, delegation counts, and log tail. Scheduler only',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { ...runIdProp, logTail: { type: 'number', description: 'Log tail lines, default 20' } },
      required: ['runId']
    }
  },
  {
    name: 'workflow.cancel',
    summary: 'Cancel a run (sub-workflows included; optionally close spawned sessions too)',
    description:
      'Cancel a running run together with the sub-workflows it launched. By default spawned Worker sessions are not closed; closeSessions=true closes them too, reporting any that fail to close. Scheduler only',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        ...runIdProp,
        reason: { type: 'string', description: 'Cancel reason (recorded in the run log)' },
        closeSessions: { type: 'boolean', description: 'Also close the sessions this run spawned; default false' }
      },
      required: ['runId']
    }
  },
  {
    name: 'workflow.reply',
    summary: 'Answer a question the workflow asked you (wf.ask)',
    description:
      'Answer a question the workflow script handed back to you (the "asks you: ..." in events). Give answer as the question demands: option verbatim text when options exist (array for multi-select), otherwise text or an object. Questions for the user cannot be answered here — use workflow.askHuman. Scheduler only',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        ...runIdProp,
        askId: { type: 'string', description: 'Question id (in the event or workflow.get\'s pendingAsk)' },
        answer: { description: 'Answer: string / string array / object' }
      },
      required: ['runId', 'askId', 'answer']
    }
  },
  {
    name: 'workflow.askHuman',
    summary: 'Pop the workflow\'s user question as a question card; the answer is written back to the script directly',
    description:
      'Workflow questions for the user already light up in the workflow panel with a desktop notification by default, and the user answers there. Call this only when the user mentions it in conversation or asks you to re-surface it: the question pops verbatim as a question card, the user\'s answer is written back to the script directly — do not rewrite or answer for them. Closing the card leaves the question pending. Scheduler only',
    dangerous: false,
    parameters: { type: 'object', properties: { ...runIdProp }, required: ['runId'] }
  }
];
