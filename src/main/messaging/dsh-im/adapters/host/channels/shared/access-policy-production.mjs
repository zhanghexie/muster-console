import {
  createAccessPolicy,
  createAccessPolicyScope,
} from '../../../../src/channels/shared/access-policy.mjs';

function allowlistScope(ids = []) {
  const users = [...new Set(ids.filter(id => typeof id === 'string' || typeof id === 'number')
    .map(id => String(id).trim()).filter(id => id && id !== '*'))];
  return createAccessPolicyScope({
    mode: 'allowlist',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: users.map(id => ({ id, canExecuteCommands: false })) },
  });
}

/** Pairing supplies transport credentials, so the administrator must separately authorize senders. */
export function initialAccessPolicyFor(channel, config = {}) {
  let direct = [];
  if (channel === 'telegram' && Array.isArray(config.allowedUsers)) direct = config.allowedUsers;
  if (channel === 'whatsapp' && Array.isArray(config.allowedNumbers)) {
    direct = config.allowedNumbers.map(value => typeof value === 'string' && /^\+?\d+$/.test(value.trim())
      ? `${value.trim().replace(/^\+/, '')}@s.whatsapp.net` : '');
  }
  return createAccessPolicy({ direct: allowlistScope(direct), group: allowlistScope() });
}

export const newBotAccessPolicyFor = initialAccessPolicyFor;

export function accessPolicyProvider(workspaces, botId) {
  if (!workspaces || typeof workspaces.accessPolicyFor !== 'function') {
    throw new TypeError('A workspace store with access policies is required');
  }
  return Object.freeze({
    botId,
    getSettings: () => workspaces.accessPolicyFor(botId),
    isPrivileged: () => false,
  });
}
