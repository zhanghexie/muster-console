/** Stable, unambiguous identity for the provider/model pair of an external Pi. */
const PREFIX = 'pi-rpc:v1:';

export interface ExternalPiModelIdentity {
  providerId: string;
  modelId: string;
}

function validPart(value: unknown): value is string {
  return typeof value === 'string' && !!value && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function externalPiModelKey(providerId: string, modelId: string): string {
  if (!validPart(providerId) || !validPart(modelId)) throw new Error('外部 Pi 模型身份无效');
  return `${PREFIX}${encodeURIComponent(JSON.stringify([providerId, modelId]))}`;
}

export function parseExternalPiModelKey(value: string): ExternalPiModelIdentity | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const pair: unknown = JSON.parse(decodeURIComponent(value.slice(PREFIX.length)));
    if (!Array.isArray(pair) || pair.length !== 2 || !validPart(pair[0]) || !validPart(pair[1])) return null;
    return externalPiModelKey(pair[0], pair[1]) === value ? { providerId: pair[0], modelId: pair[1] } : null;
  } catch { return null; }
}
