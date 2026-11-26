/**
 * B2 permission option 模型（纯契约 + 纯函数，主进程/渲染层共用）。
 *
 * 确认门四态处置：allowOnce | allowAlways | deny | custom（不引入 plan/build/edit 模式）。
 * always 规则持久化带 scope（global|project|session），匹配先 scope 后指纹；
 * freeText 纠偏上限 4096；结构化预览 scope=command|file|generic（filePaths≤6，fileChange=add|update）。
 * 倒计时自动处置默认关（autoResolve.enabled=false），避免无人值守误放。
 */

export type PermissionOptionKind = 'allowOnce' | 'allowAlways' | 'deny' | 'custom';
export type PermissionScope = 'global' | 'project' | 'session';
export type PermissionPreviewScope = 'command' | 'file' | 'generic';
export type FileChangeKind = 'add' | 'update';

export const FREE_TEXT_MAX = 4096;
export const FILE_PATHS_MAX = 6;

export const PERMISSION_OPTION_KINDS: readonly PermissionOptionKind[] = [
  'allowOnce',
  'allowAlways',
  'deny',
  'custom'
];
export const PERMISSION_SCOPES: readonly PermissionScope[] = ['global', 'project', 'session'];

export interface PermissionPreview {
  scope: PermissionPreviewScope;
  /** scope=command：待执行命令 */
  command?: string;
  /** scope=file：涉及文件路径（展示上限 FILE_PATHS_MAX，超出截断） */
  filePaths?: string[];
  /** scope=file：变更类型 */
  fileChange?: FileChangeKind;
  /** scope=generic：一句话说明 */
  label?: string;
}

/** 倒计时自动处置；默认 enabled=false（产品裁决：无人值守不自动放） */
export interface PermissionAutoResolve {
  enabled: boolean;
  timeoutMs?: number;
  /** 到期自动处置形态；缺省 deny */
  defaultKind?: PermissionOptionKind;
}

export interface PermissionGateOptions {
  /** 结构化预览（command/file/generic） */
  preview?: PermissionPreview;
  /** 展示哪些选项按钮；缺省四态全开 */
  kinds?: PermissionOptionKind[];
  /** allowAlways 可选作用域；缺省 project/session */
  scopes?: PermissionScope[];
  /** allowAlways 默认作用域 */
  defaultScope?: PermissionScope;
  /** freeText 回灌：上次/草稿输入预填 */
  freeText?: string;
  /** always 规则指纹（工具/命令标识，由调用方给出） */
  fingerprint?: string;
  /** scope=project 的键（工作区 id） */
  projectKey?: string;
  /** scope=session 的键（会话 id） */
  sessionKey?: string;
  autoResolve?: PermissionAutoResolve;
}

/** 确认框应答：四态 + always 作用域 + freeText */
export interface PermissionDecision {
  kind: PermissionOptionKind;
  /** kind=allowAlways 必带 */
  scope?: PermissionScope;
  /** custom 纠偏文本；其它 kind 可作备注。上限 FREE_TEXT_MAX */
  freeText?: string;
}

/** always 规则（持久化形状，带 scope） */
export interface AlwaysRule {
  fingerprint: string;
  scope: PermissionScope;
  /** scope=global 恒为 'global'；project=工作区 id；session=会话 id */
  scopeKey: string;
  effect: 'allow' | 'deny';
  createdAt?: number;
}

export function isPermissionOptionKind(v: unknown): v is PermissionOptionKind {
  return v === 'allowOnce' || v === 'allowAlways' || v === 'deny' || v === 'custom';
}

export function isPermissionScope(v: unknown): v is PermissionScope {
  return v === 'global' || v === 'project' || v === 'session';
}

export function isFileChangeKind(v: unknown): v is FileChangeKind {
  return v === 'add' || v === 'update';
}

/** freeText 上限 4096，超长截断 */
export function clampFreeText(s: string): string {
  return s.length <= FREE_TEXT_MAX ? s : s.slice(0, FREE_TEXT_MAX);
}

/** 倒计时自动处置默认关 */
export function defaultAutoResolve(): PermissionAutoResolve {
  return { enabled: false };
}

export function isAutoResolveEnabled(cfg?: PermissionAutoResolve): boolean {
  return cfg?.enabled === true;
}

