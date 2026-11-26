import { afterEach, expect, it } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';
import { cliInstallHint, RuntimePreflightError } from '../../../src/shared/runtimePreflight';
import { localizeSessionUserError } from '../../../src/main/sessions/userErrors';

afterEach(() => applyLocaleSetting('zh-CN'));

it('localizes preflight instructions at the user boundary while retaining the original error', () => {
  const fix = cliInstallHint('acp').installCmd;
  const original = new RuntimePreflightError({ id: 'acp', label: 'ACP', surface: 'chat', status: 'not_installed', ok: false, checkedAt: 1,
    problems: [{ code: 'cli_missing', message: '原始检测细节', fix }] });
  const stored = original.message;
  applyLocaleSetting('en');
  let shown: Error | undefined;
  try { localizeSessionUserError(original); } catch (error) { shown = error as Error; }
  expect(shown?.message).toContain('Fix: npm install -g opencode-ai (or npm install -g @google/gemini-cli)');
  expect(shown?.message).toContain('原始检测细节');
  expect(shown?.cause).toBe(original);
  expect((shown as RuntimePreflightError).preflight).toBe(original.preflight);
  expect(original.message).toBe(stored);
});
