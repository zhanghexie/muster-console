import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GuiHostTool, GuiToolExecContext } from '../agentSession/types';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionDomainInstanceIdentity } from '../../shared/extensionDomain';
import { ExtensionRuntime } from './extensionRuntime';

function json(value: unknown): string {
  return JSON.stringify({ ok: true, result: value });
}

function operationId(operation: string): string {
  return operation.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function operationArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { expectedVersion: _expectedVersion, ...rest } = args;
  return rest;
}

function expectedVersion(args: Record<string, unknown>): number | undefined {
  return Number.isSafeInteger(args.expectedVersion) && (args.expectedVersion as number) >= 0
    ? args.expectedVersion as number
    : undefined;
}

/** Generate host tools for one extension Extension Agent Session. */
export function extensionAgentToolsForSession(
  runtime: ExtensionRuntime,
  manifest: ExtensionManifest,
  identity: ExtensionDomainInstanceIdentity
): GuiHostTool[] {
  const baseContext = (ctx: GuiToolExecContext, actor: 'agent' = 'agent') => ({
    actor,
    sessionId: ctx.sessionId,
    manifest,
    requestId: randomUUID(),
    signal: ctx.signal ?? new AbortController().signal,
    ...(identity.sourceRootId ? { sourceRootId: identity.sourceRootId } : {})
  });
  const tools: GuiHostTool[] = [];
  tools.push({
    id: `ext.${manifest.id}.state.snapshot`,
    label: `读取${manifest.name}当前状态`,
    description: `按需读取${manifest.name}当前 DomainRuntime 状态。人的操作不会自动发送给 Agent；需要回答当前状态时先调用这个工具。结果可能附带 humanActivitySinceAgent：人自你上次快照以来执行过的命令及次数，这些变化已包含在当前 version 里。`,
    parameters: { type: 'object', properties: { expectedVersion: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    permissionClass: 'read',
    resultFormat: 'execute-result-json',
    execute: async (args, ctx) => {
      const snapshot = await runtime.snapshot({ ...baseContext(ctx), expectedVersion: expectedVersion(args) });
      const humanActivity = runtime.takeHumanActivity();
      return json(humanActivity ? { ...snapshot, humanActivitySinceAgent: humanActivity } : snapshot);
    }
  });
  for (const name of manifest.domain?.queries ?? []) {
    const definition = manifest.domain?.queryDefs?.find(item => item.id === name);
    const suffix = operationId(name);
    tools.push({
      id: `ext.${manifest.id}.query.${suffix}`,
      label: definition?.title ?? `查询 ${name}`,
      description: definition?.description ?? `读取 ${manifest.name} 的 ${name} 领域查询结果。`,
      parameters: definition?.parameters ?? { type: 'object', additionalProperties: true },
      permissionClass: 'read',
      resultFormat: 'execute-result-json',
      execute: async (args, ctx) => json(await runtime.query(name, operationArgs(args), { ...baseContext(ctx), expectedVersion: expectedVersion(args) }))
    });
  }
  for (const name of manifest.domain?.commands ?? []) {
    const definition = manifest.domain?.commandDefs?.find(item => item.id === name);
    const suffix = operationId(name);
    tools.push({
      id: `ext.${manifest.id}.command.${suffix}`,
      label: definition?.title ?? `执行 ${name}`,
      description: definition?.description ?? `通过 ${manifest.name} 的共享领域命令执行 ${name}。`,
      parameters: { ...(definition?.parameters ?? { type: 'object', additionalProperties: true }), properties: { ...((definition?.parameters?.properties as Record<string, unknown> | undefined) ?? {}), expectedVersion: { type: 'integer', minimum: 0 } } },
      permissionClass: definition?.permission === 'read' ? 'read' : definition?.permission === 'dangerous' ? 'dynamic' : 'edit',
      resultFormat: 'execute-result-json',
      execute: async (args, ctx) => json(await runtime.execute(name, operationArgs(args), { ...baseContext(ctx), expectedVersion: expectedVersion(args) }))
    });
  }
  if (manifest.agent?.skills.length) {
    tools.push({
      id: `ext.${manifest.id}.agent.skill.read`,
      label: '读取扩展 Skill',
      description: `按声明路径读取 ${manifest.name} 的 Skill 正文，或用 resource 读取该技能目录内的 UTF-8 模板、脚本、参考文件。`,
      parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', enum: manifest.agent.skills }, resource: { type: 'string' } } },
      permissionClass: 'read',
      resultFormat: 'execute-result-json',
      execute: async (args) => {
        const relativePath = String(args.path ?? '');
        const result = await runtime.readSkill(relativePath, typeof args.resource === 'string' ? args.resource : undefined);
        const skill = runtime.agentResourceMount().skills.find(item => item.relativePath === relativePath)!;
        return JSON.stringify({ ok: true, result, skillRoot: path.dirname(skill.absolutePath) });
      }
    });
  }
  return tools;
}


