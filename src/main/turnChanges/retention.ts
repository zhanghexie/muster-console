import fs from 'node:fs';
import path from 'node:path';
import type { TurnChanges } from '../../shared/turnChanges';

export interface SnapshotMessage { id: string; role: string; turnChanges?: TurnChanges }
export interface SnapshotReference { id: string; messageId: string }
type Messages = readonly SnapshotMessage[];
type MessageReader = () => Messages | Promise<Messages>;

const validId = (id: string): boolean => /^[0-9a-f-]{36}$/i.test(id);

/** A snapshot is usable only if the file still belongs to this exact turn. */
async function readSnapshot(dir: string, owner: string, ref: SnapshotReference): Promise<'usable' | 'invalid' | 'missing'> {
  if (!validId(ref.id)) return 'invalid';
  let text: string;
  try { text = await fs.promises.readFile(path.join(dir, `${ref.id}.json`), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  let record: any;
  try { record = JSON.parse(text); } catch { return 'invalid'; }
  return record?.owner === owner && record.messageId === ref.messageId && record.summary?.id === ref.id &&
    record.summary?.state === 'ready' && Array.isArray(record.roots) && Array.isArray(record.files) && record.files.length > 0 &&
    record.files.every((file: any) => file && typeof file.diff === 'string' && typeof file.view?.path === 'string')
    ? 'usable' : 'invalid';
}

function references(messages: Messages): Array<SnapshotReference & { state: TurnChanges['state']; hasFiles: boolean }> {
  return messages.flatMap(message => message.role === 'assistant' && message.turnChanges?.id
    ? [{ id: message.turnChanges.id, messageId: message.id, state: message.turnChanges.state, hasFiles: Array.isArray(message.turnChanges.files) && message.turnChanges.files.length > 0 }]
    : []);
}

/** Use transcript order, never file mtime: a revert can rewrite an older record. */
export async function latestAvailableSnapshot(dir: string, owner: string, messages: Messages): Promise<SnapshotReference | null> {
  const refs = references(messages);
  if (!refs.some(ref => ref.state === 'ready' && ref.hasFiles && validId(ref.id))) return null;
  let names: Set<string>;
  try { names = new Set(await fs.promises.readdir(dir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    if (ref.state === 'ready' && ref.hasFiles && names.has(`${ref.id}.json`) && await readSnapshot(dir, owner, ref) === 'usable') return { id: ref.id, messageId: ref.messageId };
  }
  return null;
}

/** Keep the newest usable snapshot after its transcript reference is durable.
 * In-flight captures/reverts stay protected; a later pass can remove them. */
export async function retainLatestSnapshots(
  dir: string,
  owner: string,
  readLive: MessageReader,
  readDurable: MessageReader,
  opts: { extra?: readonly SnapshotReference[]; protectedId?: (id: string) => boolean; fallbackToExtra?: boolean } = {}
): Promise<{ latestId: string | null; removedIds: string[]; deferred: boolean }> {
  const live = await readLive(), durable = await readDurable();
  const [latestLive, latestDurable] = await Promise.all([
    latestAvailableSnapshot(dir, owner, live), latestAvailableSnapshot(dir, owner, durable)
  ]);
  let selected = latestLive;
  if (!latestLive && !latestDurable && opts.fallbackToExtra && !references(live).some(ref => ref.state === 'collecting')) {
    // Legacy scheduler records have only a workspace owner. Their caller supplies
    // oldest-to-newest file order when no conversation references survive.
    for (const ref of [...(opts.extra ?? [])].reverse()) {
      if (!opts.protectedId?.(ref.id) && await readSnapshot(dir, owner, ref) === 'usable') { selected = ref; break; }
    }
  } else if (!latestLive || !latestDurable || latestLive.id !== latestDurable.id || latestLive.messageId !== latestDurable.messageId) {
    return { latestId: latestLive?.id ?? null, removedIds: [], deferred: true };
  }
  if (!selected) return { latestId: null, removedIds: [], deferred: true };
  const candidates = new Map<string, SnapshotReference>();
  for (const ref of [...references(live), ...references(durable), ...(opts.extra ?? [])]) candidates.set(ref.id, ref);
  const removedIds: string[] = [];
  for (const candidate of candidates.values()) {
    if (candidate.id === selected.id || !validId(candidate.id) || opts.protectedId?.(candidate.id)) continue;
    const current = references(await readLive());
    if (current.some(ref => ref.id === candidate.id && ref.state === 'collecting')) continue;
    // A newly published turn can overtake this pass. Never delete it using a stale plan.
    const currentIndex = current.findIndex(ref => ref.id === selected.id && ref.messageId === selected.messageId);
    const candidateIndex = current.findIndex(ref => ref.id === candidate.id && ref.messageId === candidate.messageId);
    if (candidateIndex >= 0 && (currentIndex < 0 || candidateIndex > currentIndex)) continue;
    try { await fs.promises.access(path.join(dir, `${selected.id}.json`), fs.constants.R_OK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { latestId: null, removedIds, deferred: true };
      throw error;
    }
    if (await readSnapshot(dir, owner, candidate) !== 'usable' || opts.protectedId?.(candidate.id)) continue;
    try { await fs.promises.unlink(path.join(dir, `${candidate.id}.json`)); removedIds.push(candidate.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { latestId: selected.id, removedIds, deferred: false };
}
