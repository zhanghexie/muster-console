/**
 * Bash 只读分类器阶段 A（S2.3 / T4）：三态 `true|false|unknown`。
 *
 * - `true`    确认只读 → 审批门自动放行/低打扰
 * - `false`   确认非只读（危险 flag/回调或已知写命令）→ 确认流
 * - `unknown` 无法判定 → 确认门（不拒不放）
 *
 * 管道/链式（`;` `|` `&&` `||` `&`）：每段 true 才 true；任一段 false → false；
 * 否则有 unknown → unknown。
 *
 * 命令特定危险检查与 guiWorkerPolicy.isReadOnlyShellCommand 同源合流（防两套分叉）：
 * awk action 块内 > | system 与 -f 外部脚本、sort/tree -o/--output（含 GNU 长选项
 * 前缀 --o*）、sed -i（含聚簇/任意位置）/-f/脚本 w/e、find 写/执行原语、jq env/import、
 * printf 八进制/十六进制/\u、rg --pre、git 危险全局 flag 与 remote/reflog/branch
 * 变更型子命令（含聚簇短 flag）、date -s/--se*、hostname 带参。
 *
 * 防遮蔽纪律（2026-09-27 复审二轮）：
 * - **引号不藏 flag**：`sed "-i"`、`git branch '-D'` 与裸 flag 等价——flag 扫描一律
 *   先过 stripQuotes（剥引号保内容）再查；
 * - **wrapper 不豁免**：env/xargs/nice/time/nohup/stdbuf/timeout 包装的目标命令
 *   同样过全部专项检查（`env sed -i …`、`xargs awk '{system(…)}'` 不因前缀放行）；
 * - tokenizer（splitTopLevelSegments/unquotedTokens）以本文件为单一事实源，
 *   guiWorkerPolicy 复用勿另写。
 */

export type BashReadonlyState = 'true' | 'false' | 'unknown';

// ---------------------------------------------------------------------------
// 数据表
// ---------------------------------------------------------------------------

/** 常见只读命令（无危险 flag 时判 true；带专项检查的命令先走专项） */
const READONLY_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'file', 'stat', 'du', 'wc',
  'grep', 'rg', 'findstr', 'find',
  'sort', 'uniq', 'cut', 'tr', 'column', 'sed', 'awk', 'jq', 'printf', 'fmt',
  'pwd', 'whoami', 'id', 'date', 'uname', 'hostname', 'df', 'free', 'ps',
  'nproc', 'uptime', 'arch',
  'basename', 'dirname', 'realpath', 'readlink', 'which',
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'sum',
  'diff', 'cmp',
  'echo', 'type', 'true', 'false', 'test', 'expr', 'sleep', 'printenv',
  'tree', 'seq', 'env'
]);

/** 已知写/危险命令（作为命令名时判 false） */
const WRITE_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'del', 'rmdir', 'mkdir', 'touch', 'tee', 'dd', 'ln',
  'chmod', 'chown', 'chgrp', 'truncate', 'shred',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'curl', 'wget', 'nc', 'ssh', 'scp', 'rsync',
  'eval', 'source', 'exec',
  'sh', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot',
  'sudo', 'su', 'mount', 'umount'
]);

/** 命令包装器：目标命令决定只读性（env/xargs/time 等；目标同样过专项检查） */
const WRAPPER_COMMANDS = new Set(['env', 'xargs', 'time', 'nice', 'nohup', 'timeout', 'stdbuf']);

/** git 只读子命令（remote/reflog/branch 有专项收紧） */
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'blame',
  'describe', 'cat-file', 'ls-files', 'ls-tree', 'ls-remote', 'rev-list',
  'merge-base', 'check-ignore', 'check-attr', 'count-objects', 'var',
  'version', 'help', 'shortlog', 'reflog', 'cherry'
]);

/** git 危险全局 flag（可注入执行路径/配置） */
const GIT_DANGEROUS_GLOBAL_FLAGS = new Set([
  '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree',
  '--namespace', '--super-prefix'
]);

// ---------------------------------------------------------------------------
// Tokenizer（quote 感知切段 + 未加引号词提取；单一事实源，guiWorkerPolicy 复用）
// ---------------------------------------------------------------------------

