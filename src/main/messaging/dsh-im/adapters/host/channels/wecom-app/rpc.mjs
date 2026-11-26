import { createConnectionDiagnostics, diagnosticRpcResult } from '../../../../src/channels/shared/connection-error.mjs';
import { SET_ALIAS_ENDPOINT, validAliasPayload } from '../shared/bot-alias-rpc.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';

import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { publicWorkspaceError } from '../shared/workspace-rpc.mjs';

import {
  connectionTestTargetUnavailable,
  publicConnectionTestResult,
} from '../../../../src/channels/shared/connection-test.mjs';

export const WECOM_APP_RPC_CHANNEL = '/wecom-app';
export const WECOM_APP_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  bindApp: 'bot.bind',
  updateSettings: 'bot.settings.update',
  resetCallbackSecret: 'bot.callback-secret.reset',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',

  setAlias: SET_ALIAS_ENDPOINT,
});
export const WECOM_APP_RPC_ENDPOINTS = Object.freeze(Object.values(WECOM_APP_ENDPOINTS));

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'secret', 'secretRef', 'token', 'encodingAESKey', 'callbackTokenRef', 'callbackKeyRef',
  'callbackSecret', 'corpSecret', 'bot_info',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validCredential(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return 'Payload must be an object.';
  if (endpoint === WECOM_APP_ENDPOINTS.status) return exactKeys(payload, []) ? null : 'connection.status does not accept fields.';
  if (endpoint === WECOM_APP_ENDPOINTS.bindApp) {
    const allowed = ['corpId', 'agentId', 'secret', 'token', 'encodingAESKey', 'apiBaseUrl', 'callbackBaseUrl', 'streamEnabled'];
    if (!exactKeys(payload, allowed)) return 'bot.bind received unsupported fields.';
    if (!validCredential(payload.corpId, 128) || !validCredential(payload.agentId, 32)
      || !validCredential(payload.secret, 256) || !validCredential(payload.token, 128)
      || !validCredential(payload.encodingAESKey, 128)) {
      return 'bot.bind requires corpId, agentId, secret, token, and encodingAESKey.';
    }
    if (payload.apiBaseUrl !== undefined && payload.apiBaseUrl !== null && typeof payload.apiBaseUrl !== 'string') {
      return 'bot.bind received an invalid apiBaseUrl.';
    }
    if (payload.callbackBaseUrl !== undefined && payload.callbackBaseUrl !== null && typeof payload.callbackBaseUrl !== 'string') {
      return 'bot.bind received an invalid callbackBaseUrl.';
    }
    if (payload.streamEnabled !== undefined && payload.streamEnabled !== true && payload.streamEnabled !== false) {
      return 'bot.bind received an invalid streamEnabled flag.';
    }
    return null;
  }
  if (endpoint === WECOM_APP_ENDPOINTS.updateSettings) {
    if (!exactKeys(payload, ['botId', 'apiBaseUrl', 'callbackBaseUrl', 'streamEnabled']) || !validId(payload.botId)) {
      return 'bot.settings.update requires a botId and settings fields.';
    }
    if (payload.apiBaseUrl !== undefined && payload.apiBaseUrl !== null && typeof payload.apiBaseUrl !== 'string') {
      return 'bot.settings.update received an invalid apiBaseUrl.';
    }
    if (payload.callbackBaseUrl !== undefined && payload.callbackBaseUrl !== null && typeof payload.callbackBaseUrl !== 'string') {
      return 'bot.settings.update received an invalid callbackBaseUrl.';
    }
    if (payload.streamEnabled !== undefined && payload.streamEnabled !== true && payload.streamEnabled !== false) {
      return 'bot.settings.update received an invalid streamEnabled flag.';
    }
    return null;
  }
  if (endpoint === WECOM_APP_ENDPOINTS.resetCallbackSecret) {
    return exactKeys(payload, ['botId']) && validId(payload.botId)
      ? null : 'bot.callback-secret.reset requires a botId.';
  }
  if (endpoint === WECOM_APP_ENDPOINTS.reconnectBot) {
    return exactKeys(payload, ['botId', 'sendTest'])
      && validId(payload.botId)
      && (payload.sendTest === undefined || payload.sendTest === true)
      ? null : 'bot.reconnect requires a botId and optional sendTest=true.';
  }
  if (endpoint === WECOM_APP_ENDPOINTS.deleteBot) {
    return exactKeys(payload, ['botId', 'confirm']) && validId(payload.botId) && payload.confirm === true
      ? null : 'bot.delete requires a botId and confirm=true.';
  }

  if (endpoint === WECOM_APP_ENDPOINTS.setAlias) {
    return validAliasPayload(payload) ? null : '请输入有效的别名（最多 80 个字符）。';
  }
  return 'Unknown Enterprise WeChat app endpoint.';
}

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (!isRecord(value)) return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_PUBLIC_KEYS.has(key)) safe[key] = sanitizePublic(child);
  }
  return safe;
}

