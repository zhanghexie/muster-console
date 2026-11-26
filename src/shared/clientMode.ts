/**
 * clientMode 双链路契约（zcode-adopt-batch-d D3 / S2.3）。
 * hello 强校验（clientMode × deliveryProfile 严格配对）+ task-run owner/lease
 * 词表（acquire/release、stream_mirror_gap/owner_lost）与互斥纯函数。
 * 先立契约，不实现全链路 relay。零依赖（test/*.mjs 即时转译导入）。
 */

/* ─────────────────── clientMode / deliveryProfile 投递分型 ─────────────────── */

/** 接入端运行形态：桌面常驻连续流 / 远端可回放 */
export type ClientMode = 'desktop-continuous' | 'web-remote-replayable';

/** 投递分型（与 clientMode 强绑定，hello 里必须匹配） */
export type DeliveryProfile = 'continuous' | 'replayable';

export const CLIENT_MODES: readonly ClientMode[] = [
  'desktop-continuous',
  'web-remote-replayable'
];

export const DELIVERY_PROFILES: readonly DeliveryProfile[] = ['continuous', 'replayable'];

/** 强绑定表：每个 clientMode 只有一个合法 deliveryProfile（strict 校验依据） */
export const CLIENT_MODE_DELIVERY: Readonly<Record<ClientMode, DeliveryProfile>> = {
  'desktop-continuous': 'continuous',
  'web-remote-replayable': 'replayable'
};

export function parseClientMode(v: unknown): ClientMode | null {
  return typeof v === 'string' && (CLIENT_MODES as readonly string[]).includes(v)
    ? (v as ClientMode)
    : null;
}

export function parseDeliveryProfile(v: unknown): DeliveryProfile | null {
  return typeof v === 'string' && (DELIVERY_PROFILES as readonly string[]).includes(v)
    ? (v as DeliveryProfile)
    : null;
}

/** 该 clientMode 唯一合法的 deliveryProfile */
export function expectedDeliveryProfile(mode: ClientMode): DeliveryProfile {
  return CLIENT_MODE_DELIVERY[mode];
}

/** 投递语义分型：连续流（无需回放补洞）还是可回放（cursor 补洞） */
export function isReplayableDelivery(profile: DeliveryProfile): boolean {
  return profile === 'replayable';
}

/** hello 校验拒绝原因码 */
export type HelloRejectCode =
  | 'not_object'
  | 'missing_client_mode'
  | 'unknown_client_mode'
  | 'missing_delivery_profile'
  | 'unknown_delivery_profile'
  | 'delivery_mismatch';

export type HelloValidation =
  | { ok: true; clientMode: ClientMode; deliveryProfile: DeliveryProfile }
  | { ok: false; code: HelloRejectCode; error: string };

/**
 * hello 强校验（strict）：clientMode 必须是枚举值；deliveryProfile 必填且
 * 必须与 clientMode 配对表一致——缺失、未知、不匹配一律拒绝，不静默纠正。
 */
export function validateClientHello(raw: unknown): HelloValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'not_object', error: 'hello must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const modeRaw = o.clientMode;
  if (modeRaw === undefined || modeRaw === null || modeRaw === '') {
    return { ok: false, code: 'missing_client_mode', error: 'clientMode is required' };
  }
  const clientMode = parseClientMode(modeRaw);
  if (!clientMode) {
    return { ok: false, code: 'unknown_client_mode', error: `unknown clientMode: ${String(modeRaw)}` };
  }
  const dpRaw = o.deliveryProfile;
  if (dpRaw === undefined || dpRaw === null || dpRaw === '') {
    return {
      ok: false,
      code: 'missing_delivery_profile',
      error: 'deliveryProfile is required (strict pairing)'
    };
  }
  const deliveryProfile = parseDeliveryProfile(dpRaw);
  if (!deliveryProfile) {
    return {
      ok: false,
      code: 'unknown_delivery_profile',
      error: `unknown deliveryProfile: ${String(dpRaw)}`
    };
  }
  const expected = expectedDeliveryProfile(clientMode);
  if (deliveryProfile !== expected) {
    return {
      ok: false,
      code: 'delivery_mismatch',
      error: `deliveryProfile '${deliveryProfile}' does not match clientMode '${clientMode}' (expected '${expected}')`
    };
  }
  return { ok: true, clientMode, deliveryProfile };
}

/* ─────────────────── task-run owner/lease 词表 ─────────────────── */

/** 租约操作词（acquire/release 为唯一写操作） */
export type TaskRunLeaseOp = 'acquire' | 'release';

/**
 * 租约相关事件词表（全链路 relay 后置，先落契约）：
 * - stream_mirror_gap：镜像端（非持有者）投递流出现序号缺口
 * - owner_lost：持有者租约过期/失联，可被他人 reclaim
 */
export type TaskRunLeaseEvent = 'stream_mirror_gap' | 'owner_lost';

export const TASK_RUN_LEASE_OPS: readonly TaskRunLeaseOp[] = ['acquire', 'release'];
export const TASK_RUN_LEASE_EVENTS: readonly TaskRunLeaseEvent[] = [
  'stream_mirror_gap',
  'owner_lost'
];

