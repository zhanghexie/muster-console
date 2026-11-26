/** 工作流运行时单例缝：hosts/workflow 经此取运行时，避免 executor ↔ wiring 循环依赖 */
import type { WorkflowRuntime } from './runtime';

let runtimeRef: WorkflowRuntime | null = null;

export function getWorkflowRuntime(): WorkflowRuntime | null {
  return runtimeRef;
}

export function bindWorkflowRuntime(r: WorkflowRuntime | null): void {
  runtimeRef = r;
}
