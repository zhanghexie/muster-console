/**
 * Runtime 可用性预检（主进程编排）：
 * - pty：拉起脚本存在 + 模块可加载 + 依赖 CLI 在 PATH；
 * - chat：driver 注册 + driver.probe（依赖 CLI 存在 / 配置齐备，不 spawn 引擎）。
 * sessions.create / sessions.create 拉起前调用（force=true 可跳过）；设置页徽标共用。
 * 纯分类逻辑在 shared/runtimePreflight.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../../shared/i18n';
import type { RuntimeHost } from './host';
import type { GuiDriverConnectInput, GuiRuntimeProbeResult } from '../agentSession/types';
import type { AppConfig } from '../../shared/types';
import { runtimeSurface } from '../../shared/types';
import { acpAgentEnabled } from '../../shared/acpAgentSettings';
import { collectEnvSecrets, redactSafetyText, safetySecrets } from '../safety/redact';
import {
  classifyPtyPreflight,
  cliInstallHint,
  extractCliToken,
  findOnPath,
  type RuntimePreflightProblem,
  type RuntimePreflightResult,
  type RuntimePreflightStatus
} from '../../shared/runtimePreflight';

const PROBE_SESSION_ID = '__muster_preflight__';

/** Redact known secrets and remove URL credentials/parameters before showing custom-driver hints. */
function safeProbeProblems(problems: RuntimePreflightProblem[], config: AppConfig): RuntimePreflightProblem[] {
  const secrets = [
    ...safetySecrets(config),
    ...collectEnvSecrets(process.env)
  ];
  const redact = (value: string): string => redactSafetyText(value, secrets).slice(0, 2048);
  const hint = (value: string): string => redact(value.replace(/https?:\/\/[^\s<>"']+/gi, candidate => {
    try {
      const url = new URL(candidate);
      if (!url.username && !url.password && !url.search && !url.hash) return candidate;
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return `${url.toString()} (${t('链接中的身份信息或参数已隐藏')})`;
    } catch { return t('无法安全显示链接'); }
  }));
  return problems.map(problem => ({ ...problem, message: redact(problem.message),
    ...(problem.fix ? { fix: redact(problem.fix) } : {}),
    ...(problem.fixHint ? { fixHint: hint(problem.fixHint) } : {}) }));
}

/**
 * 预检依赖（结构化最小面）：ctx 满足；SessionsService 用 late-bound agentSessions 拼同形对象。
 */
export interface PreflightDeps {
  runtimes: RuntimeHost;
  config: { get(): AppConfig };
  agentSessions: { probeRuntime(id: string, piModeId?: string, modelOverride?: GuiDriverConnectInput['modelOverride']): Promise<GuiRuntimeProbeResult> } | null;
}

