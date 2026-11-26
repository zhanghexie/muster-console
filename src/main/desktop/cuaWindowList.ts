import { createHash, randomUUID } from 'node:crypto';
import type { CuaSemanticActor, CuaSemanticTarget } from './cuaSemanticRuntime';
import type { CuaConnection } from './cuaTransport';

const TTL_MS = 60_000;
const ROW_LIMIT = 2000;
type WindowListActor = Pick<CuaSemanticActor, 'sessionId' | 'turnId' | 'lifetimeSignal' | 'isCurrent'>;
const clean = (value: unknown) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 120) : '';

async function readWindows(connection: CuaConnection, signal: AbortSignal, pid?: number) {
  const result = await connection.call('list_windows', { on_screen_only: true, ...(pid ? { pid } : {}) }, signal) as {
    isError?: boolean; structuredContent?: { windows?: unknown } } | undefined;
  signal.throwIfAborted();
  const rows = result?.structuredContent?.windows;
  if (result?.isError || !Array.isArray(rows)) throw new Error('Cua could not enumerate windows in the active desktop session.');
  const windows = rows.slice(0, ROW_LIMIT).flatMap(row => {
    if (row?.is_on_screen !== true) return [];
    const { pid, window_id: windowId, bounds } = row;
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(windowId) || windowId < 1 || !bounds ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return [];
    const frame = [bounds.x, bounds.y, bounds.width, bounds.height] as number[];
    return [{ pid: pid as number, windowId: windowId as number, frame, title: clean(row.title), app: clean(row.app_name) }];
  });
  return { windows, complete: rows.length <= ROW_LIMIT && windows.length === rows.length };
}

/** A Cua listing is a bounded, turn-local selection, never an input authorization. */
export class CuaWindowList {
  private readonly selections = new Map<string, CuaSemanticTarget & { owner: string }>();
  private cleanupFailure?: Error;

  constructor(private readonly connect: () => CuaConnection, private readonly environmentCurrent: () => boolean) {}

  async list(actor: WindowListActor, offset: number, limit: number, signal?: AbortSignal) {
    this.assertClean();
    const active = AbortSignal.any([...(signal ? [signal] : []), ...(actor.lifetimeSignal ? [actor.lifetimeSignal] : []), AbortSignal.timeout(15_000)]);
    const current = () => actor.isCurrent() && !actor.lifetimeSignal?.aborted && this.environmentCurrent();
    active.throwIfAborted();
    if (!current()) throw new Error('The desktop session changed.');
    const driver = this.connect();
    let result: Awaited<ReturnType<typeof readWindows>>;
    const abort = () => { void driver.close().catch(() => undefined); };
    active.addEventListener('abort', abort, { once: true });
    if (active.aborted) abort();
    try {
      await driver.connect();
      result = await readWindows(driver, active);
    } finally {
      active.removeEventListener('abort', abort);
      try { await driver.close(); }
      catch (error) { throw this.cleanupFailure = new Error('Window discovery driver cleanup is unconfirmed.', { cause: error }); }
    }
    active.throwIfAborted();
    if (!current()) throw new Error('The desktop session changed.');
    this.prune();
    const owner = this.owner(actor), expiresAt = Date.now() + TTL_MS;
    const page = result.windows.slice(offset, offset + limit);
    const windows = page.map(row => {
      const id = `cua-window:${randomUUID()}`;
      const generation = createHash('sha256').update(JSON.stringify([row.pid, row.windowId, row.frame])).digest('hex');
      if (this.selections.size >= 512) this.selections.delete(this.selections.keys().next().value!);
      let valid = true;
      const isCurrent = () => valid && current() && this.selections.has(id) && Date.now() < expiresAt;
      this.selections.set(id, { owner, pid: row.pid, windowId: row.windowId, generation, isCurrent,
        verify: async (connection, operation) => {
          if (!isCurrent()) throw new Error('The window selection expired.');
          const observed = await readWindows(connection, operation, row.pid);
          const matches = observed.windows.filter(window => window.pid === row.pid && window.windowId === row.windowId);
          valid = matches.length === 1 && matches[0].frame.every((value, index) => value === row.frame[index]);
          if (!isCurrent()) throw new Error('The selected window moved, closed or became unavailable.');
        } });
      return { windowId: id, app: row.app, title: row.title };
    });
    const nextOffset = offset + page.length < result.windows.length ? offset + page.length : null;
    return { windows, nextOffset, expiresAt, complete: result.complete && nextOffset === null };
  }

  resolve(actor: CuaSemanticActor, id: string): CuaSemanticTarget | undefined {
    if (!id.startsWith('cua-window:')) return undefined;
    this.assertClean();
    const target = this.selections.get(id);
    if (!target || target.owner !== this.owner(actor) || !target.isCurrent() || !actor.isCurrent()) {
      throw new Error('The window selection expired. List windows again.');
    }
    return target;
  }

  clear(): void { this.selections.clear(); this.assertClean(); }
  private assertClean(): void { if (this.cleanupFailure) throw this.cleanupFailure; }
  private owner(actor: WindowListActor): string { return JSON.stringify([actor.sessionId, actor.turnId]); }
  private prune(): void { for (const [id, item] of this.selections) if (!item.isCurrent()) this.selections.delete(id); }
}
