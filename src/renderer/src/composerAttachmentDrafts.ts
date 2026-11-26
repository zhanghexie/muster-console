import type { ChatImageAttachment } from '../../shared/types';

/** 待发附件仅在本次应用运行中保留；异步读取可跨组件重挂继续完成。 */
export interface ComposerAttachmentDraft {
  images: ChatImageAttachment[];
  pending: number;
  error?: string;
  listeners: Set<() => void>;
}

const drafts = new Map<string, ComposerAttachmentDraft>();

export function composerAttachmentDraft(scope: string): ComposerAttachmentDraft {
  let draft = drafts.get(scope);
  if (!draft) {
    draft = { images: [], pending: 0, listeners: new Set() };
    drafts.set(scope, draft);
  }
  return draft;
}

export function isCurrentAttachmentDraft(scope: string, draft: ComposerAttachmentDraft): boolean {
  return drafts.get(scope) === draft;
}

export function notifyAttachmentDraft(draft: ComposerAttachmentDraft): void {
  for (const listener of draft.listeners) listener();
}

/** 会话删除时释放内存并使仍在途的文件读取失效。 */
export function clearAttachmentDraft(scope: string): void {
  const draft = drafts.get(scope);
  if (!draft) return;
  drafts.delete(scope);
  draft.images = [];
  draft.pending = 0;
  draft.error = undefined;
  notifyAttachmentDraft(draft);
}
