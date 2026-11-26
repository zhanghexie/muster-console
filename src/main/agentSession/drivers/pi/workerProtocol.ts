/** Private per-connection IPC between the Pi supervisor and its SDK worker. */
import type { GuiDriverConnectDto, GuiDriverStreamEvent, GuiForkIdentity, GuiNativeForkPoint } from '../../types';
import type { GuiToolPermissionClass } from '../../../../shared/guiWorkerPolicy';
import type { ModelParameterValues } from '../../../../shared/modelParameters';
import type { AgentMode, GuiThinkingLevel, PlanStepView } from '../../../../shared/types';
import type { RuntimeMessage } from '../../../../shared/runtimeCommunication';
import type { PiShellEnv } from './shellEnv';

export interface PiWorkerTool {
  id: string;
  label: string;
  description: string;
  argsHint?: string;
  parameters: Record<string, unknown>;
  permissionClass: GuiToolPermissionClass;
}

export interface PiWorkerModeState {
  mode: AgentMode;
  executing: boolean;
  planSteps: PlanStepView[];
}

export interface PiWorkerCreate {
  dto: GuiDriverConnectDto;
  userDataDir: string;
  providerId: string;
  modelId: string;
  providerDefaultOutput?: import('../../../agent/piConfigSync').PiSyncResult['providerDefaultOutput'];
  shellEnv: PiShellEnv;
  tools: PiWorkerTool[];
  supportsQuestions: boolean;
  modeState: PiWorkerModeState;
}

export type PiWorkerRequest =
  | { type: 'identity-challenge'; nonce: string }
  | { type: 'request'; id: number; operation: 'create'; create: PiWorkerCreate }
  | { type: 'request'; id: number; operation: 'image'; generation: number; index: number; part: number; parts: number; data: string; mimeType: string; name?: string }
  | { type: 'request'; id: number; operation: 'send'; generation: number; text: string; imageCount?: number; parameters?: ModelParameterValues; memory?: PiMemorySnapshot; thinking?: GuiThinkingLevel | null; forkIdentity?: GuiForkIdentity; literalText?: boolean }
  | { type: 'request'; id: number; operation: 'fork'; point: GuiNativeForkPoint }
  | { type: 'request'; id: number; operation: 'receive'; generation: number; message: RuntimeMessage; memory?: PiMemorySnapshot }
  | { type: 'request'; id: number; operation: 'redirect'; generation: number; text: string; memory?: PiMemorySnapshot }
  | { type: 'request'; id: number; operation: 'compact'; text?: string }
  | { type: 'request'; id: number; operation: 'abort' | 'close' }
  | { type: 'mode'; state: PiWorkerModeState }
  | { type: 'host-result'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'host-cancel'; id: number };

export interface PiMemorySnapshot { text: string; versionToken: string }

export type PiWorkerResponse =
  | { type: 'ready' }
  | { type: 'identity-response'; nonce: string }
  | { type: 'response'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'event'; generation?: number; event: GuiDriverStreamEvent; contextUsage?: { tokens: number | null; contextWindow: number } | null }
  | { type: 'host-call'; id: number; generation?: number; method: string; args?: unknown }
  | { type: 'host-cancel'; id: number }
  | { type: 'plan'; generation?: number; kind: 'extracted' | 'updated' | 'completed'; value?: unknown };

export const PI_WORKER_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const PI_WORKER_MAX_PENDING = 64;
/** Existing attachment processing allows 256 MiB of source bytes. */
export const PI_WORKER_MAX_IMAGE_CHARS = Math.ceil(256 * 1024 * 1024 * 4 / 3) + 4 * 4096;
export const PI_WORKER_IMAGE_CHUNK_CHARS = 4 * 1024 * 1024;
