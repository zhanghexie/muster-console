import { t } from './i18n';
import { formatRelativeTime } from './relativeTime';
import type { CloseBatchPlan, ConfirmSessionSnapshot } from './sessionCloseBatch';
import type { PermissionGateOptions, PermissionOptionKind, PermissionScope } from './permissionOption';
import { clampFreeText, isPermissionScope, parsePermissionDecision } from './permissionOption';

export type { ConfirmSessionSnapshot } from './sessionCloseBatch';
export type { PermissionDecision, PermissionGateOptions } from './permissionOption';
export { buildConfirmIpcPayload } from './permissionOption';

export type ConfirmCancelledBy = 'backdrop' | 'button' | 'close' | 'esc' | 'timeout';

export interface ConfirmResult {
  confirmed: boolean;
  cancelledBy?: ConfirmCancelledBy;
  /** 四态处置（permission 门）：allowOnce/allowAlways → confirmed=true；deny/custom 否决（custom 带 freeText 回灌） */
  kind?: PermissionOptionKind;
  /** kind=allowAlways 的作用域 */
  scope?: PermissionScope;
  /** 自定义纠偏文本（≤4096），随应答回灌给调用方 */
  freeText?: string;
}

/** Private, host-generated evidence; never accepted as a model-supplied URL. */
export interface DesktopEvidencePreview {
  dataUrl: string;
  region: { x: number; y: number; width: number; height: number };
}

export interface ConfirmDialogFields {
  dangerous?: boolean;
  subtitle?: string;
  intent?: string;
  summary?: string;
  confirmNote?: string;
  toolDescription?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 权限选项门：四态按钮 + always 作用域 + freeText + 结构化预览 */
  permission?: PermissionGateOptions;
}

export function isConfirmed(r: ConfirmResult | boolean | undefined | null): boolean {
  if (r === true) return true;
  if (r && typeof r === 'object') {
    if (r.confirmed === true) return true;
    return r.kind === 'allowOnce' || r.kind === 'allowAlways';
  }
  return false;
}

export function parseConfirmIpcPayload(payload: unknown): ConfirmResult {
  if (payload === true) return { confirmed: true, kind: 'allowOnce' };
  if (payload === false) return { confirmed: false, cancelledBy: 'button', kind: 'deny' };
  if (payload && typeof payload === 'object') {
    const o = payload as {
      confirmed?: unknown;
      cancelledBy?: unknown;
      kind?: unknown;
      scope?: unknown;
      freeText?: unknown;
    };
    const decision = parsePermissionDecision(o);
    const confirmed = o.confirmed === true || decision?.kind === 'allowOnce' || decision?.kind === 'allowAlways';
    const by = o.cancelledBy;
    const cancelledBy: ConfirmCancelledBy | undefined =
      by === 'backdrop' || by === 'button' || by === 'close' || by === 'esc' || by === 'timeout'
        ? by
        : confirmed
          ? undefined
          : 'button';
    const kind: PermissionOptionKind | undefined = decision?.kind ?? (confirmed ? 'allowOnce' : 'deny');
    const scope: PermissionScope | undefined =
      decision?.scope ?? (isPermissionScope(o.scope) ? o.scope : undefined);
    const freeText: string | undefined =
      decision?.freeText ??
      (typeof o.freeText === 'string' && o.freeText ? clampFreeText(o.freeText) : undefined);
    return {
      confirmed,
      ...(cancelledBy ? { cancelledBy } : {}),
      ...(kind ? { kind } : {}),
      ...(scope ? { scope } : {}),
      ...(freeText ? { freeText } : {})
    };
  }
  return { confirmed: false, cancelledBy: 'button', kind: 'deny' };
}

/** 危险工具 schema 注入：调用方可附带给人看的确认说明 */
export const CONFIRM_NOTE_PARAM_PROPS = {
  confirmNote: {
    type: 'string',
    description:
      'Optional confirmation note.'
  }
} as const;

