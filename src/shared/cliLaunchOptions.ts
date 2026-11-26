/** Per-session CLI options. The values are vendor-specific, never shell fragments. */
import type { RuntimeManifest } from './runtimeManifest';
export interface CliLaunchOptions {
  model?: string;
  permission?: string;
  mode?: string;
  reasoning?: string;
}

export const CLI_LAUNCH_OPTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    model: { type: 'string' }, reasoning: { type: 'string' }, permission: { type: 'string' }, mode: { type: 'string' }
  }
};

export interface CliChoice { value: string; label: string; args: readonly string[] }
export interface CliCapabilities {
  model?: boolean;
  modelHint?: string;
  permissions?: readonly CliChoice[];
  modes?: readonly CliChoice[];
  modeLabel?: string;
  reasoning?: { flag: string; levels: readonly string[]; dynamic?: boolean };
  /** Extra global arguments that conflict with an explicit choice. */
  permissionFlags?: Readonly<Record<string, boolean>>;
  modeFlags?: Readonly<Record<string, boolean>>;
}

const choice = (value: string, label: string, ...args: string[]): CliChoice => ({ value, label, args });
const model = { model: true } as const;
const auto = [choice('--auto', '--auto', '--auto')];
const autoFlags = { '--auto': false };
const caps: Record<string, CliCapabilities> = {
  codex: { ...model, permissions: [
    choice('untrusted', 'untrusted', '--ask-for-approval', 'untrusted'),
    choice('on-request', 'on-request', '--ask-for-approval', 'on-request'),
    choice('never', 'never', '--ask-for-approval', 'never'),
    choice('--approve-for-me', '--approve-for-me', '--approve-for-me'),
    choice('--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-approvals-and-sandbox')
  ], permissionFlags: { '--ask-for-approval': true, '-a': true, '--approve-for-me': false, '--dangerously-bypass-approvals-and-sandbox': false, '--yolo': false, '--full-auto': false },
  modes: ['read-only', 'workspace-write', 'danger-full-access'].map(value => choice(value, value, '--sandbox', value)),
  modeLabel: 'Sandbox', modeFlags: { '--sandbox': true, '-s': true },
  reasoning: { flag: 'codex-config', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'] } },
  'claude-code': { ...model, permissions: [
    ...['manual', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'].map(value => choice(value, value, '--permission-mode', value))
  ], permissionFlags: { '--permission-mode': true, '--dangerously-skip-permissions': false },
  reasoning: { flag: '--effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'cursor-cli': { ...model, permissions: [choice('--auto-review', '--auto-review', '--auto-review'), choice('--force', '--force', '--force')],
    permissionFlags: { '--force': false, '-f': false, '--yolo': false, '--auto-review': false },
    modes: [choice('plan', 'Plan', '--mode', 'plan'), choice('ask', 'Ask', '--mode', 'ask')], modeFlags: { '--mode': true, '--plan': false } },
  opencode: { ...model, modelHint: 'provider/model', permissions: auto, permissionFlags: autoFlags,
    modes: [choice('build', '构建', '--agent', 'build'), choice('plan', '计划', '--agent', 'plan')], modeFlags: { '--agent': true } },
  gemini: { ...model, permissions: ['default', 'auto_edit', 'plan', 'yolo'].map(value => choice(value, value, '--approval-mode', value)),
    permissionFlags: { '--approval-mode': true, '--yolo': false, '-y': false } },
  // Kimi CLI and Kimi Code use the same executable but assign different semantics
  // to --yolo. Do not claim one permission meaning without version detection.
  'kimi-cli': { ...model, modes: [choice('plan', '计划', '--plan')], modeFlags: { '--plan': false },
    reasoning: { flag: 'kimi-acp', levels: [], dynamic: true } },
  'grok-cli': { ...model, permissions: [choice('default', '默认审批', '--permission-mode', 'default'),
    choice('acceptEdits', '自动批准编辑', '--permission-mode', 'acceptEdits'), choice('auto', '自动模式', '--permission-mode', 'auto'),
    choice('dontAsk', '不询问（拒绝需审批的操作）', '--permission-mode', 'dontAsk'), choice('bypassPermissions', '跳过权限检查', '--permission-mode', 'bypassPermissions'),
    choice('plan', '计划模式', '--permission-mode', 'plan')],
    permissionFlags: { '--permission-mode': true, '--always-approve': false }, reasoning: { flag: '--reasoning-effort', levels: ['low', 'medium', 'high'] } },
  'commandcode-cli': { ...model, permissions: [choice('default', '默认审批', '--permission-mode', 'default'), choice('plan', '计划模式', '--permission-mode', 'plan'),
    choice('accept-edits', '自动批准编辑', '--permission-mode', 'accept-edits'), choice('yolo', '跳过权限检查', '--permission-mode', 'yolo'),
    choice('dont-ask', '不询问（拒绝需审批的操作）', '--permission-mode', 'dont-ask')],
    permissionFlags: { '--permission-mode': true, '--accept-edits': false, '--yolo': false, '--dangerously-skip-permissions': false, '--plan': false },
    reasoning: { flag: '--effort', levels: ['low', 'medium', 'high'] } },
  'cline-cli': { ...model, permissions: ['false', 'true'].map(value => choice(value, value, '--auto-approve', value)),
    permissionFlags: { '--auto-approve': true, '--yolo': false, '-y': false }, modes: [choice('plan', '计划', '--plan')], modeFlags: { '--plan': false, '-p': false },
    reasoning: { flag: '--thinking', levels: ['none', 'low', 'medium', 'high', 'xhigh'] } },
  'kilo-cli': { ...model, modelHint: 'provider/model', permissions: auto, permissionFlags: autoFlags,
    modes: [choice('code', '代码', '--agent', 'code'), choice('plan', '计划', '--agent', 'plan'), choice('ask', '问答', '--agent', 'ask')], modeFlags: { '--agent': true } },
  'github-copilot-cli': { ...model, permissions: [choice('--allow-all-tools', '--allow-all-tools', '--allow-all-tools'), choice('--allow-all', '--allow-all', '--allow-all')],
    permissionFlags: { '--allow-all-tools': false, '--allow-all': false, '--yolo': false } },
  'devin-cli': { ...model, permissions: [choice('normal', '默认审批', '--permission-mode', 'normal'),
    choice('accept-edits', '自动批准编辑', '--permission-mode', 'accept-edits'), choice('smart', '智能审批', '--permission-mode', 'smart'),
    choice('dangerous', '跳过权限检查', '--permission-mode', 'dangerous')],
    permissionFlags: { '--permission-mode': true } },
  'hermes-cli': { ...model, permissions: [choice('yolo', '跳过危险命令审批', '--yolo')], permissionFlags: { '--yolo': false } },
  'pi-external-cli': { ...model, modelHint: 'provider/model', reasoning: { flag: '--thinking', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] } },
  'omp-cli': { ...model, modelHint: 'provider/model', permissions: ['always-ask', 'always-ask-cached', 'write', 'yolo']
    .map(value => choice(value, value, '--approval-mode', value)),
    permissionFlags: { '--approval-mode': true, '--auto-approve': false, '--yolo': false },
    reasoning: { flag: '--thinking', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] } },
  'muse-cli': { ...model, permissions: [choice('on-request', 'on-request', '--approval-mode', 'on-request'),
    choice('--yolo', '--yolo', '--yolo')],
    permissionFlags: { '--approval-mode': true, '--disable-approval': false, '--yolo': false },
    modes: ['on', 'off'].map(value => choice(value, value, '--approval-judge', value)),
    modeLabel: 'Approval Judge', modeFlags: { '--approval-judge': true },
    reasoning: { flag: '--reasoning-effort', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } },
  'zcode-cli': { permissions: [choice('plan', '计划模式', '--mode', 'plan'), choice('build', '操作需审批', '--mode', 'build'),
    choice('edit', '自动批准编辑', '--mode', 'edit'), choice('yolo', '跳过权限检查', '--mode', 'yolo')], permissionFlags: { '--mode': true } },
  'mimo-code-cli': { ...model, modelHint: 'provider/model', permissions: [choice('yolo', '自动批准工具', '--yolo')],
    permissionFlags: { '--yolo': false, '--dangerously-skip-permissions': false },
    modes: [choice('build', '构建', '--agent', 'build'), choice('plan', '计划', '--agent', 'plan')], modeFlags: { '--agent': true } },
  'qwen-cli': { ...model, permissions: [choice('plan', '计划模式', '--approval-mode', 'plan'),
    choice('default', '逐项审批', '--approval-mode', 'default'), choice('auto-edit', '自动批准编辑', '--approval-mode', 'auto-edit'),
    choice('auto', '自动审批安全操作', '--approval-mode', 'auto'), choice('yolo', '自动批准所有工具', '--approval-mode', 'yolo')],
    permissionFlags: { '--approval-mode': true, '--yolo': false, '-y': false } }
};

export function cliCapabilities(runtime: string, manifest?: RuntimeManifest): CliCapabilities {
  if (manifest) return manifest.capabilities ?? {};
  return Object.hasOwn(caps, runtime) ? caps[runtime] : {};
}

const historicalPermissionIds: Record<string, Record<string, string>> = {
  codex: { ask: 'on-request', review: '--approve-for-me', full: '--dangerously-bypass-approvals-and-sandbox' },
  'claude-code': { edits: 'acceptEdits', bypass: 'bypassPermissions' },
  'cursor-cli': { review: '--auto-review', full: '--force' },
  opencode: { auto: '--auto' },
  'kilo-cli': { auto: '--auto' },
  'cline-cli': { ask: 'false', auto: 'true' },
  'github-copilot-cli': { tools: '--allow-all-tools', all: '--allow-all' },
  'muse-cli': { ask: 'on-request', review: 'on-request', yolo: '--yolo' },
  gemini: { edits: 'auto_edit' }
};

export function cliReasoningLevels(capability: CliCapabilities, modelLevels?: readonly string[]): readonly string[] {
  return (capability.reasoning?.levels ?? []).filter(level => modelLevels === undefined || modelLevels.includes(level));
}

export function claudeModelReasoningLevels(
  models: ReadonlyArray<{ id: string; resolvedModel?: string; effortLevels?: string[] }>, modelId: string
): string[] | undefined {
  const exact = models.find(model => model.id === modelId);
  if (exact) return exact.effortLevels;
  const aliases = models.filter(model => model.resolvedModel === modelId);
  return aliases.length === 1 ? aliases[0].effortLevels : undefined;
}

/** Reject unknown capabilities, malformed IDs and untrusted enum values before side effects. */
export function normalizeCliLaunchOptions(runtime: string, raw: unknown, manifest?: RuntimeManifest, modelLevels?: readonly string[]): CliLaunchOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CLI 配置格式无效');
  const input = { ...raw as Record<string, unknown> };
  if (!manifest && runtime === 'muse-cli' && input.mode === undefined) {
    if (input.permission === 'ask') input.mode = 'off';
    else if (input.permission === 'review') input.mode = 'on';
  }
  for (const key of Object.keys(input)) if (!['model', 'permission', 'mode', 'reasoning'].includes(key)) throw new Error(`未知 CLI 配置项: ${key}`);
  const capability = cliCapabilities(runtime, manifest);
  const result: CliLaunchOptions = {};
  for (const key of ['model', 'permission', 'mode', 'reasoning'] as const) {
    const rawValue = input[key];
    const aliases = key === 'permission' && !manifest && Object.hasOwn(historicalPermissionIds, runtime)
      ? historicalPermissionIds[runtime] : undefined;
    const value = typeof rawValue === 'string' && aliases && Object.hasOwn(aliases, rawValue) ? aliases[rawValue] : rawValue;
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value !== value.trim()) throw new Error(`CLI ${key} 配置无效`);
    if (key === 'model') {
      // Restrict to portable model identifiers; command shims on Windows use cmd.exe.
      if (!capability.model || value.length > 256 || !/^[A-Za-z0-9_][A-Za-z0-9_.:/@+\-]*$/.test(value)) throw new Error('CLI 模型 ID 无效或该引擎暂不支持启动时指定模型');
    } else if (key === 'reasoning') {
      const reasoning = capability.reasoning;
      if (!reasoning || !(reasoning.dynamic ? /^[A-Za-z0-9_-]{1,64}$/.test(value) : cliReasoningLevels(capability, modelLevels).includes(value))) throw new Error('CLI 不支持所选思考强度');
    } else if (!(key === 'permission' ? capability.permissions : capability.modes)?.some(item => item.value === value)) {
      throw new Error(`CLI 不支持所选 ${key} 配置`);
    }
    result[key] = value;
  }
  if (!manifest && result.mode && ((runtime === 'codex' && result.permission?.startsWith('--')) ||
      (runtime === 'muse-cli' && result.permission === '--yolo'))) {
    throw new Error('所选 CLI 启动快捷参数与显式模式冲突');
  }
  return Object.keys(result).length ? result : undefined;
}

