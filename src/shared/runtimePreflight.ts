/**
 * Runtime 可用性预检（纯逻辑层）：状态分类、PATH 探测、已知 runtime 的安装指引。
 * 文件系统/引擎访问在主进程 `src/main/runtime/preflight.ts`；本模块保持可注入、可单测。
 *
 * 背景（2026-09-25 全量自检 11 runtime）：gemini CLI 未安装时 sessions_create 照样
 * 成功但终端空屏；runtime 脚本缺失同样静默空屏；opencode/grok 鉴权失败无预警。
 * 预检把「差什么、怎么装」前置到创建时报错与设置页徽标。
 */
import { t } from './i18n';
import { HARNESS_CATALOG } from './harnessCatalog';

export type RuntimePreflightStatus =
  | 'available'
  | 'not_installed'
  | 'not_configured'
  | 'script_missing'
  | 'disabled'
  | 'unknown';

export type RuntimePreflightProblemCode =
  | 'cli_missing'
  | 'script_missing'
  | 'config_missing'
  | 'disabled'
  | 'error';

export interface RuntimePreflightProblem {
  code: RuntimePreflightProblemCode;
  /** 人读的原因描述（已本地化） */
  message: string;
  /** 安装/配置命令或指引（如 `npm install -g @google/gemini-cli`） */
  fix?: string;
  /** fix 的人类说明（如「或从官网安装后确保在 PATH 中」） */
  fixHint?: string;
}

export interface RuntimePreflightResult {
  id: string;
  label?: string;
  /** Discovered executable only; it does not establish authentication or model availability. */
  executable?: string;
  surface: 'pty' | 'chat';
  status: RuntimePreflightStatus;
  ok: boolean;
  problems: RuntimePreflightProblem[];
  checkedAt: number;
}

/** 已知 CLI 的安装命令目录：key = runtime id（builtin 对齐 registry.json） */
export const RUNTIME_CLI_INSTALL: Record<
  string,
  { cli: string[]; installCmd: string; docs?: string }
> = {
  'cursor-cli': {
    cli: ['cursor-agent'],
    installCmd: 'curl -fsS https://cursor.com/install | bash',
    docs: 'https://cursor.com/docs/agent-cli'
  },
  'claude-code': {
    cli: ['claude'],
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    docs: 'https://code.claude.com/docs/en/quickstart'
  },
  opencode: {
    cli: ['opencode'],
    installCmd: 'npm install -g opencode-ai',
    docs: 'https://opencode.ai/docs'
  },
  codex: {
    cli: ['codex'],
    installCmd: 'npm install -g @openai/codex',
    docs: 'https://developers.openai.com/codex/cli/'
  },
  gemini: {
    cli: ['gemini'],
    installCmd: 'npm install -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli'
  }
};

/** chat runtime 的依赖目录（driver probe 用；acp 依赖 ACP agent 的 CLI） */
export const CHAT_RUNTIME_CLI_INSTALL: Record<
  string,
  { cli: string[]; installCmd: string; docs?: string }
> = {
  'codex-gui': {
    cli: ['codex'],
    installCmd: 'npm install -g @openai/codex',
    docs: 'https://developers.openai.com/codex/cli/'
  },
  claude: {
    cli: ['claude'],
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    docs: 'https://code.claude.com/docs/en/quickstart'
  },
  acp: {
    cli: ['opencode', 'gemini'],
    installCmd: 'npm install -g opencode-ai（或 npm install -g @google/gemini-cli）',
    docs: 'https://agentclientprotocol.com'
  }
};

export function cliInstallHint(id: string): {
  cli: string[];
  installCmd: string;
  docs?: string;
} {
  const product = HARNESS_CATALOG.find(entry => entry.cliRuntimeId === id);
  return (
    RUNTIME_CLI_INSTALL[id] ??
    CHAT_RUNTIME_CLI_INSTALL[id] ??
    (product ? { cli: [...product.commands], installCmd: '', docs: product.installUrl } :
      { cli: [], installCmd: '', docs: undefined })
  );
}

/**
 * 在 PATH 中查找可执行文件（纯函数：fs 探测经 opts.exists 注入）。
 * win32 无扩展名的名字按 PATHEXT 逐一尝试；返回首个命中绝对路径。
 */
export function findOnPath(
  names: readonly string[],
  opts: {
    platform?: NodeJS.Platform;
    pathEnv?: string;
    pathExt?: string;
    exists?: (p: string) => boolean;
    join?: (...p: string[]) => string;
  } = {}
): string | null {
  // 缺省值经 typeof 守卫（渲染层也会 import 本模块，不得裸读 process）
  const platform = opts.platform ?? (typeof process !== 'undefined' ? process.platform : 'linux');
  const join = opts.join ?? ((...p: string[]) => p.join('/'));
  const exists = opts.exists ?? (() => false);
  const rawPath = opts.pathEnv ?? (typeof process !== 'undefined' ? process.env.PATH ?? '' : '');
  const dirs = rawPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const rawExt = opts.pathExt ?? (typeof process !== 'undefined' ? process.env.PATHEXT ?? '' : '');
  const exts = platform === 'win32' ? (rawExt || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const name of names) {
      const base = join(dir, name);
      // PATHEXT 探测看的是「名字是否已带扩展名」，不是拼好的全路径——PATH 目录名
      // 带点（C:\Users\john.smith\...、版本号目录）时旧实现按全路径判会漏试
      // claude.cmd/.exe，预检误报 not_installed（P1-4）
      const candidates =
        platform === 'win32' && !name.includes('.') ? exts.map((e) => base + e) : [base];
      for (const c of candidates) {
        if (exists(c)) return c;
      }
    }
  }
  return null;
}

