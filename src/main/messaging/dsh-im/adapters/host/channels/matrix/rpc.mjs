import { SET_ALIAS_ENDPOINT, validAliasPayload } from '../shared/bot-alias-rpc.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';

import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { publicConnectionTestResult } from '../../../../src/channels/shared/connection-test.mjs';
import { publicWorkspaceError } from '../shared/workspace-rpc.mjs';

import { isMatrixUserId, validateMatrixHomeserver } from '../../../../src/channels/matrix/matrix-api.mjs';

export const MATRIX_RPC_CHANNEL = '/matrix';
export const MATRIX_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  bindCredentials: 'bot.bind-credentials',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',

  setAlias: SET_ALIAS_ENDPOINT,
});
export const MATRIX_RPC_ENDPOINTS = Object.freeze(Object.values(MATRIX_ENDPOINTS));

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'token', 'accessToken', 'accessTokenRef', 'tokenRef',
  'password', 'passwordRef', 'platformId', 'secret', 'secretRef',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && /^matrix_[a-f0-9]{24}$/.test(value);
}

function validHomeserver(value) {
  return typeof value === 'string' && value.length <= 2_048 && validateMatrixHomeserver(value) !== null;
}

function validAccessToken(value) {
  return typeof value === 'string' && value.trim().length >= 8 && value.length <= 4_096;
}

function validUserId(value) {
  return typeof value === 'string' && value.length <= 512 && isMatrixUserId(value.trim());
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1_024;
}

function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return 'Payload must be an object.';
  if (endpoint === MATRIX_ENDPOINTS.status) {
    return exactKeys(payload, []) ? null : 'connection.status does not accept fields.';
  }
  if (endpoint === MATRIX_ENDPOINTS.bindCredentials) {
    const hasToken = payload.accessToken !== undefined;
    const hasLogin = payload.userId !== undefined && payload.password !== undefined;
    return exactKeys(payload, ['homeserver', 'accessToken', 'userId', 'password'])
      && validHomeserver(payload.homeserver)
      && (hasToken
        ? (payload.userId === undefined && payload.password === undefined && validAccessToken(payload.accessToken))
        : (hasLogin && validUserId(payload.userId) && validPassword(payload.password)))
      ? null : 'bot.bind-credentials requires a homeserver plus an access token or a user id with password.';
  }
  if (endpoint === MATRIX_ENDPOINTS.reconnectBot) {
    return exactKeys(payload, ['botId', 'sendTest']) && validId(payload.botId)
      && (payload.sendTest === undefined || typeof payload.sendTest === 'boolean')
      ? null : 'bot.reconnect requires a botId.';
  }
  if (endpoint === MATRIX_ENDPOINTS.deleteBot) {
    return exactKeys(payload, ['botId', 'confirm']) && validId(payload.botId) && payload.confirm === true
      ? null : 'bot.delete requires a botId and confirm=true.';
  }

  if (endpoint === MATRIX_ENDPOINTS.setAlias) {
    return validAliasPayload(payload)
      ? null : '请输入有效的别名（最多 80 个字符）。';
  }
  return 'Unknown Matrix endpoint.';
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

function operationError(error) {
  const workspaceError = publicWorkspaceError(error);
  if (workspaceError) return workspaceError;
  if (error?.code === 'invalid-config') {
    return { code: 'invalid-config', message: error.message };
  }
  if (error?.code === 'auth-failed') {
    return { code: 'auth-failed', message: error.message };
  }
  if (error?.code === 'login-failed' || error?.code === 'network' || error?.code === 'timeout') {
    return { code: 'homeserver-unreachable', message: error.message };
  }
  return { code: 'matrix-operation-failed', message: 'Matrix 操作失败，请稍后重试。' };
}

export function createMatrixRpcHandler(controller) {
  for (const method of ['status', 'bindCredentials', 'reconnectBot', 'deleteBot']) {
    if (typeof controller?.[method] !== 'function') {
      throw new TypeError(`A complete Matrix controller is required (${method})`);
    }
  }
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } };
    }
    if (!MATRIX_RPC_ENDPOINTS.includes(endpoint)) {
      return { ok: false, error: { code: 'bad-request', message: 'Unknown Matrix endpoint.' } };
    }
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return { ok: false, error: { code: 'bad-request', message: invalid } };
    try {
      let value;
      if (endpoint === MATRIX_ENDPOINTS.status) value = await controller.status();
      else if (endpoint === MATRIX_ENDPOINTS.bindCredentials) value = await controller.bindCredentials(payload);
      else if (endpoint === MATRIX_ENDPOINTS.reconnectBot) {
        value = await controller.reconnectBot(payload.botId);
        if (signal?.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } };
        }
        if (payload.sendTest === true) {
          let testError = null;
          try {
            if (value?.bots?.find((bot) => bot?.botId === payload.botId)?.ready !== true) {
              const unavailable = new Error('Bot is not connected');
              unavailable.code = 'test-target-unavailable';
              throw unavailable;
            }
            if (typeof controller.sendConnectionTest !== 'function') {
              const unavailable = new Error('Connection test is unavailable');
              unavailable.code = 'test-target-unavailable';
              throw unavailable;
            }
            await controller.sendConnectionTest(payload.botId);
          } catch (error) {
            testError = error;
          }
          value = { ...value, testMessage: publicConnectionTestResult(testError) };
        }
      }
      else if (endpoint === MATRIX_ENDPOINTS.setAlias) {
        if (typeof controller.updateAlias !== 'function') throw new Error('Alias update is unavailable');
        value = await controller.updateAlias(payload.botId, payload.alias);
      }
      else value = await controller.deleteBot(payload.botId);
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: true, value: sanitizePublic(value) };
    } catch (error) {
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: false, error: operationError(error) };
    }
  };
}

export function installMatrixRpc(ctx, controller, authority) {
  return registerManagementRpc(ctx,
    MATRIX_RPC_CHANNEL,
    createMatrixRpcHandler(controller),
    { authority: resolveRpcAuthority(authority) },
  );
}
