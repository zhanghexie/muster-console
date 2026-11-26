/**
 * Windows UTF-8 / 乱码修复单测
 * 运行: node test/win-utf8.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'main', 'encoding', 'winUtf8.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'win-utf8-'));
const outFile = path.join(tmp, 'winUtf8.mjs');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  },
  fileName: entry
});
fs.writeFileSync(outFile, outputText, 'utf8');
const mod = await import(pathToFileURL(outFile).href);

if (process.platform === 'win32') {
  const { spawnSync } = await import('node:child_process');
  const text = '宿主协议中文读取与管道写入';
  const file = path.join(tmp, '中文 sample.txt');
  fs.writeFileSync(file, text, 'utf8');
  const command = `${mod.POWERSHELL_UTF8_BOOT}; Get-Content -LiteralPath '${file.replaceAll("'", "''")}'`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), text, 'PowerShell 5.1 默认读取 UTF-8 无 BOM 文件');
  const writeFile = path.join(tmp, 'pipeline.txt');
  const writeCommand = `${mod.POWERSHELL_UTF8_BOOT}; '${text}' | node -e "process.stdin.pipe(require('fs').createWriteStream(process.argv[1]))" '${writeFile.replaceAll("'", "''")}'`;
  const w = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(writeCommand, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: mod.utf8ChildEnv() });
  assert.equal(w.status, 0, w.stderr);
  assert.equal(fs.readFileSync(writeFile, 'utf8').trim(), text, 'PowerShell 到外部进程的中文管道');
}

{
  const args = mod.winCmdLaunchArgs(['agent', '--resume', 'abc 123']);
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(args[3], /^chcp 65001>nul & /);
  assert.match(args[3], /agent/);
  console.log('ok: winCmdLaunchArgs');
}

{
  // M-12：尾部反斜杠紧贴闭合引号会被 MSVC/Node 的 argv 规则当引号转义吃掉
  // （"C:\dir\" 丢反斜杠留引号）——翻倍保真；并经真实 cmd.exe → node argv 往返验证
  //（还原修复即红）
  assert.equal(mod.escapeCmdArg('C:\\x\\'), '"C:\\x\\\\"', '尾部反斜杠翻倍');
  assert.equal(mod.escapeCmdArg('plain'), 'plain');
  assert.equal(mod.escapeCmdArg('a "b" c'), '"a ""b"" c"');
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process');
    const probe = path.join(tmp, 'argv-probe.mjs');
    fs.writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
    const tail = 'C:\\dir sub\\trail\\';
    // 走生产路径 winCmdLaunchArgs 构造（chcp 前缀保证行首不是引号，避开 cmd /s 剥引号）；
    // windowsVerbatimArguments 防 Node 给整条命令再包一层引号
    const [d, s, c, payload] = mod.winCmdLaunchArgs([process.execPath, probe, tail]);
    const r = spawnSync('cmd.exe', [d, s, c, payload], {
      encoding: 'utf8',
      windowsVerbatimArguments: true
    });
    assert.equal(r.status, 0, `探测进程应成功（stderr: ${r.stderr.slice(0, 200)}）`);
    assert.equal(JSON.parse(r.stdout.trim())[0], tail, 'M-12：真实 cmd→node argv 往返不丢反斜杠');
  }
  console.log('ok: escapeCmdArg 尾部反斜杠（M-12）');
}

{
  const expect = Buffer.from([0xe6, 0x8e, 0x92, 0xe6, 0x9f, 0xa5, 0xe4, 0xb8, 0xad]).toString('utf8');
  const ok = Buffer.from(JSON.stringify({ label: expect }), 'utf8');
  assert.deepEqual(mod.parseJsonBufferFlexible(ok), { label: expect });
  console.log('ok: parse utf8 json');
}

{
  // UTF-8 字节被当成 Latin1 塞进 JS 字符串后再 JSON 序列化发出的典型乱码
  const utf8Bytes = Buffer.from([0xe6, 0x8e, 0x92, 0xe6, 0x9f, 0xa5, 0xe4, 0xb8, 0xad]); // 排查中
  const bad = { label: utf8Bytes.toString('latin1') };
  const repaired = mod.repairUtf8Mojibake(bad.label);
  assert.equal(repaired, utf8Bytes.toString('utf8'));
  const parsed = mod.parseJsonBufferFlexible(Buffer.from(JSON.stringify(bad), 'utf8'));
  assert.equal(parsed.label, utf8Bytes.toString('utf8'));
  console.log('ok: repair latin1 mojibake');
}

{
  // GBK 编码的 JSON（PowerShell 系统代码页发出）——硬编码 GBK 字节，避免 TextEncoder('gbk') 在部分 Node 上落到 UTF-8
  const expect = Buffer.from([0xe6, 0x8e, 0x92, 0xe6, 0x9f, 0xa5, 0xe4, 0xb8, 0xad]).toString('utf8');
  const gbkLabel = Buffer.from([0xc5, 0xc5, 0xb2, 0xe9, 0xd6, 0xd0]); // 排查中
  const prefix = Buffer.from('{"label":"', 'ascii');
  const suffix = Buffer.from('","kind":"active"}', 'ascii');
  const gbkJson = Buffer.concat([prefix, gbkLabel, suffix]);
  const parsed = mod.parseJsonBufferFlexible(gbkJson);
  assert.equal(parsed.label, expect);
  assert.equal(parsed.kind, 'active');
  console.log('ok: parse gbk json body');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('win-utf8: all passed');