function publicStatus(status) {
  return sanitizePublic(structuredClone(status));
}

export function createWecomAppRpcHandler(controller) {
  const diagnostics = controller.diagnostics ?? createConnectionDiagnostics({ channel: 'wecom-app' });
  for (const method of ['status', 'bindApp', 'updateAppSettings', 'resetCallbackSecret', 'reconnectBot', 'deleteBot']) {
    if (typeof controller?.[method] !== 'function') {
      throw new TypeError(`A complete Enterprise WeChat app controller is required (${method})`);
    }
  }
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };
    if (!WECOM_APP_RPC_ENDPOINTS.includes(endpoint)) {
      return { ok: false, error: { code: 'bad-request', message: 'Unknown Enterprise WeChat app endpoint.', details: {} } };
    }
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return { ok: false, error: { code: 'bad-request', message: invalid } };
    try {
      let value;
      if (endpoint === WECOM_APP_ENDPOINTS.status) value = await publicStatus(await controller.status());
      else if (endpoint === WECOM_APP_ENDPOINTS.bindApp) {
        value = await publicStatus(await controller.bindApp(payload));
      } else if (endpoint === WECOM_APP_ENDPOINTS.updateSettings) {
        value = await publicStatus(await controller.updateAppSettings(payload.botId, {
          apiBaseUrl: payload.apiBaseUrl,
          callbackBaseUrl: payload.callbackBaseUrl,
          streamEnabled: payload.streamEnabled,
        }));
      } else if (endpoint === WECOM_APP_ENDPOINTS.resetCallbackSecret) {
        value = await publicStatus(await controller.resetCallbackSecret(payload.botId));
      } else if (endpoint === WECOM_APP_ENDPOINTS.reconnectBot) {
        const snapshot = await controller.reconnectBot(payload.botId);
        if (signal?.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };
        }
        let testMessage;
        if (payload.sendTest === true) {
          const connected = snapshot?.bots?.some(
            (bot) => bot?.botId === payload.botId && bot?.connected === true,
          );
          if (!connected || typeof controller.sendConnectionTest !== 'function') {
            testMessage = publicConnectionTestResult(connectionTestTargetUnavailable('企业微信应用'));
          } else {
            try {
              await controller.sendConnectionTest(payload.botId);
              testMessage = publicConnectionTestResult();
            } catch (error) {
              testMessage = publicConnectionTestResult(error, { diagnostics, botId: payload.botId });
            }
          }
        }
        value = await publicStatus({ ...snapshot, ...(testMessage ? { testMessage } : {}) });
      } else if (endpoint === WECOM_APP_ENDPOINTS.setAlias) {
        if (typeof controller.updateAlias !== 'function') throw new Error('Alias update is unavailable');
        value = await controller.updateAlias(
          payload.botId, payload.alias, (status) => publicStatus(status),
        );
      } else {
        value = await publicStatus(await controller.deleteBot(payload.botId));
      }
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } }
        : { ok: true, value };
    } catch (error) {
      const workspaceError = publicWorkspaceError(error);
      return diagnosticRpcResult(diagnostics, error, signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } }
        : { ok: false, error: workspaceError
          ? { ...workspaceError, details: {} }
          : { code: 'wecom-app-operation-failed', message: '企业微信应用操作失败，请稍后重试。', details: {} } }, { operation: endpoint, botId: payload?.botId });
    }
  };
}

export function installWecomAppRpc(ctx, controller, options, authority) {
  return registerManagementRpc(ctx,
    WECOM_APP_RPC_CHANNEL,
    createWecomAppRpcHandler(controller, options),
    { authority: resolveRpcAuthority(authority) },
  );
}