export async function preflightRuntime(
  deps: PreflightDeps,
  id: string,
  opts: { piModeId?: string; modelOverride?: GuiDriverConnectInput['modelOverride']; inspectDisabledChat?: boolean } = {}
): Promise<RuntimePreflightResult> {
  const ctx = {
    runtimes: deps.runtimes,
    config: deps.config,
    agentSessions: deps.agentSessions
  } as const;
  const entry = ctx.runtimes.get(id);
  const base = {
    id,
    label: entry?.label,
    surface: runtimeSurface(entry),
    checkedAt: Date.now()
  };
  if (!entry) {
    return {
      ...base,
      status: 'unknown',
      ok: false,
      problems: [{ code: 'error', message: t('runtime 未注册: {{id}}', { id }) }]
    };
  }
  // Installation discovery in settings may inspect a disabled built-in GUI
  // driver without making it selectable. Normal preflight still rejects it.
  if (!entry.enabled && !(opts.inspectDisabledChat && entry.builtin && runtimeSurface(entry) === 'chat')) {
    return {
      ...base,
      status: 'disabled',
      ok: false,
      problems: [{ code: 'disabled', message: t('runtime 已禁用（设置页可启用）') }]
    };
  }

  if (runtimeSurface(entry) === 'chat') {
    const runtimeId = entry.manifest?.chat ? 'acp' : id;
    const preset = entry.manifest?.chat ? entry.manifest.id : opts.piModeId;
    if (runtimeId === 'acp' && preset && !opts.inspectDisabledChat && !acpAgentEnabled(ctx.config.get(), preset)) {
      return { ...base, status: 'disabled', ok: false,
        problems: [{ code: 'disabled', message: t('此 Agent 的聊天入口已停用，可在设置中启用。') }] };
    }
    if (!ctx.agentSessions) {
      return {
        ...base,
        status: 'unknown',
        ok: false,
        problems: [{ code: 'error', message: t('GUI 会话宿主未就绪，无法预检') }]
      };
    }
    const probed = await ctx.agentSessions.probeRuntime(runtimeId, preset, opts.modelOverride);
    return { ...base, ...probed, problems: safeProbeProblems(probed.problems ?? [], ctx.config.get()), ok: probed.status === 'available' };
  }

  // ---- pty：脚本 + 模块 + CLI ----
  let scriptExists = false;
  if (entry.manifest?.terminal) scriptExists = true;
  else try {
    scriptExists = fs.existsSync(ctx.runtimes.scriptPath(id));
  } catch {
    scriptExists = false;
  }
  let cliFound: boolean | undefined;
  let executable: string | undefined;
  let moduleError: string | undefined;
  if (scriptExists) {
    try {
      const launch = await ctx.runtimes.resolveLaunch(
        id,
        'start',
        PROBE_SESSION_ID,
        ctx.config.get().workspace,
        entry.extraArgs ?? [],
        undefined,
        true
      );
      const token = extractCliToken(launch);
      cliFound = cliOnPath(token);
      if (cliFound && path.isAbsolute(token)) executable = token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'CLI_NOT_FOUND') cliFound = false;
      else moduleError = (e as Error).message;
    }
  }
  const hint = cliInstallHint(id);
  const classified = classifyPtyPreflight({
    enabled: true,
    scriptExists,
    cliFound,
    moduleError,
    ...(hint.installCmd
      ? { installHint: { installCmd: hint.installCmd, ...(hint.docs ? { docs: hint.docs } : {}) } }
      : {})
  });
  return {
    ...base,
    ...classified,
    ...(executable ? { executable } : {}),
    ok: classified.status === 'available',
    problems: safeProbeProblems(classified.problems, ctx.config.get())
  };
}

/** CLI token 在 PATH / 绝对路径上都可执行？（真 fs 探测） */
export function cliOnPath(token: string): boolean {
  const raw = token.trim();
  if (!raw) return false;
  const stripped = stripQuotes(raw);
  if (path.isAbsolute(stripped)) return fs.existsSync(stripped);
  // 无扩展名的名字由 findOnPath 在 win 下按 PATHEXT 补齐候选
  return findOnPath([stripped], {
    platform: process.platform,
    pathEnv: process.env.PATH ?? '',
    pathExt: process.env.PATHEXT,
    exists: (p) => fs.existsSync(p),
    join: path.join
  }) !== null;
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** 批量预检（设置页徽标 / runtimes.preflight 全量） */
export async function preflightAllRuntimes(
  deps: PreflightDeps
): Promise<RuntimePreflightResult[]> {
  const ids = deps.runtimes.list().map((e) => e.id);
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await preflightRuntime(deps, id);
      } catch (e) {
        const entry = deps.runtimes.get(id);
        const problems: RuntimePreflightProblem[] = [
          { code: 'error', message: t('预检失败：{{message}}', { message: (e as Error).message }) }
        ];
        const status: RuntimePreflightStatus = 'unknown';
        return {
          id,
          label: entry?.label,
          surface: runtimeSurface(entry),
          status,
          ok: false,
          problems,
          checkedAt: Date.now()
        } satisfies RuntimePreflightResult;
      }
    })
  );
  return results;
}
