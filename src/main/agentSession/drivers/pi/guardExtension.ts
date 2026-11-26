/**
 * Pi 模式守卫扩展：把自定义模式的 guards 配置接到 tool_call 钩子上做引擎级硬拦截。
 * - bashReadOnly：bash 只读白名单（复用 isReadOnlyShellCommand，与 ask/plan 同源）；
 * - bashAllow：bash 放行正则（与 bashReadOnly 并存时 OR——只读或命中放行即可；
 *   链式命令逐段全称判定，每段都需命中，见 bashAllowedByGuards）；
 * - bashDeny：命令黑名单（正则），命中即 block（在白名单判定之后）；
 * - denyPaths：写路径保护（子串，不区分大小写），write/edit 的 path 命中即 block。
 * 拦截先于审批扩展（工厂排在 extensionFactories 首位）：守卫拒绝不弹审批卡，
 * 模型直接看到拒绝理由。
 */
import { isReadOnlyShellCommand, splitTopLevelSegments } from '../../../../shared/guiWorkerPolicy';

interface GuardToolCallEvent {
  toolName?: unknown;
  input?: { command?: unknown; path?: unknown } & Record<string, unknown>;
}

export interface PiModeGuards {
  bashDeny?: string[];
  denyPaths?: string[];
  /** true = bash 仅放行只读命令（与 ask/plan 白名单同源） */
  bashReadOnly?: boolean;
  /** bash 额外放行正则（如 test/typecheck/build）；与 bashReadOnly OR；链式命令逐段判定 */
  bashAllow?: string[];
}

/** 编译守卫规则；非法正则跳过并记 warn（落盘前已校验，此处兜底手工改文件的情况） */
export function compilePiModeGuards(guards: PiModeGuards | undefined, log?: (msg: string) => void): {
  bashDeny: Array<{ pattern: string; re: RegExp }>;
  bashAllow: Array<{ pattern: string; re: RegExp }>;
  denyPaths: string[];
  bashReadOnly: boolean;
} {
  const bashDeny: Array<{ pattern: string; re: RegExp }> = [];
  for (const pattern of guards?.bashDeny ?? []) {
    try {
      // 命令大小写在 Windows 上等价（RM -RF 与 rm -rf 同效），硬守卫必须不区分大小写
      bashDeny.push({ pattern, re: new RegExp(pattern, 'i') });
    } catch (e) {
      log?.(`模式守卫 bashDeny 正则不可编译，已跳过「${pattern}」: ${(e as Error).message}`);
    }
  }
  const bashAllow: Array<{ pattern: string; re: RegExp }> = [];
  for (const pattern of guards?.bashAllow ?? []) {
    try {
      bashAllow.push({ pattern, re: new RegExp(pattern, 'i') });
    } catch (e) {
      log?.(`模式守卫 bashAllow 正则不可编译，已跳过「${pattern}」: ${(e as Error).message}`);
    }
  }
  // 路径分隔符归一（\ → /）：data\secrets 不能绕开 data/secrets 规则
  const denyPaths = (guards?.denyPaths ?? []).map((p) => p.toLowerCase().replace(/\\/g, '/'));
  return { bashDeny, bashAllow, denyPaths, bashReadOnly: guards?.bashReadOnly === true };
}

/** bash 是否被模式守卫白名单放行（只读 ∪ bashAllow；二者皆无则不设白名单门槛）。
 * 链式命令（&&/||/;/&/|/换行）按顶层切段后**逐段全称**判定：每一段都须命中（只读判定 ∪
 * bashAllow 模式），任一段不命中即拒——放行正则只锚定段首，不能整链放行
 * （堵 `npm test && rm -rf dist` 击穿）。切段失败（引号未闭合/命令替换等）一律拒。 */
function bashAllowedByGuards(
  command: string,
  compiled: { bashReadOnly: boolean; bashAllow: Array<{ re: RegExp }> }
): boolean {
  if (!compiled.bashReadOnly && compiled.bashAllow.length === 0) return true;
  const segments = splitTopLevelSegments(command.trim());
  if (!segments.length) return false;
  return segments.every(
    (seg) =>
      (compiled.bashReadOnly && isReadOnlyShellCommand(seg)) ||
      compiled.bashAllow.some(({ re }) => re.test(seg))
  );
}

/** 构造守卫扩展工厂（挂 tool_call 钩子；无规则时不装） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPiGuardExtension(
  guards: PiModeGuards | undefined,
  log?: (msg: string) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  const compiled = compilePiModeGuards(guards, log);
  const { bashDeny, bashAllow, denyPaths, bashReadOnly } = compiled;
  if (!bashDeny.length && !denyPaths.length && !bashReadOnly && !bashAllow.length) return null;
  return (pi: {
    on: (event: string, handler: (event: GuardToolCallEvent) => unknown) => void;
  }) => {
    pi.on('tool_call', (event) => {
      const name = String(event.toolName ?? '');
      // M-2：无 Git Bash 时 driver 把 bash 换成 pi 自带 powershell（工具面替换），守卫
      // 必须同时认两个名字——只判 bash 会让 powershell 任意命令绕过硬守卫
      if ((name === 'bash' || name === 'powershell') && typeof event.input?.command === 'string') {
        const command = event.input.command;
        if (!bashAllowedByGuards(command, compiled)) {
          return {
            block: true,
            reason: bashReadOnly && bashAllow.length
              ? '命令未命中模式守卫白名单（只读或 test/typecheck/build），已拦截'
              : bashReadOnly
                ? '命令未命中模式守卫只读白名单，已拦截'
                : '命令未命中模式守卫放行白名单，已拦截'
          };
        }
        for (const { pattern, re } of bashDeny) {
          if (re.test(command)) {
            return { block: true, reason: `命令命中模式守卫黑名单（/${pattern}/），已拦截` };
          }
        }
      }
      if ((name === 'write' || name === 'edit') && typeof event.input?.path === 'string') {
        const pathLower = event.input.path.toLowerCase().replace(/\\/g, '/');
        for (const seg of denyPaths) {
          if (pathLower.includes(seg)) {
            return { block: true, reason: `路径命中模式守卫保护（包含「${seg}」），已拦截` };
          }
        }
      }
      return undefined;
    });
  };
}
