type Binding = Readonly<{ epoch: string; generation: number; anchor: string }>;
type WaitEpoch = Readonly<{ waitId: string; epoch: string | null; generation: number | null; uncertain: boolean }>;
type Turn = { turnId: string; binding?: Binding; conflict?: string };

/** Host-only staging guard. Delivery and turn lifecycle must invoke it before exposing desktop writes. */
export class DesktopTurnEpochGuard {
  private readonly turns = new Map<string, Turn>();
  private valid(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid desktop turn identity');
  }
  private turn(sessionId: string, turnId: string): Turn {
    this.valid(sessionId); this.valid(turnId);
    const turn = this.turns.get(sessionId);
    if (!turn || turn.turnId !== turnId) throw new Error('Desktop turn is not current');
    return turn;
  }
  private bind(turn: Turn, candidate: Binding): void {
    this.valid(candidate.epoch); this.valid(candidate.anchor);
    if (!Number.isSafeInteger(candidate.generation) || candidate.generation < 0) throw new Error('Invalid desktop epoch generation');
    if (!turn.binding) turn.binding = { ...candidate };
    else if ((turn.binding.epoch !== candidate.epoch || turn.binding.generation !== candidate.generation) && !turn.conflict) {
      turn.conflict = t('桌面任务 epoch 冲突（{{firstSource}}={{firstEpoch}}；{{secondSource}}={{secondEpoch}}）；此回合桌面写入已冻结，需显式开始新桌面任务链。', {
        firstSource: turn.binding.anchor, firstEpoch: `${turn.binding.epoch}#${turn.binding.generation}`,
        secondSource: candidate.anchor, secondEpoch: `${candidate.epoch}#${candidate.generation}`
      });
    } else if (!turn.conflict) turn.binding = { ...candidate };
  }
  begin(sessionId: string, turnId: string): void {
    this.valid(sessionId); this.valid(turnId);
    if (this.turns.has(sessionId)) throw new Error('Desktop turn is already active');
    this.turns.set(sessionId, { turnId });
  }
  /** Called for trusted host continuation metadata; external message bodies are not identity. */
  continuation(sessionId: string, turnId: string, waits: readonly WaitEpoch[], active: Binding | null): void {
    const turn = this.turn(sessionId, turnId);
    if (!Array.isArray(waits) || !waits.length) throw new Error('Invalid desktop wait bindings');
    // Process the wait first so a conflict receipt names both its record and the active consent anchor.
    for (const wait of waits) {
      if (!wait || typeof wait !== 'object') throw new Error('Invalid desktop wait binding');
      this.valid(wait.waitId);
      const unknown = wait.uncertain !== false || (wait.epoch === null ? wait.generation !== null :
        typeof wait.epoch !== 'string' || !wait.epoch.trim() || wait.epoch.length > 256 || !Number.isSafeInteger(wait.generation) || wait.generation! < 0);
      if (unknown && !turn.conflict) {
        const current = active ?? turn.binding;
        turn.conflict = t('等待 {{waitId}} 的桌面任务身份未知（当前同意锚点：{{currentSource}}）；此回合桌面写入已冻结。', {
          waitId: wait.waitId, currentSource: current ? `${current.anchor}=${current.epoch}#${current.generation}` : t('无活动授权')
        });
      }
      if (!unknown && wait.epoch !== null) this.bind(turn, { epoch: wait.epoch, generation: wait.generation!, anchor: wait.waitId });
    }
    if (active) this.bind(turn, active);
  }
  /** Null means no epoch exists; the caller must use the normal first-approval flow. */
  assertWrite(sessionId: string, turnId: string, active: Binding | null, isCurrent: (epoch: string, generation: number) => boolean): string | null {
    const turn = this.turn(sessionId, turnId);
    if (typeof isCurrent !== 'function') throw new Error('Desktop epoch verifier is required');
    if (active) this.bind(turn, active);
    if (turn.conflict) throw new Error(turn.conflict);
    if (!turn.binding) return null;
    if (!active || isCurrent(turn.binding.epoch, turn.binding.generation) !== true) throw new Error(t('桌面任务授权已过期或撤销'));
    return turn.binding.epoch;
  }
  end(sessionId: string, turnId: string): void {
    this.turn(sessionId, turnId);
    this.turns.delete(sessionId);
  }
}
import { t } from '../../shared/i18n';
