/** Real Chromium checks for English reset dialog overflow in production CSS. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/chat-reset-i18n.tsx',
  '--scenario', 'test/fixtures/chat-reset-i18n-scenario.mjs',
  '--out', '.tmp/ui-captures/chat-reset-i18n',
  '--themes', 'light,dark', '--widths', '780,390,320',
  '--styles', 'base,dialogs', '--target', '.confirm-modal'
], { cwd: root, stdio: 'inherit', timeout: 60_000 });