/** 从 resolveLaunch 的结果里取出真实 CLI 命令 token（win 下剥掉 cmd.exe 包装） */
export function extractCliToken(launch: { command: string; args: readonly string[] }): string {
  if (/(?:^|[\\/])cmd(\.exe)?$/i.test(launch.command)) {
    const joined = launch.args.join(' ');
    // winCmdLaunchArgs 形如 ['/d','/s','/c','chcp 65001>nul & <cmdline>']
    const m = joined.match(/&\s*(.*)$/s);
    const cmdline = m?.[1]?.trim() ?? '';
    // 带引号的绝对路径（escapeCmdArg 对含空格参数加引号）：读到闭合引号
    if (cmdline.startsWith('"')) {
      const end = cmdline.indexOf('"', 1);
      return end > 0 ? cmdline.slice(1, end) : cmdline.slice(1);
    }
    return cmdline.split(/\s+/)[0] ?? '';
  }
  return launch.command;
}

/** 设置页徽标：预检结果 → 徽标样式与文案（无结果按未知） */
export function preflightBadgeOf(result: RuntimePreflightResult | undefined): {
  cls: string;
  label: string;
} {
  switch (result?.status) {
    case 'available':
      return { cls: 'on', label: t('可用') };
    case 'not_installed':
      return { cls: 'warn', label: t('未安装') };
    case 'not_configured':
      return { cls: 'warn', label: t('未配置') };
    case 'script_missing':
      return { cls: 'warn', label: t('脚本缺失') };
    case 'disabled':
      return { cls: 'off', label: t('已禁用') };
    default:
      return { cls: 'off', label: t('未知') };
  }
}

/** pty/分类：把探测事实映射成状态与问题列表（纯函数） */
export function classifyPtyPreflight(input: {
  enabled: boolean;
  scriptExists: boolean;
  /** CLI 是否在 PATH 命中；undefined = 无法判定（脚本加载失败等） */
  cliFound?: boolean;
  moduleError?: string;
  installHint?: { installCmd: string; docs?: string };
}): { status: RuntimePreflightStatus; problems: RuntimePreflightProblem[] } {
  const problems: RuntimePreflightProblem[] = [];
  if (!input.enabled) {
    problems.push({ code: 'disabled', message: t('runtime 已禁用') });
    return { status: 'disabled', problems };
  }
  if (!input.scriptExists) {
    problems.push({
      code: 'script_missing',
      message: t('启动脚本文件缺失（可能被误删，设置页「恢复开箱」可还原）'),
      fixHint: t('设置 → Worker 终端 → 恢复开箱')
    });
    return { status: 'script_missing', problems };
  }
  if (input.moduleError) {
    problems.push({ code: 'error', message: t('脚本加载失败：{{message}}', { message: input.moduleError }) });
    return { status: 'unknown', problems };
  }
  if (input.cliFound === false) {
    const hint = input.installHint ?? { installCmd: '', docs: undefined };
    problems.push({
      code: 'cli_missing',
      message: t('依赖的 CLI 未安装或不在 PATH 中'),
      ...(hint.installCmd ? { fix: hint.installCmd } : {}),
      ...(hint.docs ? { fixHint: hint.docs } : {})
    });
    return { status: 'not_installed', problems };
  }
  if (input.cliFound === undefined) {
    return { status: 'unknown', problems };
  }
  return { status: 'available', problems };
}

/** IPC `runtimes:preflight` 回复（preload/设置页共用） */
export interface RuntimePreflightReply {
  ok: boolean;
  results?: RuntimePreflightResult[];
  error?: string;
}

/** 预检未通过的专用错误：调用方据此区分「不可用拒绝」与「预检流程自身异常（放行）」 */
export class RuntimePreflightError extends Error {
  readonly preflight: RuntimePreflightResult;
  constructor(preflight: RuntimePreflightResult) {
    super(describePreflightFailure(preflight));
    this.name = 'RuntimePreflightError';
    this.preflight = preflight;
  }
}

/**
 * 把预检结果拼成创建失败的报错（sessions_create / tasks_delegate 拒绝文案）：
 * 说清「差什么、怎么装/怎么配」，并保留逃生门提示。
 */
export function describePreflightFailure(result: RuntimePreflightResult): string {
  const label = result.label || result.id;
  const lines = result.problems.map((p) => {
    const fix = p.fix ? `；修复：${p.fix}` : p.fixHint ? `；参见：${p.fixHint}` : '';
    return `- ${p.message}${fix}`;
  });
  return [
    t('runtime「{{label}}」不可用（{{status}}），已取消创建：', { label, status: result.status }),
    ...lines,
    t('排查后重试；确要强创可在创建参数传 force:true 跳过预检。')
  ].join('\n');
}

/** Project the host-owned installation hint without changing the preflight result. */
export function localizePreflightFix(fix: string): string {
  return fix === CHAT_RUNTIME_CLI_INSTALL.acp.installCmd
    ? t('npm install -g opencode-ai（或 npm install -g @google/gemini-cli）') : fix;
}

/** Use the structured result for human IPC; model-facing errors keep their original form. */
export function describePreflightFailureForUser(result: RuntimePreflightResult): string {
  const label = result.label || result.id;
  const lines = result.problems.map(problem => {
    const fix = problem.fix ? t('；修复：{{fix}}', { fix: localizePreflightFix(problem.fix) })
      : problem.fixHint ? t('；参见：{{hint}}', { hint: problem.fixHint }) : '';
    return `- ${problem.message}${fix}`;
  });
  return [t('runtime「{{label}}」不可用（{{status}}），已取消创建：', { label, status: result.status }),
    ...lines, t('排查后重试；确要强创可在创建参数传 force:true 跳过预检。')].join('\n');
}
