import crypto from 'node:crypto';
import type { SessionMeta } from '../../shared/types';
import type { SessionHarnessModelExpected } from '../../shared/chatSurface';
import { defaultAcpAgentId, getAcpPresets, resolveAcpLaunch } from './drivers/acp/agents';
export type { SessionHarnessModelExpected } from '../../shared/chatSurface';

/** Ephemeral process-local key prevents preset or workspace fingerprints revealing their inputs. */
const identityKey = crypto.randomBytes(32);
const opaque = (value: unknown): string => crypto.createHmac('sha256', identityKey).update(JSON.stringify(value) ?? 'null').digest('base64url');

/** Called only in the main process. The returned fingerprints disclose no preset content. */
export function captureSessionHarnessModelExpected(session: SessionMeta, userDataDir: string, engineVersion?: string): SessionHarnessModelExpected {
  const runtimeId = session.runtime ?? '';
  if (!session.cwd || !['acp', 'claude', 'pi-external', 'omp', 'muse-gui', 'zcode-gui'].includes(runtimeId)) {
    throw new Error('会话不存在或不支持读取模型目录');
  }
  const base: SessionHarnessModelExpected = {
    runtimeId, cwd: session.cwd,
    ...(session.sourceRoot?.cwd && session.sourceRoot.cwd !== session.cwd ? { catalogCwd: session.sourceRoot.cwd } : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    workspaceFingerprint: opaque([session.workspaceId ?? '', session.sourceRoot ?? null, session.worktreeGroups ?? null]),
    engineFingerprint: opaque([runtimeId, engineVersion ?? '']),
    modelOverride: session.modelOverride ? structuredClone(session.modelOverride) : null
  };
  if (runtimeId !== 'acp') return base;
  const presets = getAcpPresets(userDataDir);
  const presetId = session.piModeId?.trim() ?? '';
  const agentId = defaultAcpAgentId(presetId, presets);
  const preset = presets.find(entry => entry.id === agentId);
  const resolved = resolveAcpLaunch(agentId, undefined, presets);
  return { ...base, presetId, agentId, agentFingerprint: opaque([agentId, preset ?? null, resolved]) };
}

/** A caller may submit untrusted or stale data; mismatch is always false. */
export function sameSessionHarnessModelExpected(session: SessionMeta, userDataDir: string, expected: SessionHarnessModelExpected, engineVersion?: string): boolean {
  if (!expected || typeof expected !== 'object') return false;
  const actual = captureSessionHarnessModelExpected(session, userDataDir, engineVersion);
  return actual.runtimeId === expected.runtimeId && actual.cwd === expected.cwd && actual.workspaceId === expected.workspaceId
    && actual.catalogCwd === expected.catalogCwd
    && actual.workspaceFingerprint === expected.workspaceFingerprint && actual.engineFingerprint === expected.engineFingerprint && actual.presetId === expected.presetId && actual.agentId === expected.agentId
    && actual.agentFingerprint === expected.agentFingerprint && JSON.stringify(actual.modelOverride) === JSON.stringify(expected.modelOverride);
}
