/**
 * 声明 digest 信任链纯函数层（zcode-adopt-batch-b B1 / S2.1）。
 * 注入/提示词声明按内容 sha256 逐条授权：改一个字节 digest 变即失效（stale_digest）。
 * 零依赖（test/*.mjs 即时转译导入；shared 不能用 node:crypto —— 渲染层可能 import）。
 *
 * 消费方只许走本模块的状态裁决与单调比较，禁止 UI/调用点手写比较（对齐
 * ZCode workspace-hook-review-monotonicity 单一纯函数约束）。
 */

// ── sha256（纯 JS，FIPS 180-4）────────────────────────────────────────────
// shared 零依赖约束下自实现；仅用于内容指纹，不承担密码学签名职责。

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** UTF-8 文本 → sha256 hex（小写、64 字符） */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  // 填充 = 0x80 + padLen 个零 + 8 字节长度；total 必须是 64 的倍数
  const padLen = (64 - ((bytes.length + 9) % 64)) % 64;
  const total = bytes.length + 1 + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = dv.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA_K[t] + w[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i += 1) out += H[i].toString(16).padStart(8, '0');
  return out;
}

// ── 规范化序列化（key 排序）────────────────────────────────────────────────

/** 稳定 JSON：对象 key 字典序递归排序、undefined 剔除；数组保序 */
export function canonicalDeclarationJson(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 声明内容 → sha256 digest。对象按 key 排序稳定序列化后哈希（同内容同 digest）；
 * 字符串按其 UTF-8 字节原样哈希（调用方已给规范文本时的快捷径）。
 */
export function declarationDigest(canonical: unknown): string {
  return sha256Hex(typeof canonical === 'string' ? canonical : canonicalDeclarationJson(canonical));
}

// ── 七态 ───────────────────────────────────────────────────────────────────

/**
 * 声明信任七态。
 * - pending_trust：内容待人审（含首见未授权）——不注入；
 * - trusted_persistent：已持久信任——注入；
 * - blocked_untrusted / blocked_policy：人拒 / 策略拒——不注入；
 * - revoked：曾信任后撤销——不注入；
 * - stale_digest：digest 与已裁决内容不符（改字节即回本态）——不注入，重新进 pending 审批。
 */
export type DeclarationTrustState =
  | 'pending_trust'
  | 'trusted_persistent'
  | 'blocked_untrusted'
  | 'blocked_policy'
  | 'revoked'
  | 'stale_digest';

export const DECLARATION_TRUST_STATES: readonly DeclarationTrustState[] = [
  'pending_trust',
  'trusted_persistent',
  'blocked_untrusted',
  'blocked_policy',
  'revoked',
  'stale_digest'
];

export function isDeclarationTrustState(v: unknown): v is DeclarationTrustState {
  return typeof v === 'string' && (DECLARATION_TRUST_STATES as readonly string[]).includes(v);
}

/** 信任账目（store value）：key = (workspaceIdentity, declarationDigest) */
export interface DeclarationTrustRecord {
  /** 裁决时间（epoch ms） */
  grantedAt: number;
  /** 裁决事件（诊断/审计用，如 grant_persistent / sync_stale） */
  event: string;
  /** 人读展示命令/说明（审批卡文案） */
  displayCommand: string;
  /** 声明代码出处（injection-registry 条目 / HOST 片段生成源） */
  sourcePath: string;
  state: DeclarationTrustState;
  /** 本次裁决的单调时钟（缺省=无并发裁决序） */
  review?: ReviewRef;
}

// ── 裁决单调性（唯一比较入口）──────────────────────────────────────────────

/** reviewFlowId/generation/interactionId 三元组（ZCode 单调裁决时钟） */
export interface ReviewRef {
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

/**
 * 裁决单调性：incoming 是否可覆盖 current（严格更大才覆盖）。
 * 全序 = generation 升序 → interactionId 字典序 → reviewFlowId 字典序。
 * 无 current（首见）恒可写入。禁止消费方另写比较。
 */
export function reviewMonotonicity(
  current: ReviewRef | null | undefined,
  incoming: ReviewRef
): boolean {
  if (!current) return true;
  if (incoming.generation !== current.generation) return incoming.generation > current.generation;
  if (incoming.interactionId !== current.interactionId) {
    return incoming.interactionId > current.interactionId;
  }
  return incoming.reviewFlowId > current.reviewFlowId;
}

// ── 状态裁决 ───────────────────────────────────────────────────────────────

/** store 内一条已裁决记录（digest 即其 key 的一半） */
export interface DeclarationDigestRecord {
  digest: string;
  record: DeclarationTrustRecord;
}

/**
 * 声明当前有效态：命中 digest → 用其态；同声明（sourcePath+displayCommand）有旧
 * digest 记录但当前 digest 不符 → stale_digest（改字节即回 stale）；无记录 → pending_trust。
 */
export function evaluateDeclarationTrust(input: {
  currentDigest: string;
  records: readonly DeclarationDigestRecord[];
  sourcePath: string;
  displayCommand: string;
}): DeclarationTrustState {
  const exact = input.records.find((r) => r.digest === input.currentDigest);
  if (exact) return exact.record.state;
  const sibling = input.records.find(
    (r) =>
      r.record.sourcePath === input.sourcePath &&
      r.record.displayCommand === input.displayCommand
  );
  return sibling ? 'stale_digest' : 'pending_trust';
}

/** 注入门：仅 trusted_persistent 放行（未信任/stale/拒绝/撤销一律不注入） */
export function shouldInjectDeclaration(state: DeclarationTrustState): boolean {
  return state === 'trusted_persistent';
}

/** 评估结果：有效态 + 是否可注入（注入门唯一口径） */
export function declarationInjectionVerdict(input: {
  currentDigest: string;
  records: readonly DeclarationDigestRecord[];
  sourcePath: string;
  displayCommand: string;
}): { state: DeclarationTrustState; inject: boolean; digest: string } {
  const state = evaluateDeclarationTrust(input);
  return { state, inject: shouldInjectDeclaration(state), digest: input.currentDigest };
}

/** 账目 map 的复合 key（store 可平铺或嵌套；此 key 供审计/查找共用） */
export function declarationTrustKey(workspaceIdentity: string, digest: string): string {
  return `${workspaceIdentity}\u0000${digest}`;
}

// ── 声明主体（注入源 / HOST 片段的统一描述）────────────────────────────────

/** 一条待信任声明：身份 + 出处 + 参与 digest 的规范化内容 */
export interface DeclarationSubject {
  /** 稳定身份（注入源 id / HOST 片段名） */
  id: string;
  /** 代码出处 */
  sourcePath: string;
  /** 人读展示命令/说明 */
  displayCommand: string;
  /** 参与 digest 的内容（对象按 key 排序规范化，字符串原样） */
  content: unknown;
}

export function subjectDigest(subject: DeclarationSubject): string {
  return declarationDigest(subject.content);
}

/** 主体 + store 记录 → 注入裁决（纯函数；store 层只负责取数） */
export function evaluateSubjectTrust(
  subject: DeclarationSubject,
  records: readonly DeclarationDigestRecord[]
): { state: DeclarationTrustState; inject: boolean; digest: string } {
  return declarationInjectionVerdict({
    currentDigest: subjectDigest(subject),
    records,
    sourcePath: subject.sourcePath,
    displayCommand: subject.displayCommand
  });
}
