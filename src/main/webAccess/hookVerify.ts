/**
 * GitHub webhook 签名校验（T3.2）：X-Hub-Signature-256 头 = `sha256=<hex(HMAC-SHA256)>`，
 * 密钥为设置页配置的 hook secret。与 token 鉴权互补——token 防路过者，签名证明
 * payload 确实来自知道 secret 的一方（GitHub 云端）。未配 secret 时不校验（内网场景
 * token 已够）；配置后缺头/格式错/摘要不符一律拒绝。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHubSignature256(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const eq = header.indexOf('=');
  if (eq < 0 || header.slice(0, eq).trim().toLowerCase() !== 'sha256') return false;
  const providedHex = header.slice(eq + 1).trim();
  // 摘要必须是 64 位 hex（SHA-256）；非法形态直接拒绝，不做恒时比较也不泄露信息
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) return false;
  const provided = Buffer.from(providedHex, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
