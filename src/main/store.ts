import { safeScopedKey, userDataStorage, type StorageRootResolver } from './runtimeKernel/storageRootResolver';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, PromptTask, SessionMeta, TaskRun } from '../shared/types';
import {
  parseEndedSessionRefs,
  type EndedSessionRef
} from '../shared/agentMessage';
import { PersistQueue } from './persistQueue';
import { writeJsonAtomicSync } from './atomicJson';
import { loadRegistryJson, saveRegistryJson } from './jsonRegistry';
import { sweepPiSessionBucket } from './persistenceSweeps';
import { loadSchedulerSessionSnapshot, type SchedulerSessionSnapshot } from './runtimeKernel/schedulerSession';

type AgentModelChoices = Record<string, { providerId: string; modelId: string }>;
type AgentModelConfiguration = { version: 2; models: AgentModelChoices; thinking: Record<string, string> };

/** 简单 JSON 文件持久化：会话注册表 / 服务定义 / 右栏聊天历史。 */
export class Store {
  private dir: string;
  private queue: PersistQueue;
  private storage: StorageRootResolver;
  private agentModelConfiguration?: AgentModelConfiguration;
  /** pi-sessions 各桶本进程是否已做过旧会话清扫（X3-F05，一次性） */
  private piSessionSwept = new Set<string>();

