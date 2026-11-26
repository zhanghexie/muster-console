import type { ExecutionLifecycle } from '../../../../shared/executionLifecycle';

export type CodexInput = string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>;

export interface CodexThreadOptions {
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
}

export interface CodexTurnOptions {
  signal?: AbortSignal;
  onExecution?: (state: ExecutionLifecycle) => void;
  onSubmission?: () => void;
}

export interface CodexThreadHandle {
  stop?(): Promise<void>;
  readonly id: string | null;
  runStreamed(input: CodexInput, options?: CodexTurnOptions): Promise<{ events: AsyncIterable<unknown> }>;
}

export interface CodexClientHandle {
  startThread(options?: CodexThreadOptions): CodexThreadHandle;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadHandle;
}

type ItemStatus = 'in_progress' | 'completed' | 'failed';
type CodexFileChange = { path: string; kind: 'add' | 'delete' | 'update'; diff?: string; diffOmitted?: boolean };

/** Events projected from app-server notifications for the Host stream mapper. */
export type CodexThreadItem = { id: string } & (
  | { type: 'agent_message' | 'reasoning'; text: string }
  | { type: 'command_execution'; command: string; aggregated_output?: string; exit_code?: number | null; status: ItemStatus }
  | { type: 'file_change'; changes: CodexFileChange[]; status: ItemStatus }
  | { type: 'mcp_tool_call'; server: string; tool: string; arguments: unknown; status: ItemStatus;
      result?: { content?: unknown[]; structured_content?: unknown; structuredContent?: unknown };
      error?: { message?: string } }
  | { type: 'web_search'; query: string }
  | { type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { type: 'error'; message: string }
);

export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' | 'turn.completed' }
  | { type: 'turn.failed'; error?: { message?: string; codexErrorInfo?: unknown; code?: unknown; status?: unknown } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: CodexThreadItem }
  | { type: 'error'; message: string };
