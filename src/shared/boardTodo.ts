import type { GuiThinkingLevel, GuiWorkerMode, WorkspaceWorktreeGroupSelection } from './types';
import type { CliLaunchOptions } from './cliLaunchOptions';

export interface ExtensionTaskSource {
  extensionId: string;
  scope: 'global' | 'project';
  fingerprint: string;
  workspaceId: string;
  rootId: string;
  surfaceId: string;
  sourceRootId?: string;
  skillNames: string[];
}

/** Saved form data; a TODO has no session or runtime lifecycle. */
export interface TaskDraftAdvanced {
  extensionSource?: ExtensionTaskSource;
  cliLaunchOptions?: CliLaunchOptions;
  guiMode?: GuiWorkerMode;
  configurePermissions?: boolean;
  nativeConfig?: import('./nativeSessionConfig').NativeConfigIntent;
  piModeId?: string;
  model?: { providerId: string; modelId: string };
  thinking?: GuiThinkingLevel;
  modelParameters?: import('./modelParameters').ModelParameterValues;
}

export interface BoardTodoInput {
  name: string;
  task: string;
  attachments?: import('./types').ChatImageAttachment[];
  workspaceId?: string;
  source?: { rootId: string; path: string };
  surface: 'chat' | 'pty';
  runtime: string;
  advanced: TaskDraftAdvanced;
  isolate: boolean;
  isolationGroups?: WorkspaceWorktreeGroupSelection[];
}

export interface BoardTodo extends Omit<BoardTodoInput, 'attachments'> {
  attachmentKey?: string;
  id: string;
  createdAt: number;
  updatedAt: number;
}