/** 缺省租约时长（对齐 turnGate 口径 15 分钟；调用方可覆盖） */
export const DEFAULT_TASK_RUN_LEASE_MS = 15 * 60_000;

/** 一条 task-run 租约：同一时刻至多一个 owner */
export interface TaskRunLease {
  runId: string;
  /** 持有者客户端 id（owner） */
  owner: string;
  /** 最近一次 acquire/续租时刻 */
  acquiredAt: number;
  leaseMs: number;
}

/** runId → lease（互斥表） */
export type TaskRunLeaseTable = Map<string, TaskRunLease>;

export type AcquireTaskRunLeaseResult =
  | { ok: true; lease: TaskRunLease; reclaimed: false }
  | { ok: true; lease: TaskRunLease; reclaimed: true; evictedOwner: string }
  | { ok: false; code: 'invalid' | 'held_by_other'; heldBy?: string };

export function isLeaseExpired(lease: TaskRunLease, now: number): boolean {
  // now 非有限（NaN/Infinity）时视作未过期（fail-closed：不误报 owner_lost）
  if (!Number.isFinite(now)) return false;
  return now - lease.acquiredAt >= lease.leaseMs;
}

export function peekTaskRunLease(
  table: TaskRunLeaseTable,
  runId: string
): TaskRunLease | null {
  return table.get(runId) ?? null;
}

/**
 * acquire（互斥核心）：
 * - 同一 owner 重入 = 续租（刷新 acquiredAt/leaseMs）；
 * - 他主未过期 → 拒绝 `held_by_other`（互斥）；
 * - 他主已过期 → 允许 reclaim，返回 `reclaimed: true` + evictedOwner（owner_lost 语义）。
 */
export function acquireTaskRunLease(
  table: TaskRunLeaseTable,
  input: { runId: string; owner: string; now: number; leaseMs?: number }
): AcquireTaskRunLeaseResult {
  const runId = (input.runId ?? '').trim();
  const owner = (input.owner ?? '').trim();
  const now = Number(input.now);
  if (!runId || !owner || !Number.isFinite(now)) {
    return { ok: false, code: 'invalid' };
  }
  const leaseMs =
    typeof input.leaseMs === 'number' && Number.isFinite(input.leaseMs) && input.leaseMs > 0
      ? Math.floor(input.leaseMs)
      : DEFAULT_TASK_RUN_LEASE_MS;
  const prev = table.get(runId);
  if (prev && prev.owner !== owner && !isLeaseExpired(prev, now)) {
    return { ok: false, code: 'held_by_other', heldBy: prev.owner };
  }
  const lease: TaskRunLease = { runId, owner, acquiredAt: now, leaseMs };
  table.set(runId, lease);
  if (prev && prev.owner !== owner) {
    return { ok: true, lease, reclaimed: true, evictedOwner: prev.owner };
  }
  return { ok: true, lease, reclaimed: false };
}

/**
 * release：只有持有者本人可释放；他人/已释放为 no-op 返回 false（不误删他人租约）。
 */
export function releaseTaskRunLease(
  table: TaskRunLeaseTable,
  input: { runId: string; owner: string }
): boolean {
  const runId = (input.runId ?? '').trim();
  const owner = (input.owner ?? '').trim();
  if (!runId || !owner) return false;
  const prev = table.get(runId);
  if (!prev || prev.owner !== owner) return false;
  table.delete(runId);
  return true;
}

/**
 * 持有者失联判定：租约过期即 owner_lost（调用方据此上报事件词表）。
 * 未过期或无租约返回 null。
 */
export function detectOwnerLost(
  table: TaskRunLeaseTable,
  input: { runId: string; now: number }
): TaskRunLeaseEvent | null {
  const prev = table.get((input.runId ?? '').trim());
  if (!prev) return null;
  return isLeaseExpired(prev, input.now) ? 'owner_lost' : null;
}

/**
 * 镜像端流缺口判定：非持有者（mirror）收到的事件序号出现空洞即
 * `stream_mirror_gap`；replayable 投递可用 cursor 回放补洞（recoverable），
 * continuous 投递补不了（流已过）。
 * 「缺口」只指跳号（seq > lastSeq + 1，中间有洞）；at-least-once 传输下的
 * 重复投递（seq === lastSeq）与事件倒退重放（seq < lastSeq）不是洞——
 * 重复≠丢，消费方自行去重即可，不上报 gap。
 */
export function classifyStreamMirrorGap(input: {
  role: 'owner' | 'mirror';
  lastSeq: number;
  seq: number;
  deliveryProfile: DeliveryProfile;
}): { gap: false } | { gap: true; kind: TaskRunLeaseEvent; recoverable: boolean } {
  if (input.role === 'owner') return { gap: false };
  const last = Number(input.lastSeq);
  const seq = Number(input.seq);
  if (!Number.isFinite(last) || !Number.isFinite(seq)) return { gap: false };
  if (seq <= last + 1) return { gap: false };
  return {
    gap: true,
    kind: 'stream_mirror_gap',
    recoverable: isReplayableDelivery(input.deliveryProfile)
  };
}
