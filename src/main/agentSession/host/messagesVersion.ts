import { randomUUID } from 'node:crypto';

// Entry identity owns its generation; the WeakMap neither retains closed entries nor
// aliases a prior main process when a browser client reconnects with an old token.
const versions = new WeakMap<object, { epoch: string; revision: number }>();
const liveSequences = new WeakMap<object, number>();

function stateOf(entry: object): { epoch: string; revision: number } {
  let state = versions.get(entry);
  if (!state) {
    state = { epoch: randomUUID(), revision: 0 };
    versions.set(entry, state);
  }
  return state;
}

export function guiMessagesVersion(entry: object): string {
  const state = stateOf(entry);
  return `${state.epoch}:${state.revision}`;
}

export function advanceGuiMessagesVersion(entry: object): void {
  const state = stateOf(entry);
  if (state.revision === Number.MAX_SAFE_INTEGER) {
    state.epoch = randomUUID();
    state.revision = 0;
  } else state.revision++;
}

/** Live message delivery cursor. It is separate from the durable checkpoint
 * revision because hidden persist-only writes must not manufacture renderer gaps. */
export function advanceGuiLiveSequence(entry: object): number {
  const next = (liveSequences.get(entry) ?? 0) + 1;
  liveSequences.set(entry, next);
  return next;
}

export function guiLiveSequence(entry: object): number | undefined {
  return liveSequences.get(entry);
}
