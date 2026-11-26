import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveUsage, sameUsageScope, type UsagePolicy, type UsageKind, type UsageContext, type UsageSetInput } from '../../shared/capabilityUsage';
import { t } from '../../shared/i18n';

/** Host-owned preferences, separate from the settings draft and resource credentials. */
export class CapabilityUsageService {
  private policy: UsagePolicy;
  private disk: string | undefined;
  /** capability-management F-01：损坏时降级空策略（fail-open，能力全可用），写路径显式报错保护现场。 */
  private startupError?: string;
  constructor(private readonly file: string, private readonly changed: () => void = () => {}) {
    this.disk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    this.policy = { revision: 0, disabled: [] };
    if (this.disk === undefined) return;
    try {
      this.policy = this.parse(this.disk);
    } catch (err) {
      // 照 SkillsManagementService.loadStore 范式：构造不 throw（否则中断 IPC 注册链，
      // 其后所有 handler 不注册），降级空策略 + startupError，写入口拒绝覆盖坏文件。
      this.startupError = t('无法读取能力使用设置：{{message}}；原文件已保留，请修复后重启', { message: (err as Error).message });
      console.error(`[capability-usage] ${path.basename(file)} 解析失败，按空策略降级启动（写入口将拒绝覆盖）:`, (err as Error).message);
    }
  }
  getStartupError(): string | undefined { return this.startupError; }
  private parse(text: string): UsagePolicy {
    const value = JSON.parse(text) as UsagePolicy;
    if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !Array.isArray(value.disabled)) throw new Error('Invalid capability usage policy');
    for (const rule of value.disabled) {
      if (!rule || !['skill', 'mcp'].includes(rule.kind) || typeof rule.resourceId !== 'string' || !rule.resourceId || !rule.scope ||
          !['global', 'harness', 'workspace'].includes(rule.scope.kind) ||
          (rule.scope.kind === 'harness' && !rule.scope.runtimeId) || (rule.scope.kind === 'workspace' && !rule.scope.workspaceId)) throw new Error('Invalid capability usage rule');
    }
    return value;
  }
  snapshot(): UsagePolicy { return structuredClone(this.policy); }
  allows(kind: UsageKind, id: string, context: UsageContext = {}): boolean { return resolveUsage(this.policy, kind, id, context).enabled; }
  /** Additive migration: rollback keeps old restrictions; merging never enables a denied source. */
  preserveSkillRestrictions(sourceIds: string[], destinationId: string): void {
    this.assertWritable();
    const disk = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : undefined;
    if (disk !== this.disk) throw new Error(t('使用设置已在外部修改，请刷新后重试。'));
    const disabled = structuredClone(this.policy.disabled);
    for (const rule of this.policy.disabled) {
      if (rule.kind !== 'skill' || !sourceIds.includes(rule.resourceId)) continue;
      if (!disabled.some(item => item.kind === 'skill' && item.resourceId === destinationId && sameUsageScope(item.scope, rule.scope))) disabled.push({ ...rule, resourceId: destinationId });
    }
    if (disabled.length !== this.policy.disabled.length) this.publish({ revision: this.policy.revision + 1, disabled });
  }
  set(input: UsageSetInput): void {
    this.assertWritable();
    if (input.expectedRevision !== this.policy.revision) throw new Error(t('使用设置已变化，请刷新后重试。'));
    if (typeof input.enabled !== 'boolean' || !['skill', 'mcp'].includes(input.kind) || !Array.isArray(input.resourceIds) || !input.resourceIds.length || input.resourceIds.length > 2000 || input.resourceIds.some(id => typeof id !== 'string' || !id)) throw new Error(t('无效的能力使用设置。'));
    const disk = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : undefined;
    if (disk !== this.disk) {
      this.reloadExternal(disk);
      throw new Error(this.startupError ?? t('使用设置已在外部修改，请刷新后重试。'));
    }
    const ids = new Set(input.resourceIds);
    const disabled = this.policy.disabled.filter(rule => !(rule.kind === input.kind && ids.has(rule.resourceId) && sameUsageScope(rule.scope, input.scope)));
    if (!input.enabled) for (const resourceId of ids) disabled.push({ kind: input.kind, resourceId, scope: structuredClone(input.scope) });
    const next = { revision: this.policy.revision + 1, disabled };
    this.publish(next);
  }
  /** 损坏降级期间拒绝一切写动作，避免把坏文件覆盖成空策略（skills startupError 同款契约）。 */
  private assertWritable(): void {
    if (this.startupError) throw new Error(this.startupError);
  }
  /** 外部变化重读：损坏同样进入 startupError 降级并中止本次写。 */
  private reloadExternal(disk: string | undefined): void {
    if (disk === undefined) { this.policy = { revision: 0, disabled: [] }; this.disk = disk; return; }
    try {
      this.policy = this.parse(disk);
      this.disk = disk;
    } catch (err) {
      this.startupError = t('无法读取能力使用设置：{{message}}；原文件已保留，请修复后重启', { message: (err as Error).message });
      this.policy = { revision: 0, disabled: [] };
      this.disk = disk;
    }
  }
  private publish(next: UsagePolicy): void {
    // Validate before publishing; readers never observe a partial document.
    const text = JSON.stringify(next, null, 2); this.parse(text);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, text, { flag: 'wx' });
      const latest = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : undefined;
      if (latest !== this.disk) { this.reloadExternal(latest); throw new Error(this.startupError ?? t('使用设置已在外部修改，请刷新后重试。')); }
      fs.renameSync(temp, this.file);
    }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    this.disk = text; this.policy = next; this.changed();
  }
}

let service: CapabilityUsageService | undefined;
export function setCapabilityUsageService(value: CapabilityUsageService | undefined): void { service = value; }
export function capabilityUsageAllowed(kind: UsageKind, id: string, context: UsageContext = {}): boolean { return service?.allows(kind, id, context) ?? true; }
