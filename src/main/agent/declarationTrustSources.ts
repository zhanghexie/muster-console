/**
 * 一期接入面（zcode-adopt-batch-b S2.1）：injection-registry 注入源 + CLI 首条简报
 * 片段生成源 → DeclarationSubject[]。改动任一内容即 digest 变，经 declarationTrustStore
 * 注入门回 stale_digest、不再自动注入、进 pending 审批。
 */
import { buildHostIntro } from '../../shared/workerBrief';
import type { AgentRule } from '../../shared/agentConduct';
import { INJECTION_REGISTRY } from './injection-registry';
import {
  evaluateDeclarationGate,
  filterInjectableDeclarations,
  registerPendingDeclarations,
  type DeclarationGateResult
} from './declarationTrustStore';
import type { DeclarationSubject } from '../../shared/declarationTrust';

/** injection-registry 中 mode:conditional/always 的注入源 → 声明主体 */
export function injectionRegistrySubjects(): DeclarationSubject[] {
  return INJECTION_REGISTRY.filter((s) => s.mode === 'conditional' || s.mode === 'always').map(
    (s) => ({
      id: s.id,
      sourcePath: 'src/main/agent/injection-registry.ts',
      displayCommand: `injection:${s.id}`,
      content: {
        id: s.id,
        target: s.target,
        channel: s.channel,
        mode: s.mode,
        survivesCompact: s.survivesCompact,
        note: s.note
      }
    })
  );
}

/** CLI 首条简报生成源 → 声明主体 */
export function hostFragmentSubjects(rules?: AgentRule[]): DeclarationSubject[] {
  return [
    {
      id: 'worker.cli-host-intro',
      sourcePath: 'src/shared/workerBrief.ts',
      displayCommand: 'host-fragment:CLI intro',
      content: buildHostIntro({ rules })
    }
  ];
}

/** 一期接入面全部声明主体（registry 条目与 CLI 首条简报） */
export function phaseOneDeclarationSubjects(rules?: AgentRule[]): DeclarationSubject[] {
  return [...injectionRegistrySubjects(), ...hostFragmentSubjects(rules)];
}

/** 一期接入面注入门裁决：未信任不注入、信任后注入、内容变回 stale_digest */
export function evaluatePhaseOneGate(
  workspaceId: string,
  workspaceIdentity: string,
  rules?: AgentRule[]
): DeclarationGateResult[] {
  return evaluateDeclarationGate(workspaceId, workspaceIdentity, phaseOneDeclarationSubjects(rules));
}

/** 一期接入面只返回可注入主体 */
export function filterInjectablePhaseOne(
  workspaceId: string,
  workspaceIdentity: string,
  rules?: AgentRule[]
): DeclarationSubject[] {
  return filterInjectableDeclarations(workspaceId, workspaceIdentity, phaseOneDeclarationSubjects(rules));
}

/** 首见登记一期声明进 pending 审批（返回新登记条数） */
export function registerPendingPhaseOne(
  workspaceId: string,
  workspaceIdentity: string,
  rules?: AgentRule[]
): number {
  return registerPendingDeclarations(workspaceId, workspaceIdentity, phaseOneDeclarationSubjects(rules));
}
