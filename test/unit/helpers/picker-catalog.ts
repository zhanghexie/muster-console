import type { HarnessPickerCatalog, HarnessPickerIdentity, HarnessPickerModel, HarnessPickerRequest, HarnessPickerResult } from '../../../src/shared/harnessPicker';
import type { ModelParameterState } from '../../../src/shared/modelParameters';

/** Reject accidental view-model fields the production IPC will also reject. */
export function pickerCatalog(request: HarnessPickerRequest, options: {
  harness?: HarnessPickerIdentity;
  models?: HarnessPickerModel[];
  controls?: ModelParameterState[];
  current?: HarnessPickerCatalog['selectedModel'];
  currentParameters?: HarnessPickerCatalog['selectedParameters'];
  state?: HarnessPickerCatalog['state'];
  warning?: string;
  canSetModel?: boolean;
  canRefresh?: boolean;
  expected?: string;
  commitStamp?: string;
} = {}): HarnessPickerResult {
  if (request.model && Object.keys(request.model).sort().join() !== 'modelId,providerId') throw new Error('Unexpected model fields');
  if ('source' in request && Object.keys(request.harness).some(key => !['harnessId', 'runtimeId', 'surface', 'acpPresetId'].includes(key))) {
    throw new Error('Unexpected Harness fields');
  }
  const source = 'source' in request ? request.source : { workspaceId: 'fixture', rootId: 'root', rootsRevision: 0, cwd: 'E:/fixture' };
  const models = options.models ?? [];
  return { ok: true, catalog: {
    harness: 'harness' in request ? request.harness : options.harness ?? { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui' },
    source: { ...source, rootsRevision: source.rootsRevision ?? 0, cwd: source.cwd ?? 'E:/fixture' },
    models, defaultModel: models[0] ? { providerId: models[0].providerId, modelId: models[0].modelId } : null,
    state: options.state ?? 'ready', warning: options.warning, canRefresh: options.canRefresh ?? false, canSetModel: options.canSetModel,
    parameterState: request.model === undefined ? 'not-requested' : 'ready', parameters: options.controls,
    ...('source' in request ? {} : { selectedModel: options.current ?? null, selectedParameters: options.currentParameters ?? {}, sessionStamp: options.expected ?? 'test-stamp', commitStamp: options.commitStamp })
  } };
}
