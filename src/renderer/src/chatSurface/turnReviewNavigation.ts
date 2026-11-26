import type { TurnChangeTarget } from '../../../shared/turnChanges';
export const TURN_REVIEW_EVENT = 'muster:turn-review';
export function openTurnReview(target: TurnChangeTarget, filePath?: string): void {
  window.dispatchEvent(new CustomEvent(TURN_REVIEW_EVENT, { detail: { target, filePath } }));
}
