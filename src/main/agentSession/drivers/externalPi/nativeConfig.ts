import type { NativeConfigState } from '../../../../shared/nativeSessionConfig';

// OMP 18.3+ RPC has no mode setter or current approvalMode field.
export function externalPiNativeConfig(runtimeId: string): NativeConfigState {
  if (runtimeId !== 'omp') return { status: 'unsupported', options: [] };
  return { status: 'ready', catalogSource: 'versioned-adapter', options: [{
    id: 'tools.approvalMode', name: 'Approval Mode', type: 'select', changePolicy: 'launch-only',
    choices: [
      { value: 'always-ask', name: 'always-ask', description: 'Prompts for write and execute operations.' },
      { value: 'always-ask-cached', name: 'always-ask-cached', description: 'Also prompts for unread files and can remember grants.' },
      { value: 'write', name: 'write', description: 'Approves read and write tiers. Prompts for execute.' },
      { value: 'yolo', name: 'yolo', description: 'Approves all three tool tiers.' }
    ]
  }] };
}
