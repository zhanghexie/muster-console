import fs from 'node:fs';
import path from 'node:path';

/** Real RuntimeHost + preflight fixtures; executable presence is not mocked in renderer IPC. */
export function seedAvailableWorkers(project: string, userData: string, options: { labels?: Record<string, string>; includeCustom?: boolean; pi?: boolean } = {}): void {
  const fixture = path.dirname(path.dirname(userData));
  const home = path.join(userData, 'capability-home');
  // Electron resolves Windows shell paths before setupDevSandbox overrides userData.
  for (const directory of [path.join(fixture, 'appdata'), path.join(fixture, 'localappdata'), home,
    path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(directory, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(path.join(project, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  const labels = { 'claude-code': 'Claude Code CLI', codex: 'Codex CLI', 'cursor-cli': 'Cursor CLI', pi: 'Pi GUI / SDK', ...options.labels };
  const enabled = new Set(['claude-code', 'codex', 'cursor-cli', ...(options.pi === false ? [] : ['pi'])]);
  const root = path.join(userData, 'agent-runtimes');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const entry of raw.runtimes) {
    entry.enabled = enabled.has(entry.id);
    entry.label = labels[entry.id as keyof typeof labels] ?? entry.label;
    if ((entry.surface ?? 'pty') === 'pty') {
      // Preserve seed version so startup migration leaves this isolated fixture's script in place.
      fs.writeFileSync(path.join(root, 'scripts', entry.script), workerScript(entry.enabled ? process.execPath : 'metaagent-fixture-missing-cli'));
    }
  }
  if (options.includeCustom) {
    raw.runtimes.push({ id: 'fixture-custom', label: '本地测试工具', surface: 'pty', enabled: true, script: 'fixture-custom.mjs', builtin: false, extraArgs: [], updatedAt: 0 });
    raw.runtimes.push({ id: 'fixture-missing', label: '未安装测试工具', surface: 'pty', enabled: true, script: 'fixture-missing.mjs', builtin: false, extraArgs: [], updatedAt: 0 });
    fs.writeFileSync(path.join(root, 'scripts', 'fixture-custom.mjs'), workerScript(process.execPath));
    fs.writeFileSync(path.join(root, 'scripts', 'fixture-missing.mjs'), workerScript('metaagent-fixture-missing-cli'));
  }
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(raw, null, 2));
}

function workerScript(command: string): string {
  return `export async function allocate(){return {sessionId:'fixture-'+Date.now()};}\nexport function resolveLaunch(){return {command:${JSON.stringify(command)},args:['-e','setInterval(()=>{},1000)']};}\n`;
}

/** Pi probe validates local settings; this endpoint is never contacted by availability checks. */
export const fixtureLlm = {
  activeProviderId: 'fixture', activeModelId: 'fixture-model',
  providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key', enabled: true, api: 'openai-completions', models: [{ id: 'fixture-model', name: 'Fixture model' }] }]
};
