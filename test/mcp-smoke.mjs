/**
 * 无 Electron：用 Cursor mcp.json 拉起 FeishuProjectMcp（若存在）并 listTools。
 * 用法：node test/mcp-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js';

const cursorPath = path.join(os.homedir(), '.cursor', 'mcp.json');
if (!fs.existsSync(cursorPath)) {
  console.error('no', cursorPath);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(cursorPath, 'utf-8').replace(/^\uFEFF/, ''));
const entry = raw.mcpServers?.FeishuProjectMcp;
if (!entry?.command) {
  console.error('FeishuProjectMcp not found in cursor mcp.json');
  process.exit(1);
}

const command = process.platform === 'win32' && entry.command === 'npx' ? 'npx.cmd' : entry.command;
const client = new Client({ name: 'mcp-smoke', version: '0.0.1' }, {});
const transport = new StdioClientTransport({
  command,
  args: entry.args ?? [],
  env: { ...getDefaultEnvironment(), ...(entry.env ?? {}) },
  stderr: 'pipe'
});

console.log('connecting FeishuProjectMcp…');
await client.connect(transport);
const listed = await client.listTools();
console.log('tools', listed.tools?.length ?? 0);
console.log(
  (listed.tools ?? [])
    .slice(0, 8)
    .map((t) => t.name)
    .join(', '),
  (listed.tools?.length ?? 0) > 8 ? '…' : ''
);
await client.close();
console.log('ok');
