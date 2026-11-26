import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('resources/extensions/daily-report/extension.json', 'utf8'));
const panel = fs.readFileSync('resources/extensions/daily-report/ui/panel.html', 'utf8');
const domain = fs.readFileSync('resources/extensions/daily-report/domain.mjs', 'utf8');
const host = fs.readFileSync('src/main/extensions/extensionHost.ts', 'utf8');
const sdk = fs.readFileSync('src/main/extensions/sdk/extension-sdk.js', 'utf8');
const panelCss = fs.readFileSync('resources/extensions/daily-report/ui/panel.css', 'utf8');
const themeCss = fs.readFileSync('src/main/extensions/sdk/theme.css', 'utf8');
assert.match(panel, /href="panel\.css"/);
const declared = new Set([...`${themeCss}\n${panelCss}`.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
for (const match of panelCss.matchAll(/var\((--[\w-]+)\)/g)) {
  assert.ok(declared.has(match[1]), `daily panel references an undefined theme token: ${match[1]}`);
}

assert.match(manifest.description, /AI/);
assert.deepEqual(manifest.surface, { kind: 'sidebar', entry: 'ui/panel.html', title: '工作日报' });
assert.deepEqual(manifest.agent, { profile: 'scheduler-pi', systemPrompt: 'agent.md', skills: [], mcp: [] });
assert.match(panel, /\.\.\/__sdk__\/sdk\.js/);
assert.match(panel, /AgentChatView|dailyReportDomain/);
assert.match(panel, /state\.changed/);
assert.match(panel, /ma\.agent\.domain\.command/);
assert.match(panel, /refreshFromAgentState\(\)/);
for (const method of ['domain.snapshot', 'domain.query', 'domain.command']) {
  assert.match(host, new RegExp(`[\\'"]${method.replace('.', '\\.')}`), `missing host method ${method}`);
}
for (const method of ['getSnapshot', 'query', 'execute', 'subscribe']) {
  assert.match(domain, new RegExp(`\\b${method}\\b`), `missing generic domain runtime method ${method}`);
}
for (const method of ['snapshot', 'query', 'command']) {
  assert.match(sdk, new RegExp(`domain[\\s\\S]*?${method}`), `missing SDK domain method ${method}`);
}
assert.doesNotMatch(domain, /daily\.snapshot|daily\.query|daily\.command/, 'daily domain must not use a host-specific protocol');
assert.doesNotMatch(host, /assertDailyDomain|createDailyReportRuntime|ext\.daily-report\./, 'host must not contain a daily-specific adapter');

console.log('extensions-daily-agent: ok');
