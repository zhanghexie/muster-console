/** MCP stdio channel endpoint. Stdout is exclusively JSON-RPC. */
import { createInterface } from 'node:readline';
import { jsonRequest, pause } from './_native.mjs';

const base = process.env.MUSTER_CHANNEL_URL;
const headers = { Authorization: `Bearer ${process.env.MUSTER_CHANNEL_TOKEN ?? ''}` };
let started = false;
const sent = new Set();
const write = value => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
});
async function listen() {
  while (true) {
    try {
      const item = await jsonRequest(`${base}/next`, { headers, timeout: 35_000 });
      if (!item?.id) continue;
      if (!sent.has(item.id)) {
        await write({ jsonrpc: '2.0', method: 'notifications/claude/channel',
          params: { content: item.text, meta: { message_id: item.id } } });
        sent.add(item.id);
      }
      await jsonRequest(`${base}/ack`, { method: 'POST', body: { id: item.id }, headers });
    } catch (error) {
      // Parent disposal is terminal; never survive indefinitely as an orphan MCP process.
      if (error.code === 'ECONNREFUSED') process.exit(0);
      process.stderr.write(`Muster channel: ${error.message}\n`);
      await pause(250);
    }
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      await write({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'muster-mailbox', version: '1.0.0' },
      } });
    } else if (request.method === 'notifications/initialized' && !started) {
      started = true;
      void listen();
    } else if (request.method === 'ping') {
      await write({ jsonrpc: '2.0', id: request.id, result: {} });
    } else if (request.id !== undefined) {
      await write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    }
  })().catch(error => process.stderr.write(`Muster channel protocol: ${error.message}\n`));
}).on('close', () => process.exit(0));
