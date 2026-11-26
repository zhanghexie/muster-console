import { redactCredentialShapes } from '../memory/redact';
const sensitive = /password|passwd|secret|token|authorization|credential|api.?key|private.?key|smtp.?pass/i;
const sensitiveEnv = /TOKEN|SECRET|PASSWORD|API.?KEY|AUTH/i;
/** Collect only non-trivial string values; callers can add protocol-specific key names. */
export function collectEnvSecrets(env: Readonly<Record<string, unknown>>, extraKey?: (name: string) => boolean): string[] {
  return Object.entries(env)
    .filter(([name, value]) => (sensitiveEnv.test(name) || extraKey?.(name)) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value as string);
}
export function safetySecrets(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => { if (!v || typeof v !== 'object') return; for (const [key, item] of Object.entries(v)) { if (sensitive.test(key) && typeof item === 'string' && item) out.push(item); else visit(item); } };
  visit(value); return out;
}
export function redactSafetyText(text: string, secrets: string[] = []): string {
  let clean = redactCredentialShapes(text).text; for (const secret of secrets.sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[REDACTED]'); return clean;
}
export function redactSafetyEvidence<T>(value: T, additionalSecrets: string[] = []): T {
  const secrets = [...safetySecrets(value), ...additionalSecrets];
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSafetyText(v, secrets);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : visit(item)]));
    return v;
  };
  return visit(value) as T;
}