const META_KEYS = new Set(['confirmNote', 'reason']);
/** 确认框摘要/详情不展示密钥或超长脚本正文 */
const SENSITIVE_ARG_KEYS = new Set(['apiKey', 'token', 'password', 'secret', 'scriptSource']);
/** 已被会话/任务语义块取代时，不再把裸 UUID 堆进摘要 */
export const SESSION_REF_ARG_KEYS = new Set(['sessionId', 'worktreePath', 'ids', 'sessionIds']);
export type ReviewDecision = 'passed' | 'rejected' | 'deferred' | 'processed';

/** Reversible review outcomes do not mutate source code or integrate a branch. */
export function shouldSkipReviewConfirm(toolName: string, args: Record<string, unknown> | null | undefined): boolean {
  return toolName === 'sessions.review' && (args?.decision === 'rejected' || args?.decision === 'deferred');
}

export function isReviewDecision(v: unknown): v is ReviewDecision {
  return v === 'passed' || v === 'rejected' || v === 'deferred' || v === 'processed';
}

export function pickConfirmNote(args: Record<string, unknown>): string {
  const note = args.confirmNote;
  if (typeof note === 'string' && note.trim()) return note.trim();
  const reason = args.reason;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return '';
}

export function collectSessionRefs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  add(args.sessionId);
  add(args.worktreePath);
  for (const key of ['ids', 'sessionIds'] as const) {
    const arr = args[key];
    if (Array.isArray(arr)) arr.forEach(add);
  }
  return [...new Set(out)];
}

export function confirmActionLabel(action?: string): string {
  const verb = action?.trim();
  if (!verb) return t('确认执行');
  if (verb === '合入') return t('确认合入');
  if (verb === '删除') return t('确认删除');
  return t('确认{{action}}', { action: t(verb) });
}

