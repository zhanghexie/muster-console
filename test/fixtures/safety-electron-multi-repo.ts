/** Isolated Electron main-process fixture; the only model endpoint is a local test server. */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSafetyGitEvidenceCollector } from '../../src/main/safety/evidence';
import { createSafetyPiReviewer } from '../../src/main/safety/pi';
import { createSafetyService } from '../../src/main/safety/service';
import type { AppConfig } from '../../src/shared/types';

const directory = process.env.SAFETY_ELECTRON_FIXTURE_DIR;
const port = Number(process.env.SAFETY_ELECTRON_FIXTURE_PORT);
if (!directory || !Number.isInteger(port) || port < 1) throw new Error('Invalid isolated safety fixture');
const userData = path.join(directory, 'userData');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

void app.whenReady().then(async () => {
  const diff = `diff --git a/fixture.ts b/fixture.ts\n--- a/fixture.ts\n+++ b/fixture.ts\n@@ -1 +1 @@\n-old\n+${'fixture content '.repeat(40)}\n`;
  const parts = { diff, workingDiff: '', stagedDiff: '', commits: 'fixture commit' };
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const repo = (root: string) => ({ root, sourceRef: 'feature', targetRef: 'main', source: 'source', target: 'target',
    status: { files: [] }, untrackedFiles: [], tests: 'unavailable: fixture',
    ...Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, { sha256: hash(value), text: value, truncated: false }])) });
  const collector = createSafetyGitEvidenceCollector();
  collector.capture('session', 'fixture-tree', parts); collector.capture('session', 'fixture-main', parts);
  const gitEvidence = collector.finish(JSON.stringify({ sessions: [{ session: { id: 'session', name: 'Fixture' },
    repositories: [repo('fixture-tree'), repo('fixture-main')] }] }));
  const config = { llm: { activeProviderId: 'fixture', activeModelId: 'fixture', providers: [{
    id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'fixture-only', models: [{ id: 'fixture', contextWindow: 32000 }],
  }] } } as unknown as AppConfig;
  const reviewer = createSafetyPiReviewer({ config: () => config, directory });
  let humanCalls = 0;
  const safety = createSafetyService({ userDataPath: userData, reviewer, humanConfirm: async () => { humanCalls++; return false; } });
  try {
    const result = await safety.authorize({ workspaceId: 'fixture', source: 'catalog', action: 'sessions.integrateWorktree',
      args: { sessionId: 'session' }, gitEvidence });
    const state = safety.snapshot('fixture');
    process.stdout.write(`SAFETY_FIXTURE_RESULT=${JSON.stringify({ allowed: result.allowed, reason: result.reason,
      humanCalls, status: state.records[0]?.status })}\n`);
  } finally { safety.dispose(); reviewer.dispose?.(); collector.clear(); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
