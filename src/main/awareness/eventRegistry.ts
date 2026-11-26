/**
 * 自定义事件注册表：pending 目录落工作区 `.muster/events/` 给人看。
 * 宿主单写者；Worker 只经 events.* 工具改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import { META_AGENT_DIR } from '../../shared/metaAgent';
import {
  emptyEventEmitLedger,
  isEventRegistrationShape,
  pruneStaleEventEmitters,
  type EventRegistration
} from '../../shared/runtimeEvents';
import type { SubscribeRateLedger } from '../../shared/runtimeFactsSubscribe';

export const EVENTS_REL_DIR = 'events';

export function eventsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, META_AGENT_DIR, EVENTS_REL_DIR);
}

export function eventFilePath(workspaceRoot: string, status: EventRegistration['status'], id: string): string {
  return path.join(eventsRoot(workspaceRoot), status, `${id}.json`);
}

export class EventRegistry {
  /** 发射限频：内存持有，重启清零 */
  readonly emitLedger: SubscribeRateLedger = emptyEventEmitLedger();

  /** F-06：同 (root,id) 注册临界区的串行链锚点（吞结果，只用于排队与回收） */
  private readonly registerChains = new Map<string, Promise<unknown>>();

  /**
   * F-06：以 (root,id) 为键串行化注册的读-改-写。fn 收到进入临界区那一刻的现有条目；
   * 同 id 并发注册时后到方在链上排队，等先写方落盘完成后再判重——后到方看到先写
   * 结果，而不是互相覆盖、双方都返回 ok。fn 内的 await（确认框等）也在临界区内串行。
   */
  registerSerialized<R>(
    root: string,
    id: string,
    fn: (existing: EventRegistration | undefined) => R | Promise<R>
  ): Promise<R> {
    const key = `${root}\u0000${id}`;
    const prev = this.registerChains.get(key) ?? Promise.resolve();
    // 链锚只做排队（吞掉前序的结果与错误，不把前序返回值当 existing 传入）；
    // 轮到本序时重读现有条目——后到方因此看到先写方的落盘结果
    const run = prev
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => fn(this.get(root, id)));
    const anchor = run.then(
      () => undefined,
      () => undefined
    );
    this.registerChains.set(key, anchor);
    void anchor.then(() => {
      if (this.registerChains.get(key) === anchor) this.registerChains.delete(key);
    });
    return run;
  }

  list(workspaceRoot: string, status?: EventRegistration['status']): EventRegistration[] {
    const root = eventsRoot(workspaceRoot);
    const dirs = status ? [status] : (['pending', 'approved', 'rejected'] as const);
    const out: EventRegistration[] = [];
    for (const dir of dirs) {
      const folder = path.join(root, dir);
      let names: string[] = [];
      try {
        names = fs.readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const entry = this.readFile(path.join(folder, name));
        if (entry) out.push(entry);
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(workspaceRoot: string, id: string): EventRegistration | undefined {
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      const entry = this.readFile(eventFilePath(workspaceRoot, status, id));
      if (entry) return entry;
    }
    return undefined;
  }

  getApproved(workspaceRoot: string, id: string): EventRegistration | undefined {
    const entry = this.get(workspaceRoot, id);
    return entry?.status === 'approved' ? entry : undefined;
  }

  isApprovedKind(workspaceRoot: string, kindOrId: string): boolean {
    const id = kindOrId.startsWith('event.') ? kindOrId.slice('event.'.length) : kindOrId;
    return this.getApproved(workspaceRoot, id) != null;
  }

  register(workspaceRoot: string, entry: EventRegistration): EventRegistration {
    const existing = this.get(workspaceRoot, entry.id);
    if (existing && existing.status !== 'rejected') return existing;
    if (existing?.status === 'rejected') {
      this.removeFile(eventFilePath(workspaceRoot, 'rejected', entry.id));
    }
    this.writeEntry(workspaceRoot, entry);
    return entry;
  }

  save(workspaceRoot: string, entry: EventRegistration, prevStatus?: EventRegistration['status']): EventRegistration {
    if (prevStatus && prevStatus !== entry.status) {
      this.removeFile(eventFilePath(workspaceRoot, prevStatus, entry.id));
    }
    this.writeEntry(workspaceRoot, entry);
    return entry;
  }

  /**
   * R-16：按在册会话清各事件 emitters 里的悬空 session id（`orchestrator:<ws>` 合成 id
   * 保留）。参照 awareness store 的 pruneShares 模式；宿主启动时对每个工作区调一次。
   * 只改 emitters 列表，注册本身（pending/approved/rejected）不动。返回被清理的事件 id。
   */
  pruneStaleEmitters(workspaceRoot: string, aliveSessionIds: Iterable<string>): string[] {
    const alive = new Set(aliveSessionIds);
    const changed: string[] = [];
    for (const entry of this.list(workspaceRoot)) {
      const emitters = pruneStaleEventEmitters(entry.emitters, alive);
      if (emitters.length === entry.emitters.length) continue;
      this.save(workspaceRoot, { ...entry, emitters });
      changed.push(entry.id);
    }
    return changed;
  }

  private writeEntry(workspaceRoot: string, entry: EventRegistration): void {
    writeJsonAtomicSync(eventFilePath(workspaceRoot, entry.status, entry.id), entry);
  }

  private readFile(abs: string): EventRegistration | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(abs, 'utf8'));
      return isEventRegistrationShape(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private removeFile(abs: string): void {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* 已不在 */
    }
  }
}

let singleton: EventRegistry | undefined;

export function getEventRegistry(): EventRegistry {
  if (!singleton) singleton = new EventRegistry();
  return singleton;
}
