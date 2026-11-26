/** Host-owned, in-memory approval. A user message revokes the current generation. */
export class DesktopTurnGrants {
  private readonly generations = new Map<string, number>();
  private readonly grants = new Map<string, { generation: number; expires: number }>();
  private readonly nativeMessages = new Set<string>();
  private readonly transitions = new Map<string, number>();
  /** Block grants until user input delivery resolves; concurrent deliveries nest. */
  beginUserDelivery(sessionId: string): () => void {
    this.nextUserMessage(sessionId);
    this.transitions.set(sessionId, (this.transitions.get(sessionId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.nextUserMessage(sessionId);
      const remaining = (this.transitions.get(sessionId) ?? 1) - 1;
      if (remaining) this.transitions.set(sessionId, remaining);
      else this.transitions.delete(sessionId);
    };
  }
  noteNativeMessage(sessionId: string, messageId: string): void { this.nativeMessages.add(JSON.stringify([sessionId, messageId])); }
  consumeNativeMessage(sessionId: string, messageId: string): boolean { return this.nativeMessages.delete(JSON.stringify([sessionId, messageId])); }
  private readonly tails = new Map<string, Promise<void>>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly ttl = 30 * 60_000) {}

  nextUserMessage(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    this.grants.delete(sessionId);
  }
  observePiMessage(sessionId: string, event: { type: string; message?: unknown }): void {
    if (event.type === 'message_start' && event.message && typeof event.message === 'object' &&
        (event.message as { role?: unknown }).role === 'user') this.nextUserMessage(sessionId);
  }
  capture(sessionId: string): () => boolean {
    const generation = this.generations.get(sessionId) ?? 0;
    return () => generation === (this.generations.get(sessionId) ?? 0);
  }
  current(sessionId: string): boolean {
    const grant = this.grants.get(sessionId);
    return !this.transitions.has(sessionId) && !!grant && grant.generation === (this.generations.get(sessionId) ?? 0) && grant.expires > this.now();
  }
  async authorize(sessionId: string, isCurrent: () => boolean, confirm: () => Promise<boolean>, audit: (approved: boolean) => void): Promise<() => boolean> {
    const generation = this.generations.get(sessionId) ?? 0;
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const operation = prior.then(async () => {
      const live = () => !this.transitions.has(sessionId) && isCurrent() && generation === (this.generations.get(sessionId) ?? 0);
      if (!live()) throw new Error('Desktop turn changed');
      if (!this.current(sessionId)) {
        const approved = await confirm();
        audit(approved);
        if (!live()) throw new Error('Desktop turn changed');
        if (!approved) throw new Error('Desktop turn authorization declined');
        this.grants.set(sessionId, { generation, expires: this.now() + this.ttl });
      }
      const grant = this.grants.get(sessionId)!;
      return () => live() && this.grants.get(sessionId) === grant && grant.expires > this.now();
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return operation;
  }
}
export const desktopTurnGrants = new DesktopTurnGrants();
