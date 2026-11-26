import type { WorkerTargetConfig } from '../../../../shared/workerRouting';
import { HARNESS_CATALOG } from '../../../../shared/harnessCatalog';

export function workerTargetLabel(config: WorkerTargetConfig, defaultLabel: string): string {
  const product = HARNESS_CATALOG.find(item => item.id === config.harnessId);
  const model = config.model ? (config.runtimeId === 'pi' ? `${config.model.providerId} · ${config.model.modelId}` : config.model.modelId) : config.cliLaunchOptions?.model;
  const values = Object.values(config.modelParameters ?? {});
  if (config.cliLaunchOptions?.reasoning) values.push(config.cliLaunchOptions.reasoning);
  return [product?.name ?? config.harnessId, config.surface.toUpperCase(), model || defaultLabel, ...values].join(' · ');
}
