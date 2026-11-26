import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { NativeConfigState } from '../../../../shared/nativeSessionConfig';

// Claude Agent SDK 0.3.272, PermissionMode and Query.setPermissionMode.
const modes = {
  default: ['Default', 'Prompts for operations that require permission.'],
  acceptEdits: ['Accept Edits', 'Automatically accepts file edits.'],
  bypassPermissions: ['Bypass Permissions', 'Bypasses permission checks. Requires explicit startup opt-in.'],
  plan: ['Plan', 'Enables Claude Code planning mode.'],
  dontAsk: ["Don't Ask", 'Denies requests that have not already been approved.'],
  auto: ['Auto', 'Uses the Claude Code classifier to review requests.']
} satisfies Record<PermissionMode, [string, string]>;

export function isClaudePermissionMode(mode: unknown): mode is PermissionMode {
  return typeof mode === 'string' && Object.hasOwn(modes, mode);
}

export function claudeNativeConfig(currentValue?: PermissionMode): NativeConfigState {
  return { status: 'ready', catalogSource: 'versioned-adapter', options: [{
    id: 'permissionMode', name: 'Permission Mode', category: 'permissions', type: 'select', changePolicy: 'live', currentValue,
    choices: Object.entries(modes).map(([value, [name, description]]) => ({ value, name, description,
      ...(value === 'bypassPermissions' ? { launchOnly: true } : {}) }))
  }] };
}
