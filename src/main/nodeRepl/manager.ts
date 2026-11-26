/**
 * NodeReplSession 注册表：每会话一个持久实例（跨工具调用共享 globalThis）。
 * 会话销毁时释放；不落盘（REPL 状态是进程内易失的，重启即空）。
 */
import { NodeReplSession } from './session';

export class NodeReplManager {
  private sessions = new Map<string, NodeReplSession>();
  private closing = new Map<string, Promise<void>>();
  private stopping = false;
  private disposal?: Promise<void>;

  getOrCreate(sessionId: string): NodeReplSession {
    if (this.stopping) throw new Error('Node execution manager is stopping');
    let s = this.sessions.get(sessionId);
    if (this.closing.has(sessionId) || s?.isDisposed()) throw new Error('Node execution session is closing');
    if (!s) {
      s = new NodeReplSession();
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  peek(sessionId: string): NodeReplSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Keep failed owners registered so callers can retry actual termination. */
  dispose(sessionId: string): Promise<void> {
    const pending = this.closing.get(sessionId);
    if (pending) return pending;
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    const closing = session.dispose().then(() => {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    });
    this.closing.set(sessionId, closing);
    void closing.finally(() => { if (this.closing.get(sessionId) === closing) this.closing.delete(sessionId); }).catch(() => {});
    return closing;
  }

  disposeAll(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopping = true;
    const disposal = (async () => {
      const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.dispose(id)));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, `Node execution manager cleanup failed: ${errors.map(String).join('; ')}`);
    })();
    this.disposal = disposal;
    void disposal.catch(() => { if (this.disposal === disposal) this.disposal = undefined; });
    return disposal;
  }

  get size(): number {
    return this.sessions.size;
  }
}
