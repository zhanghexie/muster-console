import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cliLaunch } from './_native.mjs';
import { filterExtraArgs } from './_helpers.mjs';

/** Session-owned MCP transport: do not write the Pi directory also used by the scheduler. */
export function piHostMcpLaunch(input, binary) {
  const bootstrap = input.env?.MUSTER_INBOUND_MCP_LAUNCH;
  if (input.mode !== 'start') throw new Error(`${binary} CLI adapter cannot restore or fork a native conversation`);
  if (!bootstrap || input.probe) return cliLaunch([binary, ...filterExtraArgs(input.extraArgs ?? [])]);
  const launch = JSON.parse(bootstrap);
  if (typeof launch.command !== 'string' || !Array.isArray(launch.args)) throw new Error('Invalid host MCP bootstrap');
  return { ...cliLaunch([binary, '--extension', fileURLToPath(import.meta.url), ...filterExtraArgs(input.extraArgs ?? [])]),
    env: { MUSTER_INBOUND_MCP_LAUNCH: bootstrap } };
}

export default async function hostMcpExtension(api) {
  const raw = process.env.MUSTER_INBOUND_MCP_LAUNCH;
  if (!raw) throw new Error('Muster MCP launch identity is missing');
  const launch = JSON.parse(raw);
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, closed = false;
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const fail = error => { for (const task of pending.values()) task.reject(error); pending.clear(); };
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.once('exit', (code, signal) => { closed = true; fail(new Error(`Host MCP exited (${code ?? signal})`)); process.removeListener('exit', close); });
  // Drain diagnostics without mixing them into the terminal transcript or protocol stream.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), task = pending.get(message.id);
      if (!task) return;
      if (message.error) task.reject(new Error(message.error.message || 'Host MCP request failed'));
      else task.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Host MCP connection is closed'));
    if (signal?.aborted) return reject(new Error('Host MCP request cancelled'));
    const id = ++sequence;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); };
    const finish = callback => value => { cleanup(); callback(value); };
    const abort = () => { send({ method: 'notifications/cancelled', params: { requestId: id } }); finish(reject)(new Error('Host MCP request cancelled')); };
    const timer = setTimeout(() => { send({ method: 'notifications/cancelled', params: { requestId: id } }); finish(reject)(new Error('Host MCP request timed out')); }, method === 'tools/call' ? 120000 : 15000);
    pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
    signal?.addEventListener('abort', abort, { once: true });
    send({ id, method, params });
  });
  const close = () => {
    process.removeListener('exit', close);
    if (closed) return;
    closed = true; lines.close(); fail(new Error('Host MCP connection closed'));
    child.stdin.end(); child.kill();
  };
  process.once('exit', close);
  api.on('session_shutdown', close);
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'muster-pi-cli', version: '1' } });
    send({ method: 'notifications/initialized' });
    let cursor;
    const names = new Set();
    do {
      const listed = await request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(listed.tools)) throw new Error('Host MCP returned an invalid tool list');
      for (const tool of listed.tools) {
        if (typeof tool.name !== 'string' || names.has(tool.name) || !tool.inputSchema) throw new Error('Host MCP returned invalid or duplicate tools');
        names.add(tool.name);
        api.registerTool({ name: tool.name, label: tool.name, description: tool.description || tool.name, parameters: tool.inputSchema, loadMode: 'essential',
          async execute(_id, args, signal) {
            const result = await request('tools/call', { name: tool.name, arguments: args }, signal);
            if (result.isError) throw new Error((result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Host MCP tool failed');
            return { content: result.content, details: result.structuredContent ?? {} };
          } });
      }
      cursor = listed.nextCursor;
      if (names.size > 256 || (cursor && listed.tools.length === 0)) throw new Error('Host MCP tool pagination exceeded its bound');
    } while (cursor);
  } catch (error) { close(); throw error; }
}