/** allowOnce/allowAlways 放行；deny/custom 不执行（custom 带 freeText 回灌） */
export function decisionConfirmed(d: PermissionDecision): boolean {
  return d.kind === 'allowOnce' || d.kind === 'allowAlways';
}

/** 结构化预览：filePaths≤6、fileChange 白名单、非法 scope 丢弃 */
export function normalizePermissionPreview(raw: unknown): PermissionPreview | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const scope =
    o.scope === 'command' || o.scope === 'file' || o.scope === 'generic' ? o.scope : undefined;
  if (!scope) return undefined;
  const out: PermissionPreview = { scope };
  if (typeof o.command === 'string' && o.command.trim()) out.command = o.command.trim();
  if (typeof o.label === 'string' && o.label.trim()) out.label = o.label.trim();
  if (scope === 'file') {
    const paths = Array.isArray(o.filePaths)
      ? o.filePaths
          .filter((p): p is string => typeof p === 'string' && !!p.trim())
          .map((p) => p.trim())
      : [];
    out.filePaths = paths.slice(0, FILE_PATHS_MAX);
    out.fileChange = isFileChangeKind(o.fileChange) ? o.fileChange : 'update';
  }
  return out;
}

/** 应答解析：非法 kind 丢弃；allowAlways 补默认 scope；freeText 截到 4096 */
export function parsePermissionDecision(raw: unknown): PermissionDecision | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (!isPermissionOptionKind(o.kind)) return undefined;
  const d: PermissionDecision = { kind: o.kind };
  if (o.kind === 'allowAlways') d.scope = isPermissionScope(o.scope) ? o.scope : 'project';
  else if (isPermissionScope(o.scope)) d.scope = o.scope;
  if (typeof o.freeText === 'string' && o.freeText) d.freeText = clampFreeText(o.freeText);
  return d;
}

/** scope 适用：global 通吃；project/session 要求 scopeKey 相等 */
function alwaysRuleApplies(
  rule: AlwaysRule,
  query: { projectKey?: string; sessionKey?: string }
): boolean {
  if (rule.scope === 'global') return true;
  if (rule.scope === 'project') return !!query.projectKey && rule.scopeKey === query.projectKey;
  return !!query.sessionKey && rule.scopeKey === query.sessionKey;
}

/** 越窄越优先：session > project > global */
export function scopeRank(scope: PermissionScope): number {
  return scope === 'session' ? 3 : scope === 'project' ? 2 : 1;
}

export interface AlwaysRuleQuery {
  fingerprint: string;
  projectKey?: string;
  sessionKey?: string;
}

/**
 * always 规则匹配：先 scope（不适用当前上下文的规则直接出局）后指纹。
 * 多条命中时取作用域最窄的一条（session > project > global）。
 */
export function matchAlwaysRule(
  rules: readonly AlwaysRule[],
  query: AlwaysRuleQuery
): AlwaysRule | undefined {
  const inScope = rules.filter((r) => alwaysRuleApplies(r, query));
  const hit = inScope.filter((r) => r.fingerprint === query.fingerprint);
  if (!hit.length) return undefined;
  return hit.reduce((best, r) => (scopeRank(r.scope) > scopeRank(best.scope) ? r : best));
}

/** allowAlways 决策 → 可持久化的 always 规则（带 scope / scopeKey） */
export function buildAlwaysRule(
  decision: PermissionDecision,
  opts: { fingerprint: string; projectKey?: string; sessionKey?: string; now?: number }
): AlwaysRule | undefined {
  if (decision.kind !== 'allowAlways') return undefined;
  const scope = decision.scope ?? 'project';
  const scopeKey =
    scope === 'global' ? 'global' : scope === 'project' ? (opts.projectKey ?? '') : (opts.sessionKey ?? '');
  if (scope !== 'global' && !scopeKey) return undefined;
  return {
    fingerprint: opts.fingerprint,
    scope,
    scopeKey,
    effect: 'allow',
    createdAt: opts.now ?? Date.now()
  };
}

/** always 规则序列化（JSON 落盘；scope 随条目持久化） */
export function serializeAlwaysRules(rules: readonly AlwaysRule[]): string {
  return JSON.stringify({ version: 1, rules });
}

