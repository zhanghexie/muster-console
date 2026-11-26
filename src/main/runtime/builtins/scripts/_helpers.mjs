/** Windows：.cmd shim 须经 cmd.exe；先 chcp 65001 再启动，避免 ConPTY 中文乱码 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** argv / TTY 只带这一行；正文在文件里。Windows cmd 与 npm `.cmd` 的 `%*` 都不能扛 `|`、换行、JSON 引号。 */
export const INJECT_PROMPT_PREFIX = '请使用 UTF-8 编码读取并立即执行任务文件：';

export function injectPromptDir() {
  return join(os.tmpdir(), 'muster-injects');
}

export function injectFileFromPromptArg(promptArg) {
  const s = String(promptArg ?? '');
  if (!s.startsWith(INJECT_PROMPT_PREFIX)) return '';
  return s.slice(INJECT_PROMPT_PREFIX.length);
}

/** 任意提示词（含一行短句）一律落盘，返回短指令。与 src/main/pty/injectFile.ts 同契约。 */
export function writeInjectPrompt(prompt, dir = injectPromptDir()) {
  const text = String(prompt ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return { file, promptArg: `${INJECT_PROMPT_PREFIX}${file}` };
}

/** 把 prompt 落盘后把短指令推进 extraArgs（`--` + 请阅读文件：path）。 */
export function appendCliPrompt({ prompt, extraArgs, dir }) {
  const written = writeInjectPrompt(prompt, dir);
  if (!written) return true;
  extraArgs.push('--', written.promptArg);
  return true;
}

function escapeCmdArg(arg) {
  // cmd /c 在第一个未转义换行处截断整条命令；argv 里绝不能留 \n
  arg = String(arg).replace(/[\r\n]+/g, ' ');
  if (arg.length === 0) return '""';
  // 仅纯 ASCII 安全字符才裸着走；含空格、cmd 元字符、盘符冒号、非 ASCII 一律加引号。
  // M-12：尾部反斜杠须翻倍（"C:\dir\" 的 \" 会被 argv 规则当转义引号）；
  // %VAR% 在双引号内仍被 cmd 展开，引内无转义可用，属已知边界（与
  // src/main/encoding/winUtf8.ts 的 escapeCmdArg 同步维护）
  if (/^[A-Za-z0-9_.=/-]+$/.test(arg)) return arg;
  const escaped = arg.replace(/"/g, '""');
  const tail = escaped.match(/\\+$/);
  return tail
    ? `"${escaped.slice(0, escaped.length - tail[0].length)}${tail[0].repeat(2)}"`
    : `"${escaped}"`;
}

function winCmdLaunchArgs(cliArgs) {
  const inner = cliArgs.map(escapeCmdArg).join(' ');
  return ['/d', '/s', '/c', `chcp 65001>nul & ${inner}`];
}

export function filterExtraArgs(extraArgs) {
  return extraArgs.filter(Boolean);
}

/** Managed restarts own the native conversation and working directory. */
export function assertManagedTerminalArgs({ mode, newConversation, probe }, args, cli, selectors) {
  if (probe || (mode !== 'resume' && !newConversation)) return;
  for (const arg of args) {
    if (arg === '--') return;
    const flag = arg.split('=', 1)[0];
    if (selectors.includes(flag)) {
      throw new Error(`${cli}: remove ${flag} from the runtime arguments before restoring or starting a conversation from the workbench`);
    }
  }
}

export function wrapWinCmd(cliArgs, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: winCmdLaunchArgs(cliArgs), windowsVerbatimArguments: true };
  }
  return { command: cliArgs[0], args: cliArgs.slice(1) };
}

// ---------- 状态 hooks（P2：权威信号通道）----------

/** 命令标记：识别「我们装的」hook，卸载只删自己的条目 */
export const HOOK_MARKER = 'muster-hook-v1';

/**
 * 拼装 hook 命令：node "<脚本>" muster-hook-v1 <activity> <event>。
 * 双引号包路径：cmd 与 POSIX sh 都按字面处理反斜杠。
 * _agent-hook.mjs 与本文件同目录（ensureHelperScripts 已拷入 userData scripts/）。
 */
export function agentHookCommand(activity, event) {
  const script = fileURLToPath(new URL('./_agent-hook.mjs', import.meta.url));
  return `node "${script}" ${HOOK_MARKER} ${activity} ${event}`;
}

/** 读 JSON：不存在/损坏/非对象一律从空对象开始（合并写保护用户已有内容） */
export function readJsonLoose(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 合并写 JSON（同目录先 mkdir；未知键由调用方保留） */
export function writeJsonFile(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
