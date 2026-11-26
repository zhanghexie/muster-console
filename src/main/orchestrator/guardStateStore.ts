/**
 * 守卫状态落盘（O3）：alreadyFired / lastActivity 持久化到 userData JSON，
 * 范式同 awareness/store。文件小，每次变更直接原子写（writeJsonAtomicSync），
 * 写失败只记日志——持久化是尽力而为，内存态始终是真源。
 * 支持注入 dir 供测试；解析/合并/prune 纯函数在 shared/orchestratorGuards。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  parseGuardPersistState,
  type GuardPersistState
} from '../../shared/orchestratorGuards';

export const ORCHESTRATOR_GUARD_STATE_FILE = 'orchestrator-guard-state.json';

export class OrchestratorGuardStateStore {
  private readonly file: string;

  constructor(dir: string, filename: string = ORCHESTRATOR_GUARD_STATE_FILE) {
    this.file = path.join(dir, filename);
  }

  get filePath(): string {
    return this.file;
  }

  /** 读：缺失/损坏/不可读 → 空对象起步（宁可重报不漏报） */
  read(): GuardPersistState {
    try {
      // X3-F11：JSON.parse 提到读侧，让损坏与 fs 错误都能在这一个 catch 留下诊断线索
      // （shared 层的 parse 会静默吞掉坏 JSON）；ENOENT=从未写过，属正常首启不打扰
      return parseGuardPersistState(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[orch-guard-state] 状态文件损坏/不可读，按空起步（宁可重报不漏报）：${this.file}`,
          err instanceof Error ? err.message : err
        );
      }
      return parseGuardPersistState(undefined);
    }
  }

  /** 写：原子（tmp+rename），失败只记日志不抛（守卫路径不能被落盘拖垮） */
  write(state: GuardPersistState): void {
    try {
      writeJsonAtomicSync(this.file, state);
    } catch (err) {
      console.error('[orch-guard-state] write failed', this.file, err);
    }
  }
}