export function parseAlwaysRules(raw: unknown): AlwaysRule[] {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)
      ? ((raw as { rules: unknown[] }).rules)
      : Array.isArray(raw)
        ? raw
        : [];
  const out: AlwaysRule[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    if (typeof o.fingerprint !== 'string' || !o.fingerprint) continue;
    if (!isPermissionScope(o.scope)) continue;
    if (typeof o.scopeKey !== 'string') continue;
    const effect = o.effect === 'deny' ? 'deny' : 'allow';
    out.push({
      fingerprint: o.fingerprint,
      scope: o.scope,
      scopeKey: o.scopeKey,
      effect,
      ...(typeof o.createdAt === 'number' ? { createdAt: o.createdAt } : {})
    });
  }
  return out;
}

/** 文件变更预览：从工具参数抽 path 类字段（调用方用于 Edit/Write 等） */
export function buildFileChangePreview(
  paths: readonly string[],
  fileChange: FileChangeKind = 'update'
): PermissionPreview {
  return {
    scope: 'file',
    filePaths: paths.filter((p) => !!p.trim()).slice(0, FILE_PATHS_MAX),
    fileChange: isFileChangeKind(fileChange) ? fileChange : 'update'
  };
}

/** 确认应答 → IPC 载荷（渲染层 confirmRespond 与主进程 parseConfirmIpcPayload 共用此形状） */
export function buildConfirmIpcPayload(
  confirmed: boolean,
  cancelledBy?: string,
  decision?: PermissionDecision
): {
  confirmed: boolean;
  cancelledBy?: string;
  kind?: PermissionOptionKind;
  scope?: PermissionScope;
  freeText?: string;
} {
  const kind = decision?.kind ?? (confirmed ? 'allowOnce' : 'deny');
  return {
    confirmed,
    ...(cancelledBy ? { cancelledBy } : {}),
    kind,
    ...(decision?.scope ? { scope: decision.scope } : {}),
    ...(decision?.freeText ? { freeText: clampFreeText(decision.freeText) } : {})
  };
}

const PATH_KEYS = ['path', 'filePath', 'file', 'files', 'filePaths', 'paths'] as const;

/** 结构化 patch 文件条目（ApplyPatch files[]）：识别 filePath/path + type(add|update|delete|move) */
function collectPatchOps(
  raw: unknown
): { paths: string[]; allAdd: boolean } | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const paths: string[] = [];
  let sawOp = false;
  let allAdd = true;
  for (const row of raw) {
    if (!row || typeof row !== 'object') return undefined;
    const o = row as Record<string, unknown>;
    const type = o.type;
    if (type !== 'add' && type !== 'update' && type !== 'delete' && type !== 'move') return undefined;
    sawOp = true;
    if (type !== 'add') allAdd = false;
    const p = typeof o.filePath === 'string' ? o.filePath.trim() : typeof o.path === 'string' ? o.path.trim() : '';
    if (p) paths.push(p);
    if (type === 'move' && typeof o.movePath === 'string' && o.movePath.trim()) {
      paths.push(o.movePath.trim());
    }
  }
  return sawOp ? { paths: paths.slice(0, FILE_PATHS_MAX), allAdd } : undefined;
}

/**
 * 从工具参数推导结构化预览：
 * 含 path 类字段 → file；含 command/cmd → command；否则 generic（用 label）。
 * ApplyPatch 形状（files[] 带 type: add|update|delete|move）走 patch 汇总：
 * filePaths + fileChange（全 add → add，否则 update），与 permission option 预览打通。
 */
export function previewFromToolArgs(
  args: Record<string, unknown>,
  opts?: { label?: string; fileChange?: FileChangeKind }
): PermissionPreview | undefined {
  const patch = collectPatchOps(args.files ?? args.patch);
  if (patch && patch.paths.length) {
    return buildFileChangePreview(patch.paths, patch.allAdd ? 'add' : 'update');
  }
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) paths.push(v.trim());
    else if (Array.isArray(v)) {
      for (const p of v) if (typeof p === 'string' && p.trim()) paths.push(p.trim());
    }
    if (paths.length >= FILE_PATHS_MAX) break;
  }
  if (paths.length) {
    const change: FileChangeKind =
      args.create === true || args.exists === false ? 'add' : (opts?.fileChange ?? 'update');
    return buildFileChangePreview(paths, change);
  }
  const cmd = args.command ?? args.cmd;
  if (typeof cmd === 'string' && cmd.trim()) return { scope: 'command', command: cmd.trim() };
  const label = opts?.label?.trim();
  return label ? { scope: 'generic', label } : undefined;
}
