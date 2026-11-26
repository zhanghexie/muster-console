/** Ephemeral presentation of a newly committed letter. Never a model message or a read receipt. */
export interface MailActivity {
  id: string;
  mailboxWorkspaceId: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  subject?: string;
  text: string;
  totalChars: number;
  ts: number;
}

export interface MailDepartureRequest {
  requestId: string;
  viewportId: string;
  letter: MailActivity;
}

export type MailPresentationResult = { ok: true } | { ok: false; error: string };

export const MAIL_SEND_PREVIEW_MS = 1000;
export const MAIL_COLLECT_MS = 500;

export function canonicalMailboxId(id: string, workspaceId: string): string {
  return id === 'scheduler' ? `orchestrator:${workspaceId}` : id;
}

export function projectMailActivity(mailboxWorkspaceId: string,
  mail: Pick<MailActivity, 'id' | 'from' | 'to' | 'ts' | 'subject'> & Partial<Pick<MailActivity, 'fromName' | 'toName'>>,
  body: string): MailActivity | undefined {
  const to = canonicalMailboxId(mail.to, mailboxWorkspaceId);
  if (mail.from === 'human' || mail.from === 'host' || mail.from === to) return;
  let text = body.slice(0, 1400);
  // Preserve UTF-16 pairs at the preview boundary.
  if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) text = text.slice(0, -1);
  return { id: mail.id, mailboxWorkspaceId, from: mail.from, to, fromName: mail.fromName || mail.from,
    toName: mail.toName || to, subject: mail.subject, text, totalChars: body.length, ts: mail.ts };
}
