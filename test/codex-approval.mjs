import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-approval-'));
const compile = createSharedCompiler(root, tmp);
const { codexNativeApproval, codexNativeConfig, codexNativeStartOverrides, readCodexConfigCatalog } =
  await import(pathToFileURL(compile('main/agentSession/drivers/codex/nativeConfig.ts')).href);

try {
  const calls = [];
  const catalog = await readCodexConfigCatalog(async (method, params) => {
    calls.push([method, params]);
    if (method === 'permissionProfile/list') return params.cursor
      ? { data: [{ id: ':workspace', allowed: true }, { id: ':danger-full-access', allowed: false }] }
      : { data: [{ id: ':read-only', description: 'Native read-only profile', allowed: true }], nextCursor: 'second' };
    if (method === 'collaborationMode/list') return { data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }] };
    return { requirements: { allowedApprovalPolicies: ['on-request', 'never'] } };
  }, tmp);
  assert.deepEqual(calls.map(([method]) => method), ['permissionProfile/list', 'permissionProfile/list', 'collaborationMode/list', 'configRequirements/read']);
  assert.deepEqual(codexNativeStartOverrides(catalog, []), {}, 'follow default omits native overrides');
  const selections = [
    { id: 'permissions', value: ':workspace' }, { id: 'approvalPolicy', value: 'on-request' },
    { id: 'approvalsReviewer', value: 'auto_review' }, { id: 'collaborationMode', value: 'plan' }
  ];
  assert.deepEqual(codexNativeStartOverrides(catalog, selections), { permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
  assert.deepEqual(codexNativeStartOverrides(catalog, [selections.at(-1)]), {}, 'collaboration mode is applied independently after thread start');
  assert.throws(() => codexNativeStartOverrides(catalog, [{ id: 'permissions', value: ':danger-full-access' }]), /did not advertise/);
  const granular = { granular: { mcp_elicitations: true, rules: false, sandbox_approval: true } };
  const sandbox = { type: 'workspaceWrite', writableRoots: [tmp], networkAccess: false };
  const snapshot = codexNativeConfig(catalog, { activePermissionProfile: { id: ':workspace' }, approvalPolicy: granular,
    approvalsReviewer: 'user', collaborationMode: { mode: 'plan' }, sandboxPolicy: sandbox });
  assert.deepEqual(Object.fromEntries(snapshot.options.map(option => [option.id, option.currentValue])), {
    permissions: ':workspace', approvalPolicy: JSON.stringify(granular), approvalsReviewer: 'user', collaborationMode: 'plan', sandboxPolicy: JSON.stringify(sandbox)
  });
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } };
  const approval = codexNativeApproval('item/commandExecution/requestApproval', { availableDecisions: ['decline', amendment, 'acceptForSession'] });
  assert.deepEqual(approval.map(choice => choice.result.decision), ['decline', amendment, 'acceptForSession']);
  assert.deepEqual(approval.map(choice => choice.view.scope), ['once', 'persistent', 'session']);
  const permissions = { network: { enabled: true } };
  const grants = codexNativeApproval('item/permissions/requestApproval', { permissions });
  assert.deepEqual(grants[1].result, { permissions, scope: 'session' });
  console.log('ok: Codex native profile, review, policy and collaboration fields and approval decisions');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
