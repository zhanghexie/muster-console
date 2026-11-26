import type { UiWidgetActionResult } from '../../../shared/uiWidgetProtocol';
export const UI_FOLLOWUP_EVENT = 'ma-ui-followup';
export interface UiFollowupDetail {
  text: string;
  el: Element | null;
  sessionId?: string;
  mode?: 'draft' | 'send';
  claim?: () => boolean;
  respond?: (result: UiWidgetActionResult) => void;
}
