/** Use a real CLI shim to verify the OpenCode layout probe and its isolation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode fixture 中文 '));
const compile = createSharedCompiler(root, path.join(temporary, 'compiled'));
const { probeOpenCodeMcpLayout } = await import(pathToFileURL(compile('main/harnessIntegration/opencodeConfigProbe.ts')));
const windows = process.platform === 'win32';
const command = path.join(temporary, windows ? 'opencode.cmd' : 'opencode');
const oldPath = process.env.PATH;
const oldConfig = process.env.OPENCODE_CONFIG;
const originalConfig = path.join(temporary, 'user.json');
const install = (body) => fs.writeFileSync(command, body, { mode: 0o755 });

try {
  fs.writeFileSync(originalConfig, '{"other":"keep"}');
  process.env.OPENCODE_CONFIG = originalConfig;
  process.env.PATH = `${temporary}${path.delimiter}${oldPath ?? ''}`;
  install(windows
    ? '@echo off\r\nif not "%~1 %~2 %~3"=="--pure debug config" exit /b 42\r\nif not "%~4"=="" exit /b 43\r\ntype "%OPENCODE_CONFIG%"\r\n'
    : '#!/bin/sh\n[ "$*" = "--pure debug config" ] || exit 42\ncat "$OPENCODE_CONFIG"\n');
  assert.equal(await probeOpenCodeMcpLayout(), 'flat');
  assert.equal(fs.readFileSync(originalConfig, 'utf8'), '{"other":"keep"}');

  install(windows ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
  assert.equal(await probeOpenCodeMcpLayout(), 'nested', 'unsupported config command uses the default layout');
  install(windows ? '@echo off\r\necho {"mcp":{"servers":{}}}\r\n' : '#!/bin/sh\nprintf \'{"mcp":{"servers":{}}}\\n\'\n');
  assert.equal(await probeOpenCodeMcpLayout(), 'nested');
  console.log(`opencode-config-probe: ${process.platform} shim, isolated config and default layout passed`);
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = oldConfig;
  fs.rmSync(temporary, { recursive: true, force: true });
}
