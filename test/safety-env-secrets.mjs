import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-env-secrets-'));
try {
  const bundle = path.join(tmp, 'redact.cjs');
  buildSync({ entryPoints: ['src/main/safety/redact.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { collectEnvSecrets, redactSafetyText } = createRequire(import.meta.url)(bundle);
  const env = { API_KEY: 'api-value', access_token: 'token-value', AUTH_HEADER: 'auth-value', PASSWORD: '123',
    SECRET: null, AUTH_NUMBER: 1234, BRIDGE_ADDRESS: 'bridge-value', PATH: 'ordinary-value' };
  assert.deepEqual(collectEnvSecrets(env), ['api-value', 'token-value', 'auth-value']);
  const bridge = collectEnvSecrets(env, name => /BRIDGE/i.test(name));
  assert.deepEqual(bridge, ['api-value', 'token-value', 'auth-value', 'bridge-value']);
  assert.equal(redactSafetyText('api-value token-value auth-value bridge-value', bridge), '[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  console.log('safety environment secret collection and bridge redaction passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
