import { t } from '../../../../shared/i18n';
import type { NativeSessionHistoryAction } from '../../../../shared/sessionLifecycle';
import { openCodeBody, withOpenCodeServer, type OpenCodeRequest, type OpenCodeServerInput } from './opencodeServer';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const isOpenCodeHistoryId = (id: string): boolean => /^ses_[A-Za-z0-9_-]{1,180}$/.test(id);

async function isOpenCodeV2(request: OpenCodeRequest): Promise<boolean> {
  const anonymous = await request('/api/info', false);
  if (anonymous.status !== 401) { await anonymous.body?.cancel(); return false; }
  const response = await request('/api/info', true);
  if (response.status === 404 || response.status === 405) { await response.body?.cancel(); return false; }
  if (!response.ok) throw new Error(`OpenCode 本地 API 认证失败（${response.status}）`);
  const info = object(JSON.parse(await openCodeBody(response)));
  return typeof info.version === 'string' && info.version.length > 0 && Array.isArray(info.urls);
}

export async function probeOpenCodeHistory(input: OpenCodeServerInput): Promise<boolean> {
  return withOpenCodeServer(input, isOpenCodeV2);
}

async function assertUnsharedDescendants(request: OpenCodeRequest, id: string, otherSessionIds: ReadonlySet<string>): Promise<void> {
  const pending = [id];
  const seen = new Set(pending);
  for (const parentID of pending) {
    let cursor: string | null | undefined;
    do {
      const params = new URLSearchParams(cursor ? { cursor } : { parentID, limit: '100' });
      const response = await request(`/api/session?${params}`, true);
      const page = object(JSON.parse(await openCodeBody(response)));
      const next = object(page.cursor).next;
      if (!response.ok || !Array.isArray(page.data) || (next != null && (typeof next !== 'string' || next === cursor || !page.data.length))) {
        throw new Error(t('OpenCode 未确认关联的原生会话状态。'));
      }
      for (const row of page.data) {
        const child = object(row);
        if (child.parentID !== parentID || typeof child.id !== 'string' || !isOpenCodeHistoryId(child.id) || seen.has(child.id)) {
          throw new Error(t('OpenCode 未确认关联的原生会话状态。'));
        }
        if (otherSessionIds.has(child.id)) throw new Error(t('关联的原生会话还被另一条集序会话使用。'));
        seen.add(child.id);
        pending.push(child.id);
      }
      cursor = next;
    } while (cursor);
  }
}

export async function updateOpenCodeHistory(input: OpenCodeServerInput, id: string, action: NativeSessionHistoryAction,
  otherSessionIds?: ReadonlySet<string>): Promise<void> {
  if (!isOpenCodeHistoryId(id)) throw new Error(t('会话状态已变化，请重新扫描。'));
  await withOpenCodeServer(input, async request => {
    if (!await isOpenCodeV2(request)) {
      throw new Error(t('{{provider}} 当前版本未声明此会话历史能力。', { provider: 'OpenCode' }));
    }
    const route = `/api/session/${encodeURIComponent(id)}`;
    const read = async (): Promise<boolean | undefined> => {
      const response = await request(route, true);
      const value = object(JSON.parse(await openCodeBody(response)));
      if (response.status === 404 && value._tag === 'SessionNotFoundError') return undefined;
      const session = object(value.data);
      const archived = object(session.time).archived;
      if (!response.ok || session.id !== id || (archived != null && typeof archived !== 'number')) {
        throw new Error(t('OpenCode 未确认关联的原生会话状态。'));
      }
      return typeof archived === 'number';
    };

    const before = await read();
    if (before === undefined && action !== 'unarchive') return;
    if (before === undefined) throw new Error(t('OpenCode 已找不到关联的原生会话。'));
    const deleting = action === 'delete';
    const archive = action === 'archive';
    if (!deleting && before === archive) return;
    if (deleting && otherSessionIds?.size) await assertUnsharedDescendants(request, id, otherSessionIds);
    const response = await request(route, true, deleting ? { method: 'DELETE' } : {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: archive })
    });
    if (response.status !== 204) {
      await response.body?.cancel();
      if (deleting && response.status === 404 && await read() === undefined) return;
      throw new Error(t('OpenCode 历史操作失败（{{status}}）。', { status: response.status }));
    }
    if (await read() !== (deleting ? undefined : archive)) {
      throw new Error(t('OpenCode 未确认关联的原生会话状态。'));
    }
  });
}
