#!/usr/bin/env node
/**
 * T5.2 假 ACP agent（JSON-RPC NDJSON over stdio）。
 * env ACP_FAKE_SCENARIO = text | tools | perm | commands | auth | noload
 */
import readline from 'node:readline';

const scenario = process.env.ACP_FAKE_SCENARIO || 'text';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function notifyUpdate(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

const pending = new Map();

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.result !== undefined || msg.error) {
    const w = pending.get(String(msg.id));
    if (w) {
      pending.delete(String(msg.id));
      w(msg);
    }
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: scenario !== 'noload',
          promptCapabilities: { image: true }
        },
        agentInfo: { name: 'fake-acp', version: '0' },
        authMethods: scenario === 'grok-usage' ? [{ id: 'cached_token', name: 'cached' }] : scenario === 'auth' ? [{ id: 'login', name: 'login' }] : []
      }
    });
    return;
  }
  if (method === 'authenticate') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'session/new' || method === 'session/load') {
    send({ jsonrpc: '2.0', id, result: { sessionId: params?.sessionId || 'acp-sess-1' } });
    if (scenario === 'commands') {
      notifyUpdate('acp-sess-1', {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: '压缩上下文' },
          { name: 'init', description: '初始化' }
        ]
      });
      notifyUpdate('acp-sess-1', {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'code',
        name: 'Code'
      });
    }
    return;
  }
  if (method === 'session/prompt') {
    const sid = params?.sessionId || 'acp-sess-1';
    void runPrompt(id, sid);
    return;
  }
  if (method === 'session/cancel') return;
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } });
}

async function runPrompt(id, sid) {
  if (scenario === 'grok-usage') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 80, size: 1000 } } });
    send({ jsonrpc: '2.0', method: 'session/update', _meta: { totalTokens: 900 }, params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 900, size: 1000, _meta: { 'cognition.ai/subagent_context': {} } } } });
  } else if (scenario === 'tools') {
    notifyUpdate(sid, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'read',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'README.md' }
    });
    notifyUpdate(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: 'ok'
    });
    notifyUpdate(sid, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '读完了' }
    });
  } else if (scenario === 'perm' || scenario === 'perm-unknown') {
    const permId = 9001;
    const answered = new Promise((resolve) => pending.set(String(permId), resolve));
    send({
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: {
        sessionId: sid,
        options: [
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }
        ],
        toolCall: {
          toolCallId: 'tc-perm',
          title: scenario === 'perm-unknown' ? 'unknown_tool' : 'execute',
          kind: 'execute',
          rawInput: { command: 'rm -rf /' }
        }
      }
    });
    await answered;
    notifyUpdate(sid, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '已按审批继续' }
    });
  } else {
    notifyUpdate(sid, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '想一下' }
    });
    notifyUpdate(sid, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '你好 ACP' }
    });
  }
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    /* ignore */
  }
});
rl.on('close', () => process.exit(0));