/** 读重定向目标 token（可带引号），返回文本与扫描终点 */
export function readRedirectTarget(cmd: string, i: number): { text: string; next: number } | null {
  if (i >= cmd.length) return null;
  const q = cmd[i];
  if (q === "'" || q === '"') {
    const end = cmd.indexOf(q, i + 1);
    if (end === -1) return null;
    const next = end + 1;
    if (next < cmd.length && !/\s/.test(cmd[next])) return null;
    return { text: cmd.slice(i + 1, end), next };
  }
  let j = i;
  while (j < cmd.length && !/\s/.test(cmd[j]) && !'&;|<>'.includes(cmd[j])) j++;
  return j > i ? { text: cmd.slice(i, j), next: j } : null;
}

/**
 * quote 感知按顶层操作符（; | && || & 换行）切段。
 * 检测命令替换 / 进程替换 / 非 /dev/null 重定向 / 引号未闭合等异常 → danger。
 */
function scanCommand(cmd: string): { segments: string[]; danger: boolean } {
  const segments: string[] = [];
  let cur = '';
  const push = (): void => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = '';
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === '\\') {
      cur += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return { segments: [], danger: true };
      cur += cmd.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      cur += '"';
      let j = i + 1;
      let closed = false;
      while (j < cmd.length) {
        if (cmd[j] === '\\') {
          cur += cmd.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (cmd[j] === '"') {
          closed = true;
          break;
        }
        if ((cmd[j] === '$' && cmd[j + 1] === '(') || cmd[j] === '`') return { segments: [], danger: true };
        cur += cmd[j];
        j++;
      }
      if (!closed) return { segments: [], danger: true };
      cur += '"';
      i = j + 1;
      continue;
    }
    if (ch === '`' || (ch === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(')) return { segments: [], danger: true };
    if (ch === '$' && cmd[i + 1] === '(' && cmd[i + 2] === '(') {
      cur += '$((';
      i += 3;
      continue;
    }
    if ((ch === '>' || ch === '<') && cmd[i + 1] === '(') return { segments: [], danger: true };
    if (ch === '<') {
      cur += ch;
      i++;
      continue;
    }
    if (ch === '>') {
      cur = cur.replace(/\d+$/, '');
      i++;
      if (cmd[i] === '>') i++;
      if (cmd[i] === '&') {
        i++;
        if (/\d/.test(cmd[i])) {
          while (i < cmd.length && /\d/.test(cmd[i])) i++;
          continue;
        }
      }
      while (i < cmd.length && cmd[i] === ' ') i++;
      const target = readRedirectTarget(cmd, i);
      if (!target || target.text.toLowerCase() !== '/dev/null') return { segments: [], danger: true };
      i = target.next;
      continue;
    }
    if (ch === '&') {
      if (cmd[i + 1] === '>') {
        i += 2;
        if (cmd[i] === '>') i++;
        while (i < cmd.length && cmd[i] === ' ') i++;
        const target = readRedirectTarget(cmd, i);
        if (!target || target.text.toLowerCase() !== '/dev/null') return { segments: [], danger: true };
        i = target.next;
        continue;
      }
      push();
      i += cmd[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      if (ch === '|' && cmd[i + 1] === '|') i++;
      push();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  push();
  return { segments, danger: false };
}

/** quote 感知切段（异常输入返回 []）；与 guiWorkerPolicy 旧 splitTopLevelSegments 同语义 */
export function splitTopLevelSegments(cmd: string): string[] {
  const { segments, danger } = scanCommand(cmd);
  return danger ? [] : segments;
}

/** 段内未加引号的词（引号内容豁免——grep 'rm' f 的 rm 是匹配模式不是命令） */
export function unquotedTokens(segment: string): string[] {
  const words: string[] = [];
  let cur = '';
  let i = 0;
  let inWord = false;
  const flush = (): void => {
    if (cur) words.push(cur);
    cur = '';
  };
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === '\\') {
      cur += segment[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (ch === '"') {
        let j = i + 1;
        while (j < segment.length) {
          if (segment[j] === '\\') {
            j += 2;
            continue;
          }
          if (segment[j] === '"') break;
          j++;
        }
        i = j >= segment.length ? segment.length : j + 1;
      } else {
        const end = segment.indexOf("'", i + 1);
        i = end === -1 ? segment.length : end + 1;
      }
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) flush();
      inWord = false;
      i++;
      continue;
    }
    cur += ch;
    inWord = true;
    i++;
  }
  flush();
  return words;
}

/**
 * 剥引号保内容，供 flag 扫描（bash 里 `"-i"`、`'-i'`、`$'-i'`、`\-i` 与裸 `-i` 同 argv）：
 * - 引号字符丢弃、内容保留；`$'…'`/`$"…"` 的 `$` 一并丢弃（ANSI-C/locale 引号）；
 * - 引号**外**的反斜杠按 bash 消耗（`\-i` → `-i`）；引号**内**的转义对原样保留
 *   （sed 脚本的 `\/` 等是脚本内容，不是 shell 转义）。
 */
export function stripQuotes(text: string): string {
  let out = '';
  let i = 0;
  let inQuote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (inQuote) {
        out += text.slice(i, i + 2);
      } else {
        out += text[i + 1] ?? '';
      }
      i += 2;
      continue;
    }
    if (!inQuote && ch === '$' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      i++; // $' / $" 的 $ 丢弃，引号由下一轮处理
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (inQuote === ch) inQuote = null;
      else if (!inQuote) inQuote = ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 命令特定危险检查（输入均已 stripQuotes；直接调用与 wrapper 目标共用）
// ---------------------------------------------------------------------------

/** sed 已知只读短 flag（聚簇逐字符查；i=原地 f=外部脚本，见 sedIsDangerous） */
const SED_SAFE_SHORT = 'nerszub';
/** sed 已知只读长 flag；未知长/短 flag 保守拒（对齐旧 guiWorkerPolicy 语义） */
const SED_SAFE_LONG = new Set([
  '--quiet', '--silent', '--posix', '--regexp-extended', '--null-data',
  '--binary', '--separate', '--unbuffered', '--lazy', '--sandbox',
  '--debug', '--help', '--version'
]);

const SED_WRITE_RE = /(^|[^a-z\\])[we]([^a-z]|$)/;

/** 脚本文本（无引号形态）的 w/e 判定：s/y 掩码 + flags 专项 + 边界查 */
function sedScriptTextDangerous(script: string): boolean {
  if (!script) return false;
  let out = '';
  let k = 0;
  while (k < script.length) {
    const ch = script[k]!;
    const d = script[k + 1];
    if ((ch === 's' || ch === 'y') && d && /[^\sa-zA-Z0-9\\]/.test(d)) {
      let m = k + 2;
      let found = 0;
      while (m < script.length && found < 2) {
        if (script[m] === '\\') {
          m += 2;
          continue;
        }
        if (script[m] === d) found++;
        m++;
      }
      if (found === 2) {
        out += ch + '   ';
        let flags = '';
        while (m < script.length && /[a-z]/.test(script[m]!)) {
          flags += script[m]!;
          m++;
        }
        if (flags.startsWith('w') || flags.includes('e')) return true;
        k = m;
        continue;
      }
    }
    out += ch;
    k++;
  }
  return SED_WRITE_RE.test(out);
}

/**
 * sed 危险判定。输入为该 sed 命令起头的**已剥引号**段子（stripQuotes 后）。
 * - `-i`（含聚簇 -ni/-in，任意位置——GNU getopt 可重排到脚本之后）、`--in-place*` → 原地改写
 * - `-f` / `--file*` 外部脚本（静态不可见）→ 拒
 * - `--expression=` 形态整段保守查 w/e
 * - 脚本 token 内 w/e 命令（s/y 掩码后判定，flags 专项查胶着文件名）
 * - 未知 flag 保守拒；`-e` 胶着值（-es/a/b/）按脚本续查
 */
function sedIsDangerous(dq: string): boolean {
  const lower = dq.trim().toLowerCase();
  const body = lower === 'sed' ? '' : lower.replace(/^sed(\s+|$)/, '');
  if (!body) return false;
  if (/(^|\s)--expression(=|\s)/.test(body)) return SED_WRITE_RE.test(body);
  const tokens = body.split(/\s+/).filter(Boolean);
  // 第一遍：flag 扫描（任意位置——GNU getopt 可重排，`sed 's/a/b/' f -i` 的尾部 -i 照样生效）
  let scriptToken: string | null = null;
  for (const t of tokens) {
    if (scriptToken === null && !t.startsWith('-')) {
      scriptToken = t; // 首个非 flag token = 脚本；其余非 flag token 是文件名（不查）
    }
    if (t.startsWith('--')) {
      if (t === '--in-place' || t.startsWith('--in-place=') || t.startsWith('--file')) return true;
      if (!SED_SAFE_LONG.has(t)) return true; // 未知长 flag 保守拒
      continue;
    }
    if (t.length > 1 && t.startsWith('-')) {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k]!;
        if (ch === 'i' || ch === 'f') return true;
        if (ch === 'e') {
          // -e 的胶着值即脚本：续查 w/e
          if (sedScriptTextDangerous(t.slice(k + 1))) return true;
          break;
        }
        if (!SED_SAFE_SHORT.includes(ch)) return true; // 未知短 flag 保守拒
      }
    }
  }
  // 第二遍：脚本 token 的 w/e 判定（error.log 之类文件名不进）
  return scriptToken !== null && sedScriptTextDangerous(scriptToken);
}

/** find：写/执行原语 */
function findIsDangerous(dq: string): boolean {
  return /\s-(delete|exec(dir)?|ok(dir)?|fprintf|fls|fprint0?)(\s|$)/.test(dq.toLowerCase());
}

/** jq：env/import/include（原始文本含引号内容） */
function jqIsDangerous(dq: string): boolean {
  return /\b(env|import|include)\b/.test(dq.toLowerCase().replace(/^jq\s+/, ''));
}

/** printf：八进制/十六进制/\u 转义（可构造任意字节序列） */
function printfIsDangerous(dq: string): boolean {
  return (
    /\\[0-7]{1,3}/.test(dq) ||
    /\\x[0-9a-f]{1,2}/i.test(dq) ||
    /\\u[0-9a-f]{4}/i.test(dq)
  );
}

/** awk：action 块 {} 内 >、|、system；-f/--file 外部脚本（静态不可见） */
function awkIsDangerous(dq: string): boolean {
  const lower = dq.trim().toLowerCase();
  if (!lower.startsWith('awk')) return false;
  for (const t of lower.split(/\s+/).slice(1)) {
    if (t.startsWith('--file')) return true;
    if (t.length > 1 && t.startsWith('-') && !t.startsWith('--')) {
      for (const ch of t.slice(1)) {
        if (ch === 'f') return true;
        if (ch === 'e') break; // -e 胶着程序文本（可见，交给 action 块检查）
      }
    }
  }
  const actions = lower.match(/\{[^}]*\}/g)?.join('') ?? '';
  return />|\||\bsystem\b/.test(actions);
}

/** sort/tree：-o / --output（含聚簇 -ro 与 GNU 长选项前缀 --o*）输出覆写目标文件 */
function hasOutputFlag(dq: string): boolean {
  for (const t of dq.trim().split(/\s+/)) {
    if (!t.startsWith('-') || t.length < 2) continue;
    if (t.startsWith('--')) {
      if (t.startsWith('--o')) return true;
      continue;
    }
    if (t.slice(1).includes('o')) return true;
  }
  return false;
}

/** rg：--pre 为每个文件启动预处理器进程（--pre sh 即任意执行） */
function rgIsDangerous(dq: string): boolean {
  return /(^|\s)--pre(=|\s|$)/.test(dq.trim());
}

/** date：-s / --set（含 GNU 前缀 --se*）改系统时钟 */
function dateIsDangerous(dq: string): boolean {
  for (const t of dq.trim().split(/\s+/).slice(1)) {
    if (t === '-s' || t.startsWith('--se')) return true;
  }
  return false;
}

/** hostname：带参即设置主机名（裸 hostname 只读） */
function hostnameIsDangerous(dq: string): boolean {
  return dq.trim().split(/\s+/).length > 1;
}

/** git：危险全局 flag / 变更型子命令（remote·reflog·branch 专项收紧，聚簇短 flag 认得） */
function gitIsDangerous(dq: string): boolean {
  const lower = dq.trim().toLowerCase();
  const tokens = lower.split(/\s+/);
  for (const t of tokens.slice(1)) {
    if (!t.startsWith('-')) continue;
    const flag = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
    if (GIT_DANGEROUS_GLOBAL_FLAGS.has(flag)) return true;
  }
  const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
  const sub = args[0];
  if (!sub) return false;
  if (sub === 'branch') {
    // 聚簇短 flag（-Df/-df/-fu…）与变更型长 flag
    if (/\s-[^-\s]*[dDmMcCuf][^-\s]*(\s|$)/.test(lower)) return true;
    if (/--(delete|move|copy|edit-description|set-upstream-to|track)\b/.test(lower)) return true;
    return false;
  }
  if (sub === 'remote') {
    const rest = args.slice(1);
    if (!rest.length) return false;
    const head = rest[0]!;
    return !(head === 'show' || head === 'get-url');
  }
  if (sub === 'reflog') {
    const rest = args.slice(1);
    if (!rest.length) return false;
    const head = rest[0]!;
    if (head === 'show' || head === 'exists') return false;
    if (head === 'expire' || head === 'delete') return true;
    return false;
  }
  if (sub === 'diff' || sub === 'log' || sub === 'show') {
    return /--output(=|\s)/.test(lower);
  }
  return false;
}

/**
 * 命令级危险检查（直接调用与 wrapper 目标共用）。
 * dq = 从该命令词起头、已 stripQuotes 的段子。返回 true = 有写/执行原语。
 */
export function commandFlagDangerous(cmd: string, dq: string): boolean {
  const c = cmd.toLowerCase();
  if (c === 'sed') return sedIsDangerous(dq);
  if (c === 'find') return findIsDangerous(dq);
  if (c === 'jq') return jqIsDangerous(dq);
  if (c === 'printf') return printfIsDangerous(dq);
  if (c === 'awk') return awkIsDangerous(dq);
  if (c === 'sort' || c === 'tree') return hasOutputFlag(dq);
  if (c === 'rg') return rgIsDangerous(dq);
  if (c === 'date') return dateIsDangerous(dq);
  if (c === 'hostname') return hostnameIsDangerous(dq);
  if (c === 'git') return gitIsDangerous(dq);
  return false;
}

/** 按命令名分类（含专项检查；wrapper 目标与裸命令同权） */
function classifyCommand(cmd: string, dq: string): BashReadonlyState {
  if (WRITE_COMMANDS.has(cmd)) return 'false';
  if (commandFlagDangerous(cmd, dq)) return 'false';
  if (cmd === 'git') {
    // git：危险面已查，剩余按子命令表定 true/unknown
    const tokens = dq.trim().toLowerCase().split(/\s+/);
    const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const sub = args[0];
    if (!sub) return 'unknown';
    if (sub === 'remote' || sub === 'reflog' || sub === 'branch') return 'true';
    if (GIT_READONLY_SUBCOMMANDS.has(sub)) return 'true';
    return 'unknown';
  }
  if (READONLY_COMMANDS.has(cmd)) return 'true';
  return 'unknown';
}

/** 从 wrapper 命令参数中找目标命令（第一个非 flag、非赋值、非纯数字的词——
 * 纯数字是 timeout 的时长实参，不是命令） */
function findWrapperTarget(tokens: string[]): string | null {
  for (const t of tokens.slice(1)) {
    if (t.startsWith('-')) continue;
    if (/^\d+$/.test(t)) continue;
    if (t.includes('=') && !t.startsWith('=')) continue;
    return t.toLowerCase();
  }
  return null;
}

function isWrapperCmd(cmd: string): boolean {
  return cmd === 'xargs' || cmd === 'env' || WRAPPER_COMMANDS.has(cmd);
}

/**
 * 逐层剥 wrapper（`env env sed -i`、`xargs env sort -o`、`nice env …`）：
 * 返回最终目标命令的 token 起点下标；无目标（env 裸调/xargs 无命令）返回 'no-target'；
 * 超过 8 层仍没剥到非 wrapper 命令返回 'too-deep'（fail-closed）。
 */
function unwrapCommandTokens(tokens: string[]): number | 'no-target' | 'too-deep' {
  let scanFrom = 0;
  for (let depth = 0; depth < 8; depth++) {
    const head = tokens[scanFrom]?.toLowerCase();
    if (!head) return 'no-target';
    if (!isWrapperCmd(head)) return scanFrom;
    if (head === 'xargs') {
      // xargs 的目标位直接写命令（`xargs rm`）：按写命令名拦
      for (const t of tokens.slice(scanFrom + 1)) {
        if (WRITE_COMMANDS.has(t.toLowerCase())) return -1; // 命中写命令，调用方判 false
      }
    }
    const target = findWrapperTarget(tokens.slice(scanFrom));
    if (!target) return 'no-target';
    const found = tokens.findIndex((t, i) => i > scanFrom && t.toLowerCase() === target);
    if (found <= scanFrom) return 'too-deep';
    scanFrom = found;
  }
  return 'too-deep';
}

/**
 * ask/plan 只读门用的段级危险检查（guiWorkerPolicy.isReadOnlySegment 消费）：
 * 引号剥除 + wrapper 逐层剥（`sed -n "-i" …`、`git branch '-D'`、`env env sed -i …`
 * 不得因引号/前缀穿透只读门）。
 */
export function segmentHasDangerousCommandFlag(rawSegment: string): boolean {
  const dq = stripQuotes(rawSegment.trim());
  const tokens = dq.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const cmd = tokens[0].toLowerCase();
  if (!isWrapperCmd(cmd)) return commandFlagDangerous(cmd, dq);
  const unwrapped = unwrapCommandTokens(tokens);
  if (unwrapped === 'no-target') return false;
  if (unwrapped === 'too-deep') return true; // 深层嵌套 wrapper 保守判危险
  if (unwrapped === -1) return true; // xargs 目标位写命令
  const head = tokens[unwrapped]!.toLowerCase();
  return commandFlagDangerous(head, tokens.slice(unwrapped).join(' '));
}

// ---------------------------------------------------------------------------
// 段分类 + 主入口
// ---------------------------------------------------------------------------

function classifySegment(raw: string): BashReadonlyState {
  const dq = stripQuotes(raw.trim());
  const tokens = dq.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 'unknown';
  const cmd = tokens[0].toLowerCase();

  if (WRITE_COMMANDS.has(cmd)) return 'false';

  // wrapper（env/xargs/time/nice/nohup/timeout/stdbuf）：逐层剥到目标命令，
  // 目标起头的段子同样过全部专项检查（`env env sed -i`、`xargs awk '{system}'` 不因前缀放行）
  if (isWrapperCmd(cmd)) {
    const unwrapped = unwrapCommandTokens(tokens);
    if (unwrapped === 'no-target') return 'true';
    if (unwrapped === 'too-deep') return 'unknown';
    if (unwrapped === -1) return 'false'; // xargs 目标位写命令
    const head = tokens[unwrapped]!.toLowerCase();
    return classifyCommand(head, tokens.slice(unwrapped).join(' '));
  }

  return classifyCommand(cmd, dq);
}

/**
 * 分类 bash 命令：只读 `true` / 非只读 `false` / 无法判定 `unknown`。
 * 管道/链式组合：每段 true 才 true；任一段 false → false；否则有 unknown → unknown。
 */
export function classifyBashReadonly(command: string): BashReadonlyState {
  const trimmed = command.trim();
  if (!trimmed) return 'unknown';
  const scan = scanCommand(trimmed);
  if (scan.danger) return 'false';
  if (!scan.segments.length) return 'unknown';
  let result: BashReadonlyState = 'true';
  for (const seg of scan.segments) {
    const s = classifySegment(seg);
    if (s === 'false') return 'false';
    if (s === 'unknown') result = 'unknown';
  }
  return result;
}
