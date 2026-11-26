import fs from 'node:fs';
import readline from 'node:readline';
if (process.argv[2] === '--session') {
  fs.writeFileSync(process.env.KIMI_TEST_TUI_LOG, JSON.stringify(process.argv.slice(2)));
  process.stdout.write('Kimi fixture ready\n');
  process.stdin.resume();
} else {
const scenario = process.env.KIMI_TEST_SCENARIO || 'ok';
let model = 'provider/one', thinking = 'high', mode = 'default';
const log = message => fs.appendFileSync(process.env.KIMI_TEST_LOG, JSON.stringify(message) + '\n');
function state() {
  return { configOptions: [
    { type: 'select', id: 'model', category: 'model', currentValue: model, options: [{ value: 'provider/one' }, { value: 'provider/two' }] },
    { type: 'select', id: 'thinking', category: 'thought_level', currentValue: thinking, options: [{ value: 'low' }, { value: 'high' }] },
    { type: 'select', id: 'mode', category: 'mode', currentValue: mode, options: [{ value: 'default' }, { value: 'plan' }] }
  ] };
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); log(request);
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: 2, agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } };
  if (request.method === 'session/new') result = { sessionId: 'session_test', ...state() };
  if (request.method === 'session/set_config_option') {
    if (request.params.configId === 'model') model = request.params.value;
    if (request.params.configId === 'thinking' && scenario !== 'refuse') thinking = request.params.value;
    if (request.params.configId === 'mode') mode = request.params.value;
    result = state();
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
}
