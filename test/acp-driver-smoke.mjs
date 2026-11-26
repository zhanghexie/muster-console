/**
 * ACP GUI driver 在线冒烟（T5.2）：本机 opencode/gemini ACP CLI。
 * 不进 npm test（test/run.mjs EXCLUDE）。
 * 运行: node test/acp-driver-smoke.mjs
 *
 * 人工验证清单（无 CLI 时本脚本 skip）：
 * 1. 安装 OpenCode 或 Gemini CLI 并完成厂商 login
 * 2. 工作台新建「ACP」GUI 会话，引擎选 OpenCode 或 Gemini
 * 3. 发一条消息，应出现聊天气泡而非「未找到可执行文件」
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function lookOnPath(names) {
  const raw = process.env.PATH ?? '';
  const dirs = raw.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const name of names) {
      const base = path.join(dir, name);
      const candidates =
        process.platform === 'win32' && !path.extname(name) ? exts.map((e) => base + e) : [base];
      for (const c of candidates) {
        try {
          if (fs.existsSync(c)) return c;
        } catch {
          /* skip */
        }
      }
    }
  }
  return null;
}

const presets = [
  { name: 'OpenCode', commands: ['opencode', 'opencode.exe'], args: ['acp'] },
  { name: 'Gemini CLI', commands: ['gemini', 'gemini.exe'], args: ['--acp'] }
];

let found = null;
for (const p of presets) {
  const command = lookOnPath(p.commands);
  if (command) {
    found = { ...p, command };
    break;
  }
}
if (!found) {
  console.log('[skip] 未找到 opencode/gemini，人工验证：安装对应 CLI 后重跑本脚本');
  process.exit(0);
}

console.log(`探测到 ${found.name}: ${found.command} ${found.args.join(' ')}`);
const child = spawn(found.command, found.args, {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
const line =
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'muster-acp-smoke', version: '0' },
      clientCapabilities: {}
    }
  }) + '\n';
let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  out += c;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  out += c;
});
child.stdin.write(line);
const timer = setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}, 8000);
await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);
if (!/jsonrpc|protocolVersion|"result"/i.test(out)) {
  console.error('initialize 无 JSON-RPC 响应:\n', out.slice(0, 800));
  process.exit(1);
}
console.log('[ok] acp-driver-smoke initialize 有响应');
process.exit(0);
