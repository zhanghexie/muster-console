/** Production composer + CLI geometry, including the narrow workflow and flipped popup. */
import { spawnSync } from 'node:child_process';

const capture = '.agents/skills/ui-verification/scripts/capture-component.mjs';
const cases = [
  { name: 'composer', fixture: 'test/fixtures/session-reminders-visual.tsx',
    scenario: 'test/fixtures/session-reminders-visual-scenario.mjs',
    styles: 'base,float,terminal,agent-chat,session-reminders,chat,workflow',
    out: '.tmp/ui-captures/session-reminders-composer' },
  { name: 'CLI composer', fixture: 'test/fixtures/session-reminders-cli-visual.tsx',
    scenario: 'test/fixtures/session-reminders-cli-visual-scenario.mjs',
    styles: 'base,float,terminal,agent-chat,session-reminders,chat',
    out: '.tmp/ui-captures/session-reminders-cli-composer' }
];
for (const item of cases) {
  const result = spawnSync(process.execPath, [capture, '--fixture', item.fixture, '--scenario', item.scenario,
    '--target', '.session-reminder-trigger', '--styles', item.styles, '--out', item.out,
    '--themes', 'light,dark', '--widths', '780,390', '--height', '720'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${item.name} visual checks failed (${result.status})`);
}
