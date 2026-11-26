import { MAIL_COLLECT_MS, MAIL_SEND_PREVIEW_MS, type MailActivity } from '../../../../shared/mailActivity';

// Reading/coalescing policy, not animation durations. Motion tracks stay in EnvelopePaper.
export const MAIL_READ_MS = 2200;
export const MAIL_STACK_MAX = 4;
export type MailDirection = 'send' | 'receive';
export type MailPhase = 'collect' | 'preview' | 'motion' | 'exit';
export interface MailBatch {
  direction: MailDirection;
  letters: MailActivity[];
  departureIds: string[];
  count: number;
  firstAt: number;
  lastAt: number;
}
export interface MailEnvelopeState { active: (MailBatch & { phase: MailPhase; previewAt: number }) | null; pendingReceive: MailBatch | null }
export const emptyMailEnvelopeState = (): MailEnvelopeState => ({ active: null, pendingReceive: null });
export type MailEnvelopeAction =
  | { type: 'arrive'; direction: MailDirection; letter: MailActivity; now: number; departureId?: string }
  | { type: 'begin' }
  | { type: 'motionDone'; now: number }
  | { type: 'dismiss' }
  | { type: 'next'; now: number }
  | { type: 'reset' };

const start = (b: MailBatch, now: number) => ({ ...b, firstAt: now, lastAt: now,
  phase: (b.direction === 'send' ? 'preview' : 'collect') as MailPhase, previewAt: now });
const append = <T extends MailBatch>(batch: T, letter: MailActivity, now: number, departureId?: string): T => ({ ...batch,
  count: batch.count + 1, lastAt: now, letters: batch.letters.length < MAIL_STACK_MAX ? [...batch.letters, letter] : batch.letters,
  departureIds: departureId ? [...batch.departureIds, departureId] : batch.departureIds });

/** Outgoing previews are never queued. Receipts can wait in one bounded display batch. */
export function mailEnvelopeReducer(state: MailEnvelopeState, action: MailEnvelopeAction): MailEnvelopeState {
  const active = state.active;
  if (action.type === 'reset') return emptyMailEnvelopeState();
  if (action.type === 'arrive') {
    const { letter, direction, now, departureId } = action;
    const batch = { direction, letters: [letter], departureIds: departureId ? [departureId] : [], count: 1, firstAt: now, lastAt: now };
    if (!active) return { ...state, active: start(batch, now) };
    if (active.direction === direction && ((direction === 'send' && active.phase === 'preview') || active.phase === 'collect'))
      return { ...state, active: append(active, letter, now, departureId) };
    if (direction === 'send') return state;
    return { ...state, pendingReceive: state.pendingReceive ? append(state.pendingReceive, letter, now) : batch };
  }
  if (!active) return state;
  if (action.type === 'begin') return { ...state, active: { ...active, phase: 'motion' } };
  if (action.type === 'motionDone') return { ...state, active: { ...active,
    phase: active.direction === 'send' ? 'exit' : 'preview', previewAt: action.now } };
  if (action.type === 'dismiss') return { ...state, active: { ...active, phase: 'exit' } };
  if (action.type === 'next') return { active: state.pendingReceive ? start(state.pendingReceive, action.now) : null, pendingReceive: null };
  return state;
}

export function mailPreviewDeadline(batch: MailBatch & { previewAt: number }): number {
  if (batch.direction === 'receive') return batch.previewAt + MAIL_READ_MS;
  const minimum = batch.previewAt + MAIL_SEND_PREVIEW_MS;
  return Math.max(minimum, Math.min(minimum + MAIL_COLLECT_MS, batch.lastAt + MAIL_COLLECT_MS));
}
