import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import type { ExtensionTaskState } from '../../shared/extensionRuntime';
import { t } from '../../shared/i18n';
export type StoredTask = { state: ExtensionTaskState; args: unknown; fingerprint: string };
/** Crash-safe journal. Recovery never replays the original command automatically. */
export class ExtensionTaskStore {
  private records: StoredTask[] = [];
  constructor(private file: string) {
    if (!fs.existsSync(file)) return;
    let raw: { version: number; tasks: StoredTask[] };
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; tasks: StoredTask[] };
      if (raw.version !== 1 || !Array.isArray(raw.tasks) || raw.tasks.length > 200 || raw.tasks.some(item => !item.state || typeof item.state.id !== 'string' || typeof item.state.requestId !== 'string' || typeof item.fingerprint !== 'string' || !['running', 'interrupted', 'completed', 'cancelled', 'failed'].includes(item.state.status))) throw new Error(t('扩展任务记录损坏；已保留原文件，请修复后恢复任务'));
    } catch (err) {
      // X3-F07：构造器 throw 会让该扩展所有 start/runCommand 永久报同一错误且无自助出口。
      // 降级空表 + .bad 保留现场 + console.error（navigationStore X3-F03 同范式）；本 store 是
      // crash journal，降级不重放符合「绝不自动重放」设计。
      const bad = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bad`;
      try {
        fs.renameSync(file, bad);
        console.error(`[extensions] tasks.json 解析失败，已保留原文件为 ${path.basename(bad)}，按空任务表启动:`, err instanceof Error ? err.message : err);
      } catch (renameErr) {
        console.error('[extensions] tasks.json 解析失败，且备份保留失败，按空任务表启动:', err, renameErr);
      }
      return;
    }
    this.records = raw.tasks.map(item => ({ ...item, state: item.state.status === 'running' ? { ...item.state, status: 'interrupted', error: t('工作台已重启，等待与外部服务对账') } : item.state }));
    this.commit();
  }
  list(): StoredTask[] { return structuredClone(this.records); }
  save(record: StoredTask): void { this.saveMany([record]); }
  saveMany(records: StoredTask[]): void {
    if (!records.length) return;
    const ids = new Set(records.map(record => record.state.id));
    if (ids.size !== records.length) throw new Error('Duplicate extension task update');
    const next = this.records.filter(item => !ids.has(item.state.id));
    next.push(...records.map(record => structuredClone(record)));
    while (next.length > 200) { const index = next.findIndex(item => item.state.status !== 'running' && item.state.status !== 'interrupted'); if (index < 0) throw new Error(t('运行或待恢复任务超过 200 项')); next.splice(index, 1); }
    const serialized = JSON.stringify({ version: 1, tasks: next });
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error(t('任务元数据超过 8MB，请将素材和大结果保存为文件引用'));
    this.commit(next); this.records = next;
  }
  private commit(records = this.records): void {
    writeJsonAtomicSync(this.file, { version: 1, tasks: records });
  }
}
