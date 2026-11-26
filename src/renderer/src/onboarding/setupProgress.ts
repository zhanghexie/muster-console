export const SETUP_STEPS = ['tools', 'model', 'remote', 'workspace', 'session'] as const;
export type SetupStep = typeof SETUP_STEPS[number];
export type SetupProgress = SetupStep | 'done';
const DEFERABLE_STEPS = ['tools', 'model', 'remote', 'session'] as const;
export type DeferredSetupStep = typeof DEFERABLE_STEPS[number];
export interface SetupState {
  step: SetupProgress;
  deferred: DeferredSetupStep[];
  dismissed?: true;
}
export type MoveSetup = (step: SetupProgress, outcome?: { step: DeferredSetupStep; skipped: boolean }) => void;

const STORAGE_KEY = 'muster.firstRun.v1';

function setupStep(value: unknown): SetupProgress | undefined {
  return value === 'done' ? value : SETUP_STEPS.find(step => step === value);
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
    return step === 'done' && saved?.dismissed === true ? { step, deferred, dismissed: true } : { step, deferred };
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
