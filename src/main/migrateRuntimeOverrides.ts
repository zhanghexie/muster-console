import type { AppConfig } from '../shared/types';
import type { RuntimeHost } from './runtime/host';

/** 启动时：runtimeOverrides.extraArgs → registry；清空 overrides；修正失效 defaultRuntime */
export async function migrateRuntimeOverridesToHost(
  cfg: AppConfig,
  host: RuntimeHost
): Promise<AppConfig> {
  const overrides = cfg.runtimeOverrides ?? {};
  for (const [id, ov] of Object.entries(overrides)) {
    if (!ov?.extraArgs?.length) continue;
    const e = host.get(id);
    if (!e) continue;
    await host.update(id, { extraArgs: ov.extraArgs });
  }
  const next = { ...cfg, runtimeOverrides: {} };
  if (!host.get(cfg.defaultRuntime)?.enabled) {
    const first = host.listEnabled()[0];
    if (first) next.defaultRuntime = first.id;
  }
  return next;
}