const automaticPermissions: Readonly<Record<string, string>> = {
  codex: '--dangerously-bypass-approvals-and-sandbox',
  'claude-code': 'bypassPermissions',
  'cursor-cli': '--force',
  opencode: '--auto',
  gemini: 'yolo',
  'grok-cli': 'bypassPermissions',
  'commandcode-cli': 'yolo',
  'cline-cli': 'true',
  'github-copilot-cli': '--allow-all',
  'devin-cli': 'dangerous',
  'hermes-cli': 'yolo',
  'omp-cli': 'yolo',
  'muse-cli': '--yolo',
  'zcode-cli': 'yolo',
  'mimo-code-cli': 'yolo',
  'qwen-cli': 'yolo'
};

export function supportsAutomaticCliPermissions(runtime: string, manifest?: RuntimeManifest): boolean {
  return Object.hasOwn(automaticPermissions, runtime) &&
    cliCapabilities(runtime, manifest).permissions?.some(choice => choice.value === automaticPermissions[runtime]) === true;
}

export function effectiveCliLaunchOptions(runtime: string, raw: unknown, manifest: RuntimeManifest | undefined,
  configurePermissions: boolean, uid?: number): CliLaunchOptions | undefined {
  if (configurePermissions) return normalizeCliLaunchOptions(runtime, raw, manifest);
  const supported = supportsAutomaticCliPermissions(runtime, manifest);
  if (supported && runtime === 'claude-code' && uid === 0) {
    throw new Error('Claude Code 无法以 root 使用免审批模式。请使用普通用户启动，或开启「配置权限」后选择原生权限。');
  }
  const permission = supported ? automaticPermissions[runtime] : undefined;
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw as CliLaunchOptions } : raw;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    delete (input as CliLaunchOptions).permission;
    if (runtime === 'codex' || runtime === 'muse-cli') delete (input as CliLaunchOptions).mode;
  }
  const options = normalizeCliLaunchOptions(runtime, input, manifest);
  return permission ? { ...options, permission } : options;
}