export function humanizeConfirmArgs(
  args: Record<string, unknown>,
  opts?: { omitKeys?: Iterable<string> }
): string {
  const omit = new Set(opts?.omitKeys ?? []);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (META_KEYS.has(k) || SENSITIVE_ARG_KEYS.has(k) || omit.has(k)) continue;
    if (v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}: ${String(v)}`);
    } else {
      try {
        parts.push(`${k}: ${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}: [?]`);
      }
    }
  }
  return parts.join('\n');
}

export function formatConfirmSessionContext(s: ConfirmSessionSnapshot): string {
  const title = s.name?.trim() || s.id;
  const lines = [t('「{{name}}」', { name: title })];
  const wt = (s.worktreePath || '').trim();
  const cwd = (s.cwd || '').trim();
  if (wt) lines.push(t('隔离树: {{path}}', { path: wt }));
  else if (cwd) lines.push(t('cwd: {{path}}', { path: cwd }));
  const branch = s.worktreeBranch?.trim();
  if (branch) lines.push(t('隔离分支: {{branch}}', { branch }));
  const phase = s.phase?.trim();
  const life = s.lifecycle?.trim();
  if (phase && life) lines.push(t('phase: {{phase}} · lifecycle: {{lifecycle}}', { phase, lifecycle: life }));
  else if (phase) lines.push(t('phase: {{phase}}', { phase }));
  else if (life) lines.push(t('lifecycle: {{lifecycle}}', { lifecycle: life }));
  return lines.join('\n');
}

export function formatCloseConfirmSummary(s: ConfirmSessionSnapshot): string {
  const name = s.name?.trim() || s.id;
  const head = t('删除会话「{{name}}」', { name });
  const rest = formatConfirmSessionContext(s);
  // rest 首行与 head 重复「名」，只留 cwd/phase
  const extra = rest.split('\n').slice(1).join('\n');
  return extra ? `${head}\n${extra}` : head;
}

function lastActiveAt(s: Pick<ConfirmSessionSnapshot, 'lastUsedAt' | 'createdAt'>): number | undefined {
  const n = s.lastUsedAt ?? s.createdAt;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function formatCloseBatchItem(
  s: ConfirmSessionSnapshot,
  opts?: { now?: number }
): string {
  const name = s.name?.trim() || s.id;
  const at = lastActiveAt(s);
  if (at == null) return t('· {{name}}', { name });
  return t('· {{name}} · {{when}}', { name, when: formatRelativeTime(at, { now: opts?.now }) });
}

export function formatCloseBatchConfirmSummary(
  plan: CloseBatchPlan,
  opts?: { now?: number }
): string {
  const lines: string[] = [];
  if (plan.targets.length) {
    lines.push(t('将永久删除 {{n}} 个已归档会话：', { n: plan.targets.length }));
    for (const s of plan.targets) lines.push(formatCloseBatchItem(s, opts));
  }
  if (plan.failed.length) {
    lines.push(t('不可删除（整批将中止）：'));
    for (const f of plan.failed) {
      const name = f.name?.trim() || f.id;
      lines.push(t('· {{name}}（{{reason}}）', { name, reason: f.reasonLabel }));
    }
  }
  if (!lines.length) return t('（无参数）');
  return lines.join('\n');
}

export type LookedUpSession = { ref: string; session?: ConfirmSessionSnapshot };

/** 危险门摘要：会话/任务语义块优先，裸 UUID 只在查不到时回落 */
export function buildDangerousConfirmSummary(opts: {
  toolName: string;
  args: Record<string, unknown>;
  catalogSummary?: string;
  sessions?: LookedUpSession[];
  closeBatchPlan?: CloseBatchPlan;
  serviceName?: string;
  themeName?: string;
  now?: number;
}): string {
  const { toolName, args, catalogSummary, closeBatchPlan, serviceName, themeName, now } = opts;
  if (toolName === 'sessions.delete' && closeBatchPlan) {
    return formatCloseBatchConfirmSummary(closeBatchPlan, { now });
  }

  const found = (opts.sessions ?? []).filter((x): x is LookedUpSession & { session: ConfirmSessionSnapshot } => !!x.session);
  const unique = dedupeSnapshots(found.map((x) => x.session));


  if (toolName === 'sessions.integrate') {
    const target =
      typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'main';
    const s = unique[0];
    const head = s?.name?.trim()
      ? t('把「{{name}}」合入 {{target}}', { name: s.name.trim(), target })
      : catalogSummary?.trim() || integrateConfirmSummary(args);
    const ctx = s ? formatConfirmSessionContext(s).split('\n').slice(1).join('\n') : '';
    return ctx ? `${head}\n${ctx}` : head;
  }

  if ((toolName === 'sessions.review' || toolName === 'host.sessions.review') && args.decision === 'processed' && Array.isArray(args.sessionIds)) {
    const lines = [t('批量标记 {{n}} 个会话已处理：归档并清除维度门，不合入', { n: args.sessionIds.length })];
    for (const item of opts.sessions ?? []) lines.push(item.session ? formatConfirmSessionContext(item.session) : t('未找到会话 {{id}}', { id: item.ref }));
    if (!(opts.sessions ?? []).length) lines.push(...args.sessionIds.map(id => String(id)));
    const note = pickReviewNote(args);
    if (note) lines.push(t('备注：{{note}}', { note }));
    return lines.join('\n');
  }
  if (toolName === 'sessions.review' || toolName === 'host.sessions.review') {
    return formatReviewConfirmSummary(args, unique[0]);
  }

  const omit = new Set<string>([...SESSION_REF_ARG_KEYS]);
  if (serviceName) omit.add('automationId');
  if (themeName) omit.add('id');
  const human =
    catalogSummary?.trim() ||
    humanizeConfirmArgs(args, { omitKeys: omit }) ||
    t('（无参数）');
  const blocks: string[] = [human];
  for (const s of unique) blocks.push(formatConfirmSessionContext(s));
  const unresolved = (opts.sessions ?? []).filter((x) => !x.session);
  for (const u of unresolved) {
    blocks.push(t('未找到会话 {{id}}', { id: u.ref }));
  }
  if (serviceName) blocks.push(t('定时任务「{{name}}」', { name: serviceName }));
  if (themeName) blocks.push(t('主题「{{name}}」', { name: themeName }));
  return blocks.filter(Boolean).join('\n');
}

function dedupeSnapshots(rows: ConfirmSessionSnapshot[]): ConfirmSessionSnapshot[] {
  const seen = new Set<string>();
  const out: ConfirmSessionSnapshot[] = [];
  for (const s of rows) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export function firstSentence(text: string): string {
  const s = text.trim();
  if (!s) return '';
  const m = s.match(/^[\s\S]+?[。.!！？?\n]/);
  const line = (m ? m[0] : s).trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

export function integrateConfirmSummary(args: Record<string, unknown>): string {
  const target =
    typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'main';
  const id = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  return id
    ? t('把会话 {{id}} 合入 {{target}}', { id, target })
    : t('合入到 {{target}}', { target });
}

function reviewSessionTitle(args: Record<string, unknown>, session?: ConfirmSessionSnapshot): string {
  const name = session?.name?.trim();
  if (name) return name;
  const id = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  return id || t('该会话');
}

export function sessionHasIsolateTree(session?: ConfirmSessionSnapshot): boolean {
  return !!(session?.worktreePath?.trim() && session?.worktreeBranch?.trim());
}

export function reviewConfirmAction(
  args: Record<string, unknown>,
  session?: ConfirmSessionSnapshot
): string {
  const d = args.decision;
  if (d === 'rejected') return t('打回重做');
  if (d === 'deferred') return t('搁置');
  if (d === 'processed') return t('标记已处理');
  if (d === 'passed') {
    if (session?.dimensionGateRed) return t('强制验收（跳过维度门）');
    if (session && !sessionHasIsolateTree(session)) return t('通过并归档');
    return t('通过并合入');
  }
  return t('验收');
}

export function reviewConfirmIntent(
  args: Record<string, unknown>,
  session?: ConfirmSessionSnapshot
): string {
  if (args.decision === 'processed' && Array.isArray(args.sessionIds)) {
    return t('批量标记 {{n}} 个会话已处理', { n: args.sessionIds.length });
  }
  const name = reviewSessionTitle(args, session);
  const d = args.decision;
  if (d === 'passed') {
    if (sessionHasIsolateTree(session)) {
      return t('验收通过「{{name}}」并合入 main', { name });
    }
    if (session) return t('验收通过「{{name}}」并标记已处理', { name });
    return t('验收通过「{{name}}」', { name });
  }
  if (d === 'rejected') return t('打回「{{name}}」重做', { name });
  if (d === 'deferred') return t('搁置「{{name}}」的验收', { name });
  if (d === 'processed') return t('标记「{{name}}」已处理', { name });
  return t('验收「{{name}}」', { name });
}

export function pickReviewNote(args: Record<string, unknown>): string {
  const note = args.note;
  if (typeof note !== 'string' || !note.trim()) return '';
  return firstSentence(note.trim());
}

export function reviewConfirmSummary(
  args: Record<string, unknown>,
  session?: ConfirmSessionSnapshot
): string {
  if (args.decision === 'processed' && Array.isArray(args.sessionIds)) {
    return [t('批量标记 {{n}} 个会话已处理：归档并清除维度门，不合入', { n: args.sessionIds.length }),
      ...args.sessionIds.map(id => String(id))].join('\n');
  }
  return formatReviewConfirmSummary(args, session);
}

function formatReviewConfirmSummary(
  args: Record<string, unknown>,
  session?: ConfirmSessionSnapshot
): string {
  const name = reviewSessionTitle(args, session);
  const d = args.decision;
  let head: string;
  if (d === 'passed') {
    if (session?.dimensionGateRed) {
      head = t('强制验收「{{name}}」：跳过维度门（{{gate}}）并按验收通过处理', {
        name,
        gate: session.dimensionGateRed
      });
    } else if (sessionHasIsolateTree(session)) {
      head = t('验收通过「{{name}}」：将合入 main 并结任务 done', { name });
    } else if (session) {
      head = t('验收通过「{{name}}」：无隔离树，将标记已处理并归档', { name });
    } else {
      head = t('验收通过「{{name}}」：有隔离树则合入 main 并结任务 done，无树则标记已处理', {
        name
      });
    }
  } else if (d === 'rejected') {
    head = t('打回「{{name}}」重做：将回注打回说明并让任务回到进行中', { name });
  } else if (d === 'deferred') {
    head = t('搁置「{{name}}」的验收：仍留在需要你列，不进探出条', { name });
  } else if (d === 'processed') {
    head = t('标记「{{name}}」已处理：仅归档，不合入，并清除维度门', { name });
  } else {
    head = t('验收「{{name}}」', { name });
  }
  const ctx = session ? formatConfirmSessionContext(session).split('\n').slice(1).join('\n') : '';
  const note = pickReviewNote(args);
  const noteLine = note ? t('备注：{{note}}', { note }) : '';
  const gateLine =
    session?.dimensionGateRed && d === 'passed' && args.skipDimensionGate === true
      ? t('将跳过维度门强制验收，验收账本留痕 dimension-gate-override')
      : '';
  return [head, ctx, noteLine, gateLine].filter(Boolean).join('\n');
}

export function runtimeConfirmSummary(
  kind: 'register' | 'update' | 'remove' | 'restore',
  args: Record<string, unknown>
): string {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const label = typeof args.label === 'string' ? args.label.trim() : '';
  if (kind === 'register') {
    return label
      ? t('注册 runtime「{{label}}」（{{id}}）。写入脚本后可用该 runtime 开会话', { label, id })
      : t('注册 runtime「{{id}}」。写入脚本后可用该 runtime 开会话', { id });
  }
  if (kind === 'update') {
    const fields = ['label', 'enabled', 'scriptSource', 'extraArgs'].filter(
      (k) => args[k] != null && args[k] !== ''
    );
    const extra = fields.length ? t('（将改：{{fields}}）', { fields: fields.join(' / ') }) : '';
    return t('更新 runtime「{{id}}」{{extra}}', { id, extra });
  }
  if (kind === 'remove') {
    return t('删除 runtime「{{id}}」及脚本文件', { id });
  }
  const ids = Array.isArray(args.ids)
    ? args.ids.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : [];
  return ids.length
    ? t('恢复内置 runtime：{{ids}}', { ids: ids.join('、') })
    : t('恢复全部内置 runtime');
}

export function dynamicToolConfirmSummary(
  kind: 'define' | 'update' | 'remove',
  args: Record<string, unknown>
): string {
  const extId = typeof args.id === 'string' ? args.id.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const tool = name ? `ext.${extId}.${name}` : `ext.${extId}`;
  if (kind === 'define') {
    const danger = args.dangerous === true ? t('（每次调用需确认）') : '';
    return t('定义动态工具 {{tool}}{{danger}}。写入扩展目录，调度/GUI 新起后可用', {
      tool,
      danger
    });
  }
  if (kind === 'update') {
    return t('更新动态工具 {{tool}}。内容变化会使既有信任记录失效', { tool });
  }
  return t('移除动态工具 {{tool}}', { tool });
}

export function llmUpsertProviderConfirmSummary(args: Record<string, unknown>): string {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const title = name || id;
  return t('新增或更新模型服务商「{{name}}」。将写入本机配置，不改当前默认模型', { name: title });
}

export function llmSetActiveConfirmSummary(args: Record<string, unknown>): string {
  const providerId = typeof args.providerId === 'string' ? args.providerId.trim() : '';
  const modelId = typeof args.modelId === 'string' ? args.modelId.trim() : '';
  return modelId
    ? t('将默认模型切换为 {{providerId}} / {{modelId}}。影响后续对话与任务', {
        providerId,
        modelId
      })
    : t('将默认服务商切换为 {{providerId}}。影响后续对话与任务', { providerId });
}

export function scheduledServiceConfirmSummary(
  kind: 'create' | 'update' | 'enable' | 'disable' | 'delete' | 'runNow',
  args: Record<string, unknown>
): string {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (kind === 'create') {
    return name ? t('创建定时任务「{{name}}」', { name }) : t('创建定时任务');
  }
  if (kind === 'update') return t('修改定时任务');
  if (kind === 'enable') return t('启用定时任务');
  if (kind === 'disable') return t('停用定时任务');
  if (kind === 'delete') return t('删除定时任务');
  return t('立即执行一次定时任务，不影响后续排期');
}
