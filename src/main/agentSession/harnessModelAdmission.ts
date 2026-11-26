import type { AppConfig } from '../../shared/types';
import { harnessModelSelectionKey } from '../../shared/harnessModelSelection';
import { t } from '../../shared/i18n';
import { defaultAcpAgentId, getAcpPresets } from './drivers/acp/agents';
import { listCodexModels } from './drivers/codex/models';
import { listAcpModels } from './drivers/acp/models';
import { listClaudeModels } from './drivers/claude/models';
import { listExternalPiModels } from './drivers/externalPi/models';
import { listMuseModels } from './drivers/muse/process';
import { listZCodeModels } from './drivers/zcode/process';
import { HarnessModelSelectionStore } from './harnessModelSelectionStore';
import { resolveHarnessModelAdmission, type AdmissionCatalog, type AdmissionModel } from './modelAdmissionPolicy';

/** Shared by settings IPC and execution; callers must recheck immediately before dispatch. */
export class HarnessModelAdmission {
  readonly selections: HarnessModelSelectionStore;
  constructor(private userDataDir: string, private config: () => AppConfig) {
    this.selections = new HarnessModelSelectionStore(userDataDir);
  }

  private key(runtimeId: string, piModeId?: string): string {
    return harnessModelSelectionKey(runtimeId, runtimeId === 'acp' ? defaultAcpAgentId(piModeId, getAcpPresets(this.userDataDir)) : undefined);
  }

  private selected(runtimeId: string, piModeId?: string): string[] | undefined {
    const all = this.selections.read();
    const key = this.key(runtimeId, piModeId);
    return Object.hasOwn(all, key) ? all[key] : undefined;
  }

  hasSelection(runtimeId: string, piModeId?: string): boolean {
    return this.selected(runtimeId, piModeId) !== undefined;
  }

  assertEnabled(runtimeId: string, piModeId?: string): void {
    const selected = this.selected(runtimeId, piModeId);
    if (selected && !selected.length) resolveHarnessModelAdmission({ runtimeId, selected });
  }

  /** Explicit identities are checked without needing to launch a discovery process. */
  assert(runtimeId: string, piModeId: string | undefined, model?: AdmissionModel): void {
    const selected = this.selected(runtimeId, piModeId);
    if (selected === undefined) return;
    if (!model?.modelId) {
      if (!selected.length) resolveHarnessModelAdmission({ runtimeId, selected });
      throw new Error(t('无法确认当前连接使用的模型，请重试或在设置中选择模型'));
    }
    if (runtimeId === 'acp' && model.modelId === 'default') throw new Error(t('无法确认当前连接使用的模型，请重试或在设置中选择模型'));
    resolveHarnessModelAdmission({ runtimeId, selected, explicit: model });
  }

  async resolve(runtimeId: string, cwd: string, piModeId: string | undefined, explicit?: AdmissionModel, localDefault?: AdmissionModel): Promise<AdmissionModel | undefined> {
    const selected = this.selected(runtimeId, piModeId);
    if (selected === undefined) return undefined;
    if (explicit || !selected.length) return resolveHarnessModelAdmission({ runtimeId, selected, explicit });
    const catalog = await this.catalog(runtimeId, cwd, piModeId, localDefault);
    // A settings edit while discovery was in flight must not authorize an old snapshot.
    if (JSON.stringify(selected) !== JSON.stringify(this.selected(runtimeId, piModeId))) {
      throw new Error(t('模型设置在校验期间发生变化，请重试'));
    }
    const model = resolveHarnessModelAdmission({ runtimeId, selected, catalog });
    // ACP treats the literal `default` as omission, so it cannot enforce that alias.
    if (runtimeId === 'acp' && model?.modelId === 'default') {
      throw new Error(t('无法确认当前连接使用的模型，请重试或在设置中选择模型'));
    }
    return model;
  }

  /** Check that the adapter's manual discovery snapshot is available. */
  async prepareCatalog(runtimeId: string, cwd: string, piModeId?: string): Promise<void> {
    await this.catalog(runtimeId, cwd, piModeId);
  }

  private async catalog(runtimeId: string, cwd: string, piModeId: string | undefined, localDefault?: AdmissionModel): Promise<AdmissionCatalog> {
    const cfg = this.config();
    if (runtimeId === 'pi') {
      return { defaultModel: localDefault, items: (cfg.llm?.providers ?? []).filter(p => p.enabled !== false)
        .flatMap(p => (p.models ?? []).map(m => ({ providerId: p.id, modelId: m.id }))) };
    }
    let result: { ok: true; items: Array<{ id: string }>; defaultId?: string } | { ok: false; error: string };
    if (runtimeId === 'codex-gui') {
      const r = await listCodexModels(cwd);
      result = r.ok ? { ok: true, items: r.items, defaultId: r.defaultModelId } : r;
    } else if (runtimeId === 'acp') {
      const agentId = defaultAcpAgentId(piModeId, getAcpPresets(this.userDataDir));
      const r = await listAcpModels({ cwd, agentId, userDataDir: this.userDataDir });
      result = r.ok ? { ok: true, items: r.items, defaultId: r.currentModelId } : r;
    } else if (runtimeId === 'claude') {
      result = await listClaudeModels({ cwd, userDataDir: this.userDataDir, isolateConfig: cfg.claude?.isolateConfig === true });
    } else if (runtimeId === 'pi-external' || runtimeId === 'omp') {
      const r = await listExternalPiModels({ cwd, runtimeId, executableOverride: cfg.externalPi?.[runtimeId]?.executable });
      result = r.ok ? { ok: true, items: r.items, defaultId: r.currentModelId } : r;
    } else if (runtimeId === 'muse-gui') {
      const r = await listMuseModels({ cwd, executableOverride: cfg.externalHarness?.[runtimeId]?.executable });
      result = r.ok ? { ok: true, items: r.items, defaultId: r.currentModelId } : r;
    } else if (runtimeId === 'zcode-gui') {
      result = await listZCodeModels({ cwd, executableOverride: cfg.externalHarness?.[runtimeId]?.executable });
    } else {
      throw new Error(t('该引擎无法确认已启用的默认模型，请显式选择模型'));
    }
    if (!result.ok) throw new Error(t('无法读取模型目录以校验已启用模型：{{error}}', { error: result.error }));
    const asModel = (modelId: string): AdmissionModel => ({ providerId: runtimeId, modelId });
    return { items: result.items.map(item => asModel(item.id)), ...(result.defaultId ? { defaultModel: asModel(result.defaultId) } : {}) };
  }
}
