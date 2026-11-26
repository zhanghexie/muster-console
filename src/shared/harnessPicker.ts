import type { ModelParameterState, ModelParameterValues } from './modelParameters';
import type { RuntimePreflightResult } from './runtimePreflight';
import type { SessionChangeApplied } from './sessionModelChange';

export interface HarnessPickerIdentity {
  harnessId: string;
  surface: 'gui' | 'cli';
  runtimeId: string;
  acpPresetId?: string;
}

export interface HarnessPickerModelIdentity { providerId: string; modelId: string }

/** Presentation metadata only; never derive a provider from a display name or opaque ID. */
export interface HarnessModelGroup { id: string; label: string }

export interface HarnessPickerModel extends HarnessPickerModelIdentity {
  label: string;
  group?: HarnessModelGroup;
  detail?: string;
  nativeLaunchModel?: string;
}

export interface HarnessPickerSource {
  workspaceId: string;
  rootId: string;
  rootsRevision: number;
  cwd: string;
}

export interface HarnessPickerChoice extends HarnessPickerIdentity {
  label: string;
  available: boolean;
  status: RuntimePreflightResult['status'];
  warning?: string;
}

export interface HarnessPickerAvailability { choices: HarnessPickerChoice[]; checkedAt: number }

export type HarnessPickerRequest = (
  { source: Pick<HarnessPickerSource, 'workspaceId' | 'rootId'> & Partial<Pick<HarnessPickerSource, 'rootsRevision' | 'cwd'>>; harness: HarnessPickerIdentity }
  | { sessionId: string }
  | { dispatch: { workspaceId: string } }
) & { requestId: string; refresh?: boolean; model?: HarnessPickerModelIdentity | null };

export interface HarnessPickerCatalog {
  harness: HarnessPickerIdentity;
  source: HarnessPickerSource;
  models: HarnessPickerModel[];
  defaultModel: HarnessPickerModelIdentity | null;
  state: 'ready' | 'missing' | 'unsupported';
  warning?: string;
  parameterState: 'not-requested' | 'ready' | 'unknown';
  parameters?: ModelParameterState[];
  parameterWarning?: string;
  selectedModel?: HarnessPickerModelIdentity | null;
  selectedParameters?: ModelParameterValues;
  sessionStamp?: string;
  /** Includes the current directory generation; use for a configuration commit. */
  commitStamp?: string;
  canRefresh: boolean;
  canSetModel?: boolean;
}

export type HarnessPickerResult = { ok: true; catalog: HarnessPickerCatalog } | { ok: false; error: string; cleanupFailed?: true };

export interface SetModelConfigurationInput {
  sessionId: string;
  expected: string;
  model: HarnessPickerModelIdentity | null;
  /** Complete set of explicit overrides for the chosen model. An empty set follows defaults. */
  parameters: ModelParameterValues;
}

export type SetModelConfigurationResult = { ok: true; applied: SessionChangeApplied; warning?: string } | { ok: false; error: string };
export type SetDispatchModelConfigurationOptions = Pick<SetModelConfigurationInput, 'expected' | 'parameters'>;
