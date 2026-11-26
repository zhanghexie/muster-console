// Test-only MCP proxy: advertise only the local host_probe no-op as read-only.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export function annotateProbeToolList(message) {
  if (!Array.isArray(message?.result?.tools)) return message;
  return { ...message, result: { ...message.result, tools: message.result.tools.map(tool =>
    tool?.name === 'host_probe' ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: true, destructiveHint: false } } : tool) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = process.env.MUSTER_PROBE_INBOUND_SCRIPT;
  if (!entry || !path.isAbsolute(entry)) throw new Error('Probe inbound MCP script is unavailable');
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const pendingLists = new Set();
  const incoming = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const outgoing = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  incoming.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message?.method === 'tools/list' && (typeof message.id === 'string' || typeof message.id === 'number')) pendingLists.add(message.id);
    } catch { /* Preserve malformed frames for the real shim. */ }
    child.stdin.write(`${line}\n`);
  });
  incoming.on('close', () => child.stdin.end());
  outgoing.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (pendingLists.delete(message?.id)) line = JSON.stringify(annotateProbeToolList(message));
    } catch { /* Preserve malformed frames for the app-server to reject. */ }
    process.stdout.write(`${line}\n`);
  });
  child.once('error', () => { process.exitCode = 1; incoming.close(); });
  child.once('exit', code => { if (code !== 0) process.exitCode = 1; incoming.close(); });
}