  constructor() {
    this.dir = app.getPath('userData');
    this.storage = userDataStorage(this.dir);
    this.storage.file('sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = new PersistQueue(this.dir, { resolveFile: file => this.storage.fileByName(file) });
  }

  private read<T>(file: string, fallback: T): T {
    const abs = this.storage.fileByName(file);
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf-8')) as T;
    } catch (e) {
      // 文件不存在是正常首启；解析失败 = 数据损坏（X3-F02）。静默回空会让 PersistQueue
      // 的首次写把「空」落盘固化（聊天史/会话表无声丢失）——先改名 .bad 保留现场
      // （awareness F-07 范式）再按空起步。本 read 覆盖 sessions/session-ended/usage 三件、
      // chat-history 家族与 agent-modes/models/thinking/scheduler-status 共 11 个文件。
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        const bad = `${abs}.${new Date().toISOString().replace(/[:.]/g, '-')}.bad`;
        try {
          fs.renameSync(abs, bad);
          console.error(`[store] ${file} 解析失败，已保留原文件为 ${path.basename(bad)}，回退空数据:`, (e as Error).message);
        } catch (renameErr) {
          console.error(`[store] ${file} 解析失败，且现场保留失败，回退空数据:`, (e as Error).message, renameErr);
        }
      }
      return fallback;
    }
  }

  private write(file: string, data: unknown): void {
    this.queue.write(file, data);
  }

  flushSync(): void {
    this.queue.flushSync();
  }

  loadSessions(): SessionMeta[] {
    return this.read<SessionMeta[]>('sessions.json', []);
  }

  saveSessions(sessions: SessionMeta[]): void {
    this.write('sessions.json', sessions);
  }

  saveSessionsStrict(snapshot: () => SessionMeta[], commit?: () => void): Promise<void> {
    return this.queue.writeStrict('sessions.json', snapshot, commit, { coexist: true });
  }

  /** close() 墓碑：已删除会话仍能回执 session_ended（P20） */
  loadEndedSessionRefs(): EndedSessionRef[] {
    return parseEndedSessionRefs(this.read<unknown>('session-ended.json', []));
  }

  saveEndedSessionRefs(refs: EndedSessionRef[]): void {
    this.write('session-ended.json', refs);
  }

  loadPromptTasks(): PromptTask[] {
    return loadRegistryJson<PromptTask[]>(this.dir, 'prompt-tasks.json', [], file => this.storage.fileByName(file));
  }

  /** P9：注册表同步落盘 + bak，避免 200ms 防抖未刷就崩溃后列表变空 */
  savePromptTasks(tasks: PromptTask[]): void {
    this.queue.drop('prompt-tasks.json');
    saveRegistryJson(this.dir, 'prompt-tasks.json', tasks, file => this.storage.fileByName(file));
  }

  loadTaskRuns(): TaskRun[] {
    return loadRegistryJson<TaskRun[]>(this.dir, 'task-runs.json', [], file => this.storage.fileByName(file));
  }

  saveTaskRuns(runs: TaskRun[]): void {
    this.queue.drop('task-runs.json');
    saveRegistryJson(this.dir, 'task-runs.json', runs, file => this.storage.fileByName(file));
  }

  /** 使用统计（UsageStatsService 按日分桶计数，永久保留） */
  loadUsageStats(): unknown {
    return this.read<unknown>('usage-stats.json', {});
  }

  saveUsageStats(data: unknown): void {
    this.write('usage-stats.json', data);
  }

  /** 扩展 LLM 调用明细（近 7 天，UsageStatsService 负责裁剪） */
  loadUsageLlmCalls(): unknown {
    return this.read<unknown>('usage-llm-calls.json', []);
  }

  saveUsageLlmCalls(data: unknown): void {
    this.write('usage-llm-calls.json', data);
  }

  loadUsageToolFailures(): unknown { return this.read<unknown>('usage-tool-failures.json', []); }
  saveUsageToolFailures(data: unknown): void { this.write('usage-tool-failures.json', data); }

  /** Event-backed observer read. Old JSON history is neither read nor migrated. */
  loadChat(workspaceId = 'default', _opts?: { readOnly?: boolean }): SchedulerSessionSnapshot {
    return loadSchedulerSessionSnapshot(this.dir, workspaceId) ?? { display: [], api: [] };
  }

  /** Strict and side-effect-free: retention must not treat damaged history as empty. */
  async loadChatForReviewRetention(workspaceId: string): Promise<ChatMessage[] | null> {
    return loadSchedulerSessionSnapshot(this.dir, workspaceId)?.display ?? null;
  }

  /** Pi 调度会话 jsonl 目录（按工作区分桶；跨重启续聊；仅「清空聊天」时新建） */
  getPiSessionDir(workspaceId = 'default'): string {
    const safe = safeScopedKey(workspaceId || 'default');
    const dir = path.join(this.storage.resolve('app', 'pi-sessions'), safe);
    fs.mkdirSync(dir, { recursive: true });
    // X3-F05：旧会话 jsonl 7 天滚动（每进程每桶首次取用时扫一次；活跃会话文件
    // 每次续聊都会触碰 mtime，不会被误删）
    if (!this.piSessionSwept.has(dir)) {
      this.piSessionSwept.add(dir);
      sweepPiSessionBucket(dir);
    }
    return dir;
  }

  /** 调度 Agent 模式（default/ask/plan，按工作区） */
  loadAgentModes(): Record<string, string> {
    return this.read<Record<string, string>>('agent-modes.json', {});
  }

  saveAgentModes(data: Record<string, string>): void {
    this.write('agent-modes.json', data);
  }

  private readAgentModelConfiguration(): AgentModelConfiguration {
    if (this.agentModelConfiguration) return this.agentModelConfiguration;
    const stored = this.read<unknown>('agent-models.json', {});
    const envelope = stored as Partial<AgentModelConfiguration> | null;
    const canonical = envelope?.version === 2 && envelope.models && envelope.thinking
      ? { version: 2, models: envelope.models, thinking: envelope.thinking } satisfies AgentModelConfiguration
      : undefined;
    if (canonical) {
      this.removeLegacyAgentThinkingSidecar();
      return this.agentModelConfiguration = canonical;
    }
    const configuration: AgentModelConfiguration = {
      version: 2,
      models: stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as AgentModelChoices : {},
      thinking: this.read<Record<string, string>>('agent-thinking.json', {})
    };
    // The old split files remain readable, but the first successful read is a
    // one-way migration to the v2 envelope so future writes have one authority.
    try {
      writeJsonAtomicSync(this.storage.file('agent-models'), configuration);
      fs.rmSync(this.storage.file('agent-thinking'), { force: true });
    } catch (error) {
      console.error('[store] agent model configuration migration failed:', error);
    }
    return this.agentModelConfiguration = configuration;
  }

  private removeLegacyAgentThinkingSidecar(): void {
    try {
      fs.rmSync(this.storage.file('agent-thinking'), { force: true });
    } catch (error) {
      console.error('[store] agent-thinking.json cleanup failed:', error);
    }
  }

  loadAgentModels(): AgentModelChoices {
    return structuredClone(this.readAgentModelConfiguration().models);
  }

  saveAgentModels(data: AgentModelChoices): void {
    this.writeAgentModelConfiguration({ ...this.readAgentModelConfiguration(), models: structuredClone(data) });
  }

  loadAgentThinking(): Record<string, string> {
    return structuredClone(this.readAgentModelConfiguration().thinking);
  }

  saveAgentThinking(data: Record<string, string>): void {
    this.writeAgentModelConfiguration({ ...this.readAgentModelConfiguration(), thinking: structuredClone(data) });
  }

  private writeAgentModelConfiguration(configuration: AgentModelConfiguration): void {
    this.agentModelConfiguration = configuration;
    this.write('agent-models.json', configuration);
  }

  saveAgentModelConfigurationStrict(snapshot: () => Omit<AgentModelConfiguration, 'version'>, commit: () => void): Promise<void> {
    let saved: AgentModelConfiguration;
    return this.queue.writeStrict('agent-models.json', () => (saved = { version: 2, ...structuredClone(snapshot()) }), () => {
      this.agentModelConfiguration = saved;
      commit();
    }, { coexist: true }).catch(error => {
      this.writeAgentModelConfiguration(this.readAgentModelConfiguration());
      throw error;
    });
  }

  /** 调度会话 phase/胶囊（按工作区；不进 sessions.json，重启保留） */
  loadSchedulerStatus(): unknown {
    return this.read<unknown>('scheduler-status.json', {});
  }

  saveSchedulerStatus(data: unknown): void {
    this.write('scheduler-status.json', data);
  }
}
