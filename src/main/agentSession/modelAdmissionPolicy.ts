import { harnessModelId } from '../../shared/harnessModelSelection';
import { t } from '../../shared/i18n';

export interface AdmissionModel { providerId: string; modelId: string }
export interface AdmissionCatalog { items: AdmissionModel[]; defaultModel?: AdmissionModel }

/** Missing selection is unrestricted; a present list is an execution allowlist. */
export function resolveHarnessModelAdmission(input: {
  runtimeId: string;
  selected: readonly string[] | undefined;
  explicit?: AdmissionModel;
  catalog?: AdmissionCatalog;
}): AdmissionModel | undefined {
  const { runtimeId, selected, explicit, catalog } = input;
  if (selected === undefined) return undefined;
  if (!selected.length) throw new Error(t('该引擎没有启用的模型，请在设置中至少选择一个模型'));
  const includes = (model: AdmissionModel): boolean => selected.includes(harnessModelId(runtimeId, model.providerId, model.modelId));
  if (explicit) {
    if (!includes(explicit)) throw new Error(t('该模型已在设置中禁用：{{model}}；允许的模型：{{allowed}}', {
      model: harnessModelId(runtimeId, explicit.providerId, explicit.modelId), allowed: selected.join(', ')
    }));
    return explicit;
  }
  if (catalog?.defaultModel && includes(catalog.defaultModel)) return catalog.defaultModel;
  const fallback = catalog?.items.find(includes);
  if (fallback) return fallback;
  throw new Error(t('当前模型目录没有已启用的模型，请在设置中选择模型并刷新目录；允许的模型：{{allowed}}', { allowed: selected.join(', ') }));
}
