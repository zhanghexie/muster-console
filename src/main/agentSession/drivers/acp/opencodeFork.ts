import { createHash } from 'node:crypto';
import { ConnectionCleanupError } from '../../host/retirement';
import type { GuiNativeForkPoint } from '../../types';
import { openCodeBody as body, withOpenCodeServer } from './opencodeServer';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const nativeId = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,180}$`).test(value);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Obj).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

/** OpenCode rewrites these identities on fork; all other message/part data must match. */
function fingerprint(message: unknown, positions: Map<string, number>): string {
  const item = object(message), info = { ...object(item.info) };
  if (typeof info.parentID === 'string') info.parentID = positions.get(info.parentID) ?? null;
  delete info.id; delete info.sessionID;
  const parts = Array.isArray(item.parts) ? item.parts.map(value => {
    const part = { ...object(value) };
    delete part.id; delete part.sessionID; delete part.messageID;
    if (part.type === 'compaction' && typeof part.tail_start_id === 'string')
      part.tail_start_id = positions.get(part.tail_start_id) ?? null;
    return part;
  }) : [];
  return JSON.stringify(stable({ info, parts }));
}

/** Called only when the user explicitly forks; never refreshes the harness or model catalog. */
export async function forkOpenCode(input: {
  executable: string; cwd: string; point: GuiNativeForkPoint; env: NodeJS.ProcessEnv; log(message: string): void;
}): Promise<{ status: 'forked'; token: string } | { status: 'unsupported' }> {
  const [first, last, hash, extra] = input.point.entryId.split('|');
  if (input.point.engine !== 'opencode' || !nativeId(input.point.sessionToken, 'ses') || !nativeId(first, 'msg') ||
      !nativeId(last, 'msg') || !/^[a-f0-9]{64}$/.test(hash ?? '') || extra !== undefined) return { status: 'unsupported' };

  let created = '';
  let forkSubmitted = false;
  try {
    return await withOpenCodeServer(input, async get => {
      const directory = `?directory=${encodeURIComponent(input.cwd)}`;
      const anonymous = await get('/global/health', false);
      if (anonymous.status !== 401) {
        input.log('OpenCode 分叉服务未确认本地访问保护，使用原有分叉方式');
        return { status: 'unsupported' };
      }
      await body(anonymous);
      const health = await get('/global/health', true);
      if (!health.ok) throw new Error(`OpenCode 分叉服务认证失败（${health.status}）`);
      await body(health);
      const messages = async (sessionId: string): Promise<unknown[] | null> => {
        const response = await get(`/session/${encodeURIComponent(sessionId)}/message${directory}`, true);
        if (response.status === 404 || response.status === 405) return null;
        if (!response.ok) throw new Error(`无法读取 OpenCode 原生消息（${response.status}）`);
        const parsed: unknown = JSON.parse(await body(response));
        if (!Array.isArray(parsed) || parsed.length > 100000) return null;
        return parsed;
      };
      const history = await messages(input.point.sessionToken);
      if (!history) { input.log('OpenCode 未提供可核对的原生历史，使用原有分叉方式'); return { status: 'unsupported' }; }
      const infos = history.map(item => object(object(item).info));
      if (infos.some(info => !nativeId(info.id, 'msg') || info.sessionID !== input.point.sessionToken ||
        (info.role !== 'user' && info.role !== 'assistant')) || new Set(infos.map(info => info.id)).size !== infos.length)
        return { status: 'unsupported' };
      const firstIndex = infos.findIndex(info => info.id === first && info.role === 'assistant');
      const lastIndex = infos.findIndex(info => info.id === last && info.role === 'assistant');
      if (firstIndex < 0 || lastIndex < firstIndex) return { status: 'unsupported' };
      const userId = text(infos[firstIndex].parentID);
      const userIndex = infos.findIndex(info => info.id === userId && info.role === 'user');
      if (userIndex < 0 || userIndex >= firstIndex || infos.slice(userIndex + 1, lastIndex + 1)
        .some(info => info.role !== 'assistant' || info.parentID !== userId)) return { status: 'unsupported' };
      const userParts = object(history[userIndex]).parts;
      if (!Array.isArray(userParts)) return { status: 'unsupported' };
      const originalText = userParts.map(object).filter(part => part.type === 'text' && part.synthetic !== true && part.ignored !== true)
        .map(part => text(part.text)).join('');
      if (createHash('sha256').update(originalText).digest('hex') !== hash) return { status: 'unsupported' };
      let target = input.point.role === 'user' ? userIndex : lastIndex;
      if (input.point.role === 'assistant') {
        while (target + 1 < infos.length && infos[target + 1].role === 'assistant' && infos[target + 1].parentID === userId) target++;
      }
      const next = infos[target + 1]?.id;
      if (next !== undefined && !nativeId(next, 'msg')) return { status: 'unsupported' };
      const expected = history.slice(0, target + 1);
      const positions = (items: unknown[]) => new Map(items.map((item, index) => [text(object(object(item).info).id), index]));
      const expectedPositions = positions(expected);
      if (expected.some(item => {
        const msg = object(item), parent = object(msg.info).parentID;
        if (typeof parent === 'string' && !expectedPositions.has(parent)) return true;
        return Array.isArray(msg.parts) && msg.parts.some(value => {
          const part = object(value);
          return part.type === 'compaction' && typeof part.tail_start_id === 'string' && !expectedPositions.has(part.tail_start_id);
        });
      })) return { status: 'unsupported' };
      forkSubmitted = true;
      const response = await get(`/session/${encodeURIComponent(input.point.sessionToken)}/fork${directory}`, true, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next ? { messageID: next } : {})
      });
      if (!response.ok) throw new Error(`OpenCode 原生分叉请求失败（${response.status}）`);
      const result = object(JSON.parse(await body(response)));
      created = text(result.id);
      if (!nativeId(created, 'ses') || created === input.point.sessionToken) throw new Error('OpenCode 返回的分叉会话身份无效');
      const copied = await messages(created);
      const copiedPositions = positions(copied ?? []);
      if (!copied || copied.length !== expected.length || copiedPositions.size !== copied.length || copied.some((item, index) =>
        object(object(item).info).sessionID !== created ||
        fingerprint(item, copiedPositions) !== fingerprint(expected[index], expectedPositions)))
        throw new Error(`OpenCode 返回的分支与指定截点不一致（已创建原生会话 ${created}）`);
      return { status: 'forked', token: created };
    });
  } catch (error) {
    if (error instanceof ConnectionCleanupError) {
      if (created) throw new ConnectionCleanupError(`${error.message}（已创建原生会话 ${created}）`);
      throw error;
    }
    if (created && !(error as Error).message.includes(created)) throw new Error(`${(error as Error).message}（已创建原生会话 ${created}）`);
    if (forkSubmitted && !created) throw new Error(`OpenCode 分叉状态未知，请先检查 OpenCode 会话列表：${(error as Error).message}`);
    throw error;
  }
}
