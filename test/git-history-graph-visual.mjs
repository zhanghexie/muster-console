/** Verify Git history graph painting with the production component and CSS. */
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/git-history-graph.tsx',
  '--scenario', 'test/fixtures/git-history-graph-scenario.mjs',
  '--styles', 'base,git',
  '--target', '.git-history-pane',
  '--out', '.tmp/ui-captures/git-history-graph',
  '--themes', 'dark,light', '--widths', '780,390', '--height', '360'
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
