import readline from 'node:readline';

const scenario = process.env.CURSOR_ACP_FAKE_SCENARIO || '';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const modeOption = currentValue => ({ id: 'mode', name: 'Cursor Mode', category: '_native-modes', type: 'select', currentValue,
  options: [{ group: 'modes', name: 'Session modes', options: ['agent', 'plan', 'ask', 'architect-v2'].map(value => ({ value, name: value })) }] });
const config = (current, value = false) => [modeOption(current), { id: 'native_toggle', name: 'Native toggle', type: 'boolean', currentValue: value }];
const updateConfig = (sessionId, configOptions) => ({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions } } });
let promptId;
let questionResult;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (msg.method === 'session/load' && scenario === 'load-fails') return send({ id: msg.id, error: { code: -32602, message: 'Invalid params' } });
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    if (scenario === 'early-config') send(updateConfig('cursor-session', config('architect-v2')));
    return send({ id: msg.id, result: { sessionId: 'cursor-session',
      ...(scenario === 'legacy' ? { modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'architect-v2', name: 'Architect' }] } }
        : { configOptions: config('agent') }), models: { currentModelId: 'model', availableModels: [{ modelId: 'model', name: 'Model' }] } } });
  }
  if (msg.method === 'session/set_config_option') {
    const { value, configId, type } = msg.params;
    if (configId === 'native_toggle' && type !== 'boolean') return send({ id: msg.id, error: { code: -32602, message: 'Boolean type missing' } });
    if (scenario === 'full-update') {
      process.stdout.write([updateConfig('wrong-session', config('ask')), { id: msg.id, result: { configOptions: config(value) } },
        updateConfig('cursor-session', [])].map(item => JSON.stringify({ jsonrpc: '2.0', ...item })).join('\n') + '\n');
      return;
    }
    return send({ id: msg.id, result: { configOptions: config(configId === 'native_toggle' || scenario === 'bad-mode' ? 'agent' : value, configId === 'native_toggle' ? value : false) } });
  }
  if (msg.method === 'session/set_mode') {
    send({ id: msg.id, result: {} });
    return send({ method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'current_mode_update', currentModeId: msg.params.modeId } } });
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    return send({ id: 'ask', method: 'cursor/ask_question', params: { questions: [{ id: 'q1', prompt: 'Choose', options: [
      { id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], allowMultiple: false }] } });
  }
  if (msg.id === 'ask' && (msg.result || msg.error)) {
    questionResult = msg.result ?? msg.error;
    if (scenario === 'cancel') return;
    return send({ id: 'plan', method: 'cursor/create_plan', params: { name: 'Review plan', plan: '1. Inspect\n2. Implement' } });
  }
  if (msg.id === 'plan' && (msg.result || msg.error)) {
    send({ method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: JSON.stringify({ question: questionResult, plan: msg.result ?? msg.error }) } } } });
    return send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
  if (msg.method === 'session/cancel' && promptId) return send({ id: promptId, result: { stopReason: 'cancelled' } });
});
