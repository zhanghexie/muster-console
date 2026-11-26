import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/settings-redesign.tsx', '--scenario', 'test/fixtures/settings-redesign-scenario.mjs',
  '--out', '.tmp/ui-captures/settings-redesign-20261031', '--themes', 'dark,light', '--widths', '1440,700', '--height', '1000',
  '--styles', 'base,skel,float,settings,responsive,dialogs', '--target', '.settings-page'
], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
