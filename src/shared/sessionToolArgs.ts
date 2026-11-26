/** Explicit modes are strict; omitted modes retain the legacy target-based behavior. */
export function validateObserveMode(args: Record<string, unknown>): void {
  if (args.mode === undefined) return;
  if (args.mode !== 'directory' && args.mode !== 'detail') throw new Error('mode must be directory or detail.');
  const target = Boolean(String(args.sessionId ?? '').trim() || String(args.externalSessionId ?? '').trim());
  if (args.mode === 'detail' && !target) throw new Error('detail requires sessionId or externalSessionId.');
  const incompatible = args.mode === 'directory'
    ? ['sessionId', 'externalSessionId', 'includeGit', 'includeHistory', 'historyLimit', 'facts']
    : ['includeArchived', 'includeShell', 'archivedOnly', 'lastUsedBefore', 'nameContains', 'shortId', 'worktreePath', 'limit', 'offset'];
  const keys = incompatible.filter(key => args[key] !== undefined);
  if (keys.length) throw new Error(`${args.mode} does not accept: ${keys.join(', ')}.`);
}

/** Translate unambiguous model-facing offsets into the existing mailbox contract. */
export function normalizeMailboxOffsets<T extends { messageId?: string; offset?: number; listOffset?: number; bodyOffset?: number; cursor?: string; includeBody?: boolean; box?: string }>(args: T): T {
  if (args.listOffset === undefined && args.bodyOffset === undefined) return args;
  const body = Boolean(args.messageId);
  if (body && args.listOffset !== undefined) throw new Error('listOffset cannot be used with messageId; use bodyOffset.');
  if (!body && args.bodyOffset !== undefined) throw new Error('bodyOffset requires messageId.');
  if (args.cursor !== undefined) throw new Error('Use cursor continuation or an explicit offset, not both.');
  if (!body && (args.includeBody === true || (args.includeBody !== false && args.box !== 'sent'))) {
    throw new Error('listOffset is for summary lists (includeBody=false or default sent); batch/wait reads use cursor.');
  }
  const offset = body ? args.bodyOffset! : args.listOffset!;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Offset must be a non-negative safe integer.');
  if (args.offset !== undefined && args.offset !== offset) throw new Error('Legacy offset conflicts with the explicit offset.');
  const { listOffset: _list, bodyOffset: _body, ...rest } = args;
  return { ...rest, offset } as T;
}
