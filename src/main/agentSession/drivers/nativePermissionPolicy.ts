import type { GuiDriverConnectInput } from '../types';
import { nativeOptionAccepts, type NativeConfigIntent, type NativeConfigState, type NativeConfigValue } from '../../../shared/nativeSessionConfig';

type Selection = NativeConfigIntent['selections'][number];

export function automaticPermissions(input: GuiDriverConnectInput): boolean {
  return input.getAutomaticPermissions?.() ?? input.automaticPermissions === true;
}

export function automaticNativeSelections(state: NativeConfigState, known: readonly Selection[]): Selection[] {
  return known.filter(({ id, value }) => state.options.some(option => option.id === id &&
    option.changePolicy !== 'read-only' && nativeOptionAccepts(option, value)));
}

const acpPermissionIds = ['permissionMode', 'permission-mode', 'permission_mode', 'permissions', 'approvalMode', 'approval-mode', 'approval_mode'];
const acpPermissionValues = ['bypassPermissions', 'bypass-permissions', 'bypass_permissions', 'yolo', 'full-access'];

export function automaticAcpPermissions(state: NativeConfigState): Selection[] {
  const explicit = acpPermissionIds.flatMap(id => automaticNativeSelections(state,
    acpPermissionValues.map(value => ({ id, value }))).slice(0, 1));
  if (explicit.length) return explicit;
  const legacyMode = state.options.find(option => option.id === 'mode');
  return legacyMode?.currentValue === 'plan' ? []
    : automaticNativeSelections(state, acpPermissionValues.map(value => ({ id: 'mode', value }))).slice(0, 1);
}

export async function restoreNativePermissions(
  readState: () => NativeConfigState,
  selections: readonly Selection[],
  set: (id: string, value: NativeConfigValue) => Promise<void>
): Promise<void> {
  for (const item of selections) {
    const option = readState().options.find(option => option.id === item.id);
    if (!option || !nativeOptionAccepts(option, item.value)) {
      throw new Error('The Harness no longer offers the previous native permission. Select an available permission to continue.');
    }
    if (option.currentValue !== item.value) await set(item.id, item.value);
  }
}

export async function applyNativePermissionStrategy(
  input: GuiDriverConnectInput,
  readState: () => NativeConfigState,
  selections: readonly Selection[],
  set: (id: string, value: NativeConfigValue) => Promise<void>,
): Promise<void> {
  if (!automaticPermissions(input)) {
    const restore = input.getNativePermissionRestore?.();
    if (!restore?.length) return;
    await restoreNativePermissions(readState, restore, set);
    await input.onNativePermissionRestore?.();
    return;
  }
  const state = readState();
  const changes = selections.flatMap(item => {
    const option = state.options.find(option => option.id === item.id);
    // An automatic override must be reversible even if the engine persists
    // session settings and the application exits before the next turn.
    if (!option || !nativeOptionAccepts(option, option.currentValue) || option.currentValue === item.value) return [];
    return [{ item, previous: { id: item.id, value: option.currentValue } }];
  });
  if (!changes.length) return;
  try {
    await input.onNativePermissionRestore?.(changes.map(change => change.previous));
    if (!automaticPermissions(input)) return;
    for (const { item } of changes) {
      if (!automaticPermissions(input)) return;
      if (readState().options.find(option => option.id === item.id)?.currentValue !== item.value) await set(item.id, item.value);
    }
  } catch (error) {
    input.log('warn', `Native automatic permissions unavailable. Workbench will handle permission requests. ${(error as Error).message}`);
  }
}