/** Apply explicit session choices before a prompt separator, replacing conflicting global flags. */
export function cliArgsForSession(runtime: string, raw: unknown, globalArgs: readonly string[], manifest?: RuntimeManifest, configurePermissions = true): string[] {
  const options = effectiveCliLaunchOptions(runtime, raw, manifest, configurePermissions);
  if (!options) return [...globalArgs];
  const capability = cliCapabilities(runtime, manifest);
  const strip: Record<string, boolean> = {};
  if (options.model) Object.assign(strip, { '--model': true, '-m': true });
  if (options.permission) Object.assign(strip, capability.permissionFlags);
  const codexCombinedPermission = runtime === 'codex' && !!options.permission?.startsWith('--');
  if (codexCombinedPermission) Object.assign(strip, { '--sandbox': true, '-s': true });
  if (runtime === 'muse-cli' && options.permission === '--yolo') Object.assign(strip, { '--approval-judge': true, '--disable-sandbox': false });
  if (options.mode) Object.assign(strip, capability.modeFlags);
  if (options.reasoning && !['codex-config', 'kimi-acp'].includes(capability.reasoning!.flag)) strip[capability.reasoning!.flag] = true;
  const args: string[] = [];
  for (let i = 0; i < globalArgs.length; i++) {
    const arg = globalArgs[i];
    if (arg === '--') throw new Error('CLI 全局启动参数包含 --，无法安全覆盖会话选项；请在 Worker 设置中移除');
    const equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    if (Object.hasOwn(strip, name)) {
      if (strip[name] && equal < 0) {
        if (!globalArgs[i + 1] || globalArgs[i + 1].startsWith('-')) throw new Error(`CLI 启动参数 ${name} 缺少值`);
        i++;
      }
      continue;
    }
    if (runtime === 'codex' && (name === '-c' || name === '--config')) {
      const config = equal < 0 ? globalArgs[i + 1] : arg.slice(equal + 1);
      if (!config) throw new Error('Codex 配置参数缺少值');
      const key = config.split('=')[0].trim();
      const conflict = (options.model && key === 'model') || (options.reasoning && key === 'model_reasoning_effort') ||
        (options.permission && key === 'approval_policy') ||
        ((options.mode || codexCombinedPermission) && key === 'sandbox_mode') ||
        (codexCombinedPermission && key === 'approvals_reviewer');
      if (conflict) { if (equal < 0) i++; continue; }
    }
    args.push(arg);
  }
  if (options.model) args.push('--model', options.model);
  if (options.permission) args.push(...capability.permissions!.find(item => item.value === options.permission)!.args);
  if (options.mode) args.push(...capability.modes!.find(item => item.value === options.mode)!.args);
  if (options.reasoning && capability.reasoning!.flag !== 'kimi-acp') args.push(...(capability.reasoning!.flag === 'codex-config'
    ? ['-c', `model_reasoning_effort=${options.reasoning}`] : [capability.reasoning!.flag, options.reasoning]));
  return args;
}
