import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'resources/cli/install.ps1');
const source = fs.readFileSync(script, 'utf8');
assert.match(fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8'), /customInstall[\s\S]*install\.ps1/);
assert.match(fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8'), /customUnInstall[\s\S]*-Action Uninstall/);
assert.match(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'), /out\/main\/cliRuns\/\*\*/);
assert.match(source, /ELECTRON_RUN_AS_NODE=1/); assert.ok(!source.includes('setx '));
if (process.platform !== 'win32') { console.log('CLI installer static contracts passed; PowerShell lifecycle test requires Windows'); process.exit(0); }
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-cli-install-'));
const quote = value => `'${value.replaceAll("'", "''")}'`;
try {
  const packageDir = path.join(temp, 'Packaged App 中文');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'resources/app.asar.unpacked/out/main/cliRuns'), { recursive: true });
  try { fs.linkSync(process.execPath, path.join(packageDir, 'MusterConsole.exe')); }
  catch { fs.copyFileSync(process.execPath, path.join(packageDir, 'MusterConsole.exe')); }
  fs.writeFileSync(path.join(packageDir, 'resources/app.asar.unpacked/out/main/cliRuns/entry.mjs'), 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE})); process.exitCode=7;');
  const foreign = path.join(temp, 'foreign command'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'muster.cmd'), '@echo foreign');
  const owned = path.join(temp, 'owned command'); fs.mkdirSync(owned); fs.writeFileSync(path.join(owned, 'muster.cmd'), '@rem Muster Console CLI launcher v1\r\n@echo off');
  const testScript = path.join(temp, 'test.ps1');
  fs.writeFileSync(testScript, `\uFEFF. ${quote(script)}
[IO.File]::WriteAllText(${quote(path.join(packageDir, 'bin/muster.cmd'))}, (Get-MusterLauncherContent), [Text.Encoding]::ASCII)
$parseTokens = $null; $parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$bin = 'C:/User Folder/MusterConsole/bin'
$added = Update-MetaAgentUserPath '%USERPROFILE%/tools;C:/Windows' $bin $false
$again = Update-MetaAgentUserPath $added $bin $false
$dedup = Update-MetaAgentUserPath ('C:/Windows;' + $bin.ToUpper() + ';"' + $bin + '"') $bin $false
$removed = Update-MetaAgentUserPath $again $bin $true
$other = Update-MetaAgentUserPath ($bin + ';C:/Other') 'C:/Different/bin' $true
@{ added = $added; again = $again; dedup = $dedup; removed = $removed; other = $other; foreign = (Find-MusterCommandConflict ${quote(foreign)} ${quote(owned)}); owned = (Test-MusterOwnedLauncher ${quote(path.join(owned, 'muster.cmd'))}); safe = (Find-MusterCommandConflict ${quote(owned)} ${quote(owned)}) } | ConvertTo-Json -Compress
`);
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', testScript], { encoding: 'utf8', windowsHide: true }));
  assert.equal(result.added, '%USERPROFILE%/tools;C:/Windows;C:/User Folder/MusterConsole/bin'); assert.equal(result.added, result.again);
  assert.equal(result.dedup, 'C:/Windows;C:/User Folder/MusterConsole/bin');
  assert.equal(result.removed, '%USERPROFILE%/tools;C:/Windows');
  assert.equal(result.other, 'C:/User Folder/MusterConsole/bin;C:/Other');
  assert.equal(result.foreign, path.join(foreign, 'muster.cmd')); assert.equal(result.owned, true); assert.equal(result.safe, null);
  assert.equal(fs.readFileSync(path.join(foreign, 'muster.cmd'), 'utf8'), '@echo foreign');
  const launcher = path.join(packageDir, 'bin/muster.cmd');
  assert.ok(!fs.readFileSync(launcher, 'utf8').includes('\r\r\n'), 'launcher has canonical CRLF');
  let launched;
  try { execFileSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" --text "中文 with spaces""`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }); }
  catch (error) { launched = error; }
  assert.equal(launched.status, 7, 'launcher preserves CLI exit code');
  assert.deepEqual(JSON.parse(launched.stdout), { args: ['--text', '中文 with spaces'], nodeMode: '1' });
  console.log('CLI installer: syntax, spaces, expandable PATH, install/upgrade dedup, uninstall ownership and foreign-command preservation passed (no environment mutation)');
} finally { assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temp, { recursive: true, force: true }); }
