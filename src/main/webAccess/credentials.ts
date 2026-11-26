/**
 * web-access.json 凭证存储（R2 修复，审计 2026-10-02）。
 *
 * 职责边界：本模块只管凭证的读取/校验/原子落盘——不 import electron、不持有
 * 网络状态；server 负责「准备新值 → persist → 发布/撤销连接」的协调与失败策略。
 *
 * 读取区分三种异常（缺失/损坏/读取失败），写入走 tmp+rename 原子替换并显式返回
 * 成功判据：凭证变更（token/hookToken/hookSecret/pushSubscription 轮换）必须以
 * persist 成功为前提，防止「宣称已撤销」的旧凭证在重启后从磁盘恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { errorMessage } from '../../shared/errors';

export interface WebAccessInfo {
  token: string;
  rotatedAt: string;
  /** T3.2：webhook 触发端点的独立 token（URL 末段），与网页访问 token 分离 */
  hookToken?: string;
  /** T3.2：GitHub webhook 签名密钥；空/缺省 = 不校验签名 */
  hookSecret?: string;
  /** 离线 Web Push 预留位（T1.2 只存不发） */
  pushSubscription?: unknown;
}

/** 凭证文件的原始盘面（含本版本未知的字段：轮换时保留，不丢其他凭证字段） */
export type PersistedRaw = Record<string, unknown>;

export type ReadWebAccessInfoResult =
  | { kind: 'ok'; info: WebAccessInfo; raw: PersistedRaw }
  | { kind: 'missing' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'read-error'; detail: string };

/** 合法 token 形态：base64url、足够长（本实现 24 字节 → 32 字符） */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidTokenShape(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/** 新 token（网页访问 / hook 端点同一形态，各自独立发） */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * 读全量信息。token 合法才算可用；损坏（JSON 坏/token 形态非法）与读取失败
 * （EACCES/EIO 等）分开报告——两者处置都是「生成新凭证」，但日志与诊断语义不同。
 */
export function readWebAccessInfo(file: string): ReadWebAccessInfoResult {
  let rawText: string;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'read-error', detail: errorMessage(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return { kind: 'corrupt', detail: `JSON 解析失败：${errorMessage(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', detail: '文件内容不是对象' };
  }
  const o = parsed as Record<string, unknown>;
  if (!isValidTokenShape(o.token)) {
    return { kind: 'corrupt', detail: 'token 缺失或形态非法' };
  }
  return {
    kind: 'ok',
    info: parsed as WebAccessInfo,
    raw: o
  };
}

export type SaveResult = { ok: true; raw: PersistedRaw } | { ok: false; error: string };

/**
 * 原子落盘：写同目录临时文件（fsync 后 rename 替换），失败时清理临时文件并返回
 * 失败判据——绝不静默吞错。已知字段以内存态为权威（hookSecret/pushSubscription
 * 空值 = 清除该字段），raw 里未识别的其他字段原样保留。
 */
export function saveWebAccessInfo(file: string, info: WebAccessInfo, raw: PersistedRaw = {}): SaveResult {
  const merged: PersistedRaw = { ...raw };
  merged.token = info.token;
  merged.rotatedAt = info.rotatedAt;
  if (info.hookToken) merged.hookToken = info.hookToken;
  else delete merged.hookToken;
  if (info.hookSecret) merged.hookSecret = info.hookSecret;
  else delete merged.hookSecret;
  if (info.pushSubscription !== undefined) merged.pushSubscription = info.pushSubscription;
  else delete merged.pushSubscription;
  const body = JSON.stringify(merged, null, 2);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd); // 内容先于 rename 落盘（目录项 fsync Windows 不可用，跳过）
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { ok: true, raw: merged };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响失败上报 */
    }
    return { ok: false, error: errorMessage(err) };
  }
}
