/**
 * Windows 控制台 / PowerShell 中文乱码的根治辅助。
 *
 * 根因：ConPTY 默认跟系统 ANSI 代码页（中文 Windows 多为 936/GBK），
 * node-pty 按 UTF-8 解码；PowerShell 5.1 的 Invoke-* -Body 也常按系统页发出。
 */

/** 给子进程的 UTF-8 相关环境变量（全平台可设，非 Windows 无害） */
export function utf8ChildEnv(
  base: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) env[k] = v;
  }
  env.PYTHONUTF8 = env.PYTHONUTF8 || '1';
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
  // 部分 Node/CLI 尊重；不覆盖用户已设值
  if (!env.LANG) env.LANG = 'C.UTF-8';
  if (!env.LC_ALL) env.LC_ALL = 'C.UTF-8';
  return env;
}

/** PowerShell 5.1 / pwsh 交互会话启动时强制 UTF-8（-NoExit -Command） */
export const POWERSHELL_UTF8_BOOT = [
  'chcp 65001 | Out-Null',
  '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = [Console]::OutputEncoding',
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'"
].join('; ');

/** cmd.exe 启动参数：先切 65001 再留在交互提示符 */
export const CMD_UTF8_ARGS = ['/d', '/k', 'chcp 65001>nul'] as const;

/**
 * Windows 下经 cmd 拉起 Agent CLI：先 chcp 再执行，使 ConPTY 以 UTF-8 解释子进程写出的原始字节。
 */
export function winCmdLaunchArgs(cliArgs: string[]): string[] {
  const inner = cliArgs.map(escapeCmdArg).join(' ');
  return ['/d', '/s', '/c', `chcp 65001>nul & ${inner}`];
}

export function escapeCmdArg(arg: string): string {
  arg = String(arg).replace(/[\r\n]+/g, ' ');
  if (arg.length === 0) return '""';
  // 仅纯 ASCII 安全字符才裸着走；含空格、cmd 元字符、盘符冒号、非 ASCII 一律加引号。
  // M-12：尾部反斜杠紧贴闭合引号会被 MSVC/Node 的 argv 规则当引号转义吃掉
  // （"C:\dir\" 丢反斜杠、留引号），须翻倍保真；%VAR% 在 cmd 双引号内仍会展开，
  // 引内无转义可用，属已知边界（与 runtime/builtins/scripts/_helpers.mjs 同步维护）
  if (/^[A-Za-z0-9_.=/-]+$/.test(arg)) return arg;
  const escaped = arg.replace(/"/g, '""');
  const tail = escaped.match(/\\+$/);
  return tail
    ? `"${escaped.slice(0, escaped.length - tail[0].length)}${tail[0].repeat(2)}"`
    : `"${escaped}"`;
}

/** UTF-8 被当成 Latin1 读入后的典型乱码 → 还原 */
export function repairUtf8Mojibake(text: string): string {
  if (!text) return text;
  const hasHigh = /[\u0080-\u00FF]/.test(text);
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  // 已有汉字则多半是正常 UTF-8；无高位字节则无需修
  if (!hasHigh || hasCjk) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    if (repaired.includes('\uFFFD') || repaired === text) return text;
    if (/[\u4e00-\u9fff]/.test(repaired) || /[，。！？、；：]/.test(repaired)) return repaired;
  } catch {
    /* ignore */
  }
  return text;
}

function scoreDecodedJson(value: unknown): number {
  const s = JSON.stringify(value);
  let score = 0;
  const cjk = s.match(/[\u4e00-\u9fff]/g);
  if (cjk) score += cjk.length * 3;
  // Latin1 乱码特征（UTF-8 中文被当 Latin1）
  const mojibake = s.match(/[\u00C0-\u00FF]{2,}/g);
  if (mojibake) score -= mojibake.join('').length;
  if (s.includes('\uFFFD')) score -= 50;
  return score;
}

function deepRepairStrings(value: unknown): unknown {
  if (typeof value === 'string') return repairUtf8Mojibake(value);
  if (Array.isArray(value)) return value.map(deepRepairStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRepairStrings(v);
    }
    return out;
  }
  return value;
}

function tryDecode(buf: Buffer, encoding: string): string | null {
  try {
    if (encoding === 'utf8' || encoding === 'utf-8') return buf.toString('utf8');
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return null;
  }
}

/** Bounded child stderr tails: valid UTF-8 first, then Windows legacy code pages. */
export function decodeChildOutput(buf: Buffer): string {
  try { return repairUtf8Mojibake(new TextDecoder('utf-8', { fatal: true }).decode(buf)); }
  catch {
    if (process.platform === 'win32') {
      for (const encoding of ['gb18030', 'gbk']) {
        const decoded = tryDecode(buf, encoding);
        if (decoded !== null && !decoded.includes('\uFFFD')) return decoded;
      }
    }
    return buf.toString('utf8');
  }
}

/**
 * 解析 HTTP JSON 体：优先 UTF-8（含 Latin1 乱码修复）；
 * 仅当 UTF-8 无效/含 �/仍像未修复乱码时，再试 GBK/GB18030。
 */
export function parseJsonBufferFlexible(buf: Buffer): unknown {
  if (!buf.length) return {};

  let utf8Result: unknown | undefined;
  let utf8Err: Error | null = null;
  try {
    utf8Result = deepRepairStrings(JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')));
    if (!hasReplacementChar(utf8Result) && !looksLikeUnresolvedMojibake(utf8Result)) {
      return utf8Result;
    }
  } catch (e) {
    utf8Err = e as Error;
  }

  let best: { value: unknown; score: number } | null = null;
  let lastErr: Error | null = utf8Err;
  for (const enc of ['gb18030', 'gbk']) {
    const text = tryDecode(buf, enc);
    if (text == null) continue;
    try {
      const value = deepRepairStrings(JSON.parse(text.replace(/^\uFEFF/, '')));
      if (hasReplacementChar(value)) continue;
      const score = scoreDecodedJson(value);
      if (!best || score > best.score) best = { value, score };
    } catch (e) {
      lastErr = e as Error;
    }
  }

  if (best) return best.value;
  if (utf8Result !== undefined) return utf8Result;
  throw new Error(`JSON 解析失败: ${lastErr?.message ?? '无法按 UTF-8/GBK 解码'}`);
}

function hasReplacementChar(value: unknown): boolean {
  return JSON.stringify(value).includes('\uFFFD');
}

/** 仍是 Latin1 高位乱码、且没有汉字 → 可能该试 GBK */
function looksLikeUnresolvedMojibake(value: unknown): boolean {
  const s = JSON.stringify(value);
  return /[\u0080-\u00FF]/.test(s) && !/[\u4e00-\u9fff]/.test(s);
}
