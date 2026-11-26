import type { Win32Input } from './win32Input';

type Events = Parameters<Win32Input['send']>[0];
type Key = Extract<Events[number], { kind: 'key' }>;
const mouseUps = new Map([[0x0002, 0x0004], [0x0008, 0x0010], [0x0020, 0x0040]]);
const mouseDowns = new Map([...mouseUps].map(([down, up]) => [up, down]));

/** Tracks only this adapter's synthetic presses; OS input state may still overlap with physical input. */
export class TrackedWin32Input {
  private readonly keys = new Map<string, Key>();
  private readonly buttons = new Map<number, number>();
  constructor(private readonly input: Pick<Win32Input, 'move' | 'send'>) {}

  move(x: number, y: number): void { this.input.move(x, y); }

  send(events: Events): void {
    // The desktop executor sends single records; reject rather than silently
    // losing partial-dispatch information for an untracked future batch.
    if (!Array.isArray(events) || events.length !== 1) throw new Error('Tracked desktop input requires one event');
    const event = events[0]!;
    if (event.kind === 'key') {
      const flags = event.flags ?? 0, key = `${event.vk ?? 0}:${event.scan ?? 0}:${flags & ~2}`;
      if (flags & 2) {
        if (!this.keys.has(key)) return;
        this.input.send([event]);
        this.keys.delete(key);
      } else {
        // A native call may partially dispatch before throwing; remember the
        // key before entering it so cleanup still attempts its release.
        this.keys.set(key, { ...event, flags: flags | 2 });
        this.input.send([event]);
      }
      return;
    }
    const up = mouseUps.get(event.flags), down = mouseDowns.get(event.flags);
    if (up !== undefined) {
      this.buttons.set(event.flags, up);
      this.input.send([event]);
    } else if (down !== undefined) {
      if (!this.buttons.has(down)) return;
      this.input.send([event]);
      this.buttons.delete(down);
    } else this.input.send([event]);
  }

  /** Keep failed releases tracked so the seat cannot be marked clean by accident. */
  async releaseAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const [key, event] of this.keys) {
      try { this.input.send([event]); this.keys.delete(key); } catch (error) { errors.push(error); }
    }
    for (const [down, up] of this.buttons) {
      try { this.input.send([{ kind: 'mouse', flags: up }]); this.buttons.delete(down); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Desktop held-input release failed');
  }
}
