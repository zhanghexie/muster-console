export type ImapMailboxIdentity = { imapHost: string; imapPort: number; user: string; mailbox: string };

export function imapMailboxKey({ imapHost, imapPort, user, mailbox }: ImapMailboxIdentity): string {
  if (typeof imapHost !== 'string' || !/^[a-zA-Z0-9.:-]{1,254}$/u.test(imapHost) || !Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535 ||
      typeof user !== 'string' || !user.trim() || user.includes('\0') || typeof mailbox !== 'string' || !mailbox.trim() || mailbox.includes('\0')) {
    throw new Error('imap-mailbox-identity-invalid');
  }
  const host = imapHost.replace(/\.$/u, '').toLowerCase();
  if (!host || host.endsWith('.')) throw new Error('imap-mailbox-identity-invalid');
  return JSON.stringify([host, imapPort, user, /^[Ii][Nn][Bb][Oo][Xx]$/u.test(mailbox) ? 'INBOX' : mailbox]);
}

export const legacyImapOwner = (workspaceId: string, connectionId: string): string => JSON.stringify(['agent-apps', workspaceId, connectionId]);

type Reservation = { owner: string; leases: number };

/** One host-wide consumer per exact authenticated IMAP folder. */
export class ImapConsumerArbiter {
  private readonly reservations = new Map<string, Reservation>();

  claim(mailbox: ImapMailboxIdentity, owner: string): () => void {
    const key = imapMailboxKey(mailbox);
    const existing = this.reservations.get(key);
    if (existing && existing.owner !== owner) throw Object.assign(new Error('imap-mailbox-in-use'), { code: 'imap-mailbox-in-use' });
    const reservation = existing ?? { owner, leases: 0 };
    reservation.leases++;
    this.reservations.set(key, reservation);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--reservation.leases === 0) this.reservations.delete(key);
    };
  }
}

export const imapConsumerArbiter = new ImapConsumerArbiter();
