/** Packaged MCP gateway smoke test; no external agent service. */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';
import path from 'node:path';
const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);
test('packaged executable starts the MCP shim as Node and invokes a gateway tool', async () => {
  const executable = process.env.MUSTER_REGISTRATION_PACKAGED_EXE;
  test.skip(!executable, 'Runs during local packaged acceptance');
  if (!executable || !path.isAbsolute(executable) || !executable.includes(path.join('.tmp', 'packaged')))
    throw new Error('Expected this task local packaged executable');
  const entry = path.join(path.dirname(executable), 'resources/app.asar.unpacked/out/main/inboundMcp/stdioEntry.mjs');
  expect(fs.existsSync(entry)).toBe(true);
  let invoked = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      invoked = body.token === 'packaged-test-token' && body.name === 'sessions_setStatus';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'packaged gateway reached' }], isError: false }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  const transport = new StdioClientTransport({ command: executable, args: [entry], env: {
    ...env, ELECTRON_RUN_AS_NODE: '1', MUSTER_HOST_TOOLS_PRESET: 'gui-full',
    MUSTER_HOST_TOOLS_URL: `http://127.0.0.1:${port}/invoke`, MUSTER_HOST_TOOLS_TOKEN: 'packaged-test-token'
  } });
  const client = new Client({ name: 'packaged-registration-test', version: '1' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.some(t => t.name === 'runtimes_registerDriver')).toBe(false);
    const response = await client.callTool({ name: 'sessions_setStatus', arguments: { phase: 'done' } });
    expect(JSON.stringify(response)).toContain('packaged gateway reached');
    expect(invoked).toBe(true);
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
