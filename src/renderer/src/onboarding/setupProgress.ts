import type { LlmConfig } from '../../../shared/types';
import { t } from '../../../shared/i18n';

export const SETUP_STEPS = ['tools', 'model', 'workspace', 'session', 'left', 'right', 'virtual', 'board', 'theme', 'finish'] as const;
export type SetupStep = typeof SETUP_STEPS[number];
export type SetupProgress = SetupStep | 'done';
export type WorkbenchSetupStep = Exclude<SetupStep, 'tools' | 'model'>;
const DEFERABLE_STEPS = ['tools', 'model', 'remote'] as const;
export type DeferredSetupStep = typeof DEFERABLE_STEPS[number];
export interface SetupState {
  step: SetupProgress;
  deferred: DeferredSetupStep[];
  paused?: true;
}
export type MoveSetup = (step: SetupProgress, outcome?: { step: DeferredSetupStep; skipped: boolean }) => void;
export interface DesktopSetup extends Omit<SetupState, 'step'> {
  step: SetupStep;
  hasWorkspace: boolean;
  hasSession: boolean;
  configuredModel: boolean;
  modelSettingsItem?: string;
  notice?: string;
  move: MoveSetup;
  onPause: () => void;
  onResume: () => void;
  onModelReturn: () => Promise<void>;
}

const STORAGE_KEY = 'muster.firstRun.v1';

function setupStep(value: unknown): SetupProgress | undefined {
  if (value === 'remote') return 'workspace';
  return value === 'done' ? value : SETUP_STEPS.find(step => step === value);
}

export function reconcileSetupStep(step: SetupProgress, hasWorkspace: boolean, hasSession: boolean): SetupProgress {
  if (step === 'tools' || step === 'model' || step === 'done') return step;
  if (!hasWorkspace) return 'workspace';
  return step === 'workspace' || step === 'session' ? (hasSession ? 'left' : 'session') : step;
}

export function getSetupModelIssue(llm: LlmConfig | undefined): { settingsItem: string; message: string } | undefined {
  const provider = llm?.providers.find(item => item.id === llm.activeProviderId);
  if (!provider) return { settingsItem: 'agent-provider', message: t('请添加供应商，并保存一个默认模型。') };
  if (provider.enabled === false) return { settingsItem: 'agent-provider-enabled', message: t('默认供应商未启用。请启用它，或选择其他供应商设为默认。') };
  if (!provider.baseUrl.trim()) return { settingsItem: 'agent-base-url', message: t('默认供应商还没填写接口地址。请填写并保存后继续。') };
  if (!provider.apiKey.trim()) return { settingsItem: 'agent-api-key', message: t('默认供应商还没填写 API Key。请填写并保存后继续。') };
  if (!provider.models.some(model => model.id === llm?.activeModelId)) {
    return { settingsItem: 'agent-model-actions', message: t('还没有可用的默认模型。请添加模型，设为默认并保存。') };
  }
}

export function readSetupProgress(): SetupState | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const legacy = setupStep(value);
    if (legacy) return { step: legacy, deferred: [] };
    const saved = JSON.parse(value) as Partial<SetupState> | null;
    const step = setupStep(saved?.step);
    if (!step) return null;
    const deferred = Array.isArray(saved?.deferred) ? DEFERABLE_STEPS.filter(item => saved.deferred?.includes(item)) : [];
    return step !== 'done' && saved?.paused === true ? { step, deferred, paused: true } : { step, deferred };
  } catch {
    return null;
  }
}

export function writeSetupProgress(progress: SetupState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}
