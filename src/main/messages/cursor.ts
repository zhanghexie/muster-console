/** Opaque receive positions. They confer no access; every read still filters by trusted actor. */
export interface MailboxCursor {
  v: 1;
  owner: string;
  box: 'inbox' | 'sent';
  scope: string;
  positions: Record<string, number>;
  since?: number;
  body?: { workspaceId: string; id: string; offset: number };
}

export function encodeMailboxCursor(cursor: MailboxCursor): string {
  const value = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (value.length > 8192) throw new Error('收信游标过大，请用 mailboxWorkspaceId 缩小范围');
  return value;
}

export function decodeMailboxCursor(value: string, binding: Pick<MailboxCursor, 'owner' | 'box' | 'scope'>): MailboxCursor {
  try {
    if (!value || value.length > 8192 || !/^[\w-]+$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as MailboxCursor;
    const record = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o);
    if (c.v !== 1 || c.owner !== binding.owner || c.box !== binding.box || c.scope !== binding.scope ||
      !record(c.positions) ||
      (c.since !== undefined && !Number.isFinite(c.since)) ||
      Object.entries(c.positions).some(([id, seq]) => !id || id.length > 100 || !Number.isSafeInteger(seq) || seq < 0) ||
      (c.body && (!record(c.body) || typeof c.body.workspaceId !== 'string' || typeof c.body.id !== 'string' ||
        !Number.isSafeInteger(c.body.offset) || c.body.offset < 0))) throw new Error();
    return c;
  } catch {
    throw new Error('收信游标无效或不属于当前邮箱/box/工作区范围；恢复时请复用原调用范围');
  }
}
