import { randomUUID } from 'node:crypto';
import type { DesktopTurns } from './desktopTurns';

export interface PtyDesktopBinding {
  /** Both fields come from the host, not from PTY output or tool arguments. */
  readonly processGeneration: string;
  readonly sessionToken: object;
  isCurrent(): boolean;
}
export interface PtyDesktopTurn {
  readonly sessionId: string;
  readonly desktopTurnId: string;
  isDesktopCurrent(): boolean;
}
type Entry = { sessionId: string; turnId: string; binding: PtyDesktopBinding };

/** PTYs do not expose a trustworthy model turn boundary: keep one explicit session lease until input or process replacement. */
export class PtyDesktopTurns {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly turns: DesktopTurns) {}

  /** Called at a trusted human submission boundary before any attachment processing. */
  noteUserInstruction(sessionId: string, messageId: string): void {
    this.turns.noteUserInstruction(sessionId, messageId);
  }

  /** Call only after a trusted native engine event confirms consumption of the user's instruction. A PTY write alone is not enough. */
  beginUserInstruction(sessionId: string, messageId: string, binding: PtyDesktopBinding): PtyDesktopTurn {
    if (!messageId) throw new Error('CLI desktop instruction identity is unavailable');
    return this.replace(sessionId, binding, messageId);
  }

  /** Capture the existing host lease; a new process has no implicit post-stop user instruction. */
  capture(sessionId: string, binding: PtyDesktopBinding): PtyDesktopTurn {
    this.validate(sessionId, binding);
    const existing = this.entries.get(sessionId);
    if (existing && existing.binding.processGeneration === binding.processGeneration &&
        existing.binding.sessionToken === binding.sessionToken && this.current(existing)) return this.view(existing, binding.isCurrent);
    return this.replace(sessionId, binding);
  }

  end(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.turns.end(sessionId, entry.turnId);
  }

  private replace(sessionId: string, binding: PtyDesktopBinding, instructionId?: string): PtyDesktopTurn {
    this.validate(sessionId, binding);
    if (!this.entries.has(sessionId) && this.entries.size >= 512) {
      for (const [owner, entry] of this.entries) if (!this.current(entry)) this.end(owner);
      if (this.entries.size >= 512) throw new Error('CLI desktop session capacity exceeded');
    }
    this.end(sessionId);
    const entry: Entry = { sessionId, turnId: randomUUID(), binding };
    this.entries.set(sessionId, entry);
    try {
      this.turns.begin(sessionId, entry.turnId, () => this.current(entry), !!instructionId, instructionId);
      return this.view(entry);
    } catch (error) { this.entries.delete(sessionId); throw error; }
  }

  private view(entry: Entry, requestBinding?: () => boolean): PtyDesktopTurn {
    return Object.freeze({ sessionId: entry.sessionId, desktopTurnId: entry.turnId, isDesktopCurrent: () => {
      if (!this.current(entry)) return false;
      try { return requestBinding ? requestBinding() === true : true; } catch { return false; }
    } });
  }

  private current(entry: Entry): boolean {
    if (this.entries.get(entry.sessionId) !== entry) return false;
    try { return entry.binding.isCurrent() === true; } catch { return false; }
  }

  private validate(sessionId: string, binding: PtyDesktopBinding): void {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !binding || typeof binding.processGeneration !== 'string' ||
      !binding.processGeneration || !binding.sessionToken || typeof binding.sessionToken !== 'object' || typeof binding.isCurrent !== 'function' ||
      !binding.isCurrent()) throw new Error('CLI desktop session is unavailable');
  }
}
