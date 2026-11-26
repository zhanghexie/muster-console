import { createSkillSourceLoader, workspaceSkillPaths } from './skillSources';
import { patchElectronForPi } from './piElectronCompat';
import type { AgentSkillInfo } from '../../shared/types';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { app } from 'electron';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import type { CapabilityTargetId } from '../../shared/capabilityManagement';

const cache = new Map<string, { at: number; skills: AgentSkillInfo[] }>();
const CACHE_TTL_MS = 60_000;
const inflight = new Map<string, Promise<AgentSkillInfo[]>>();
let cacheGeneration = 0;
export function invalidateAgentSkills(): void {
  cacheGeneration++; cache.clear(); inflight.clear();
}

/**
 * 列出 Pi 会发现的 Skills（与 createAgentSession / GUI Pi driver 路径一致），不创建会话。
 * 按 cwd/目录快照/Pi 配置目录短缓存，避免 `/` 反复扫盘或复用已移除来源。
 */
export async function listAgentSkills(cwd: string, context?: WorkspaceExecutionContext, target: CapabilityTargetId = 'pi-gui'): Promise<AgentSkillInfo[]> {
  const agentDir = userDataStorage(app.getPath('userData')).resolve('app', 'muster-core');
  const key = JSON.stringify([cwd, agentDir, context ?? null, target, cacheGeneration]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.skills;

  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    patchElectronForPi();
    const pi = await import('@earendil-works/pi-coding-agent');
    const skillPaths = workspaceSkillPaths(cwd, context, target);
    const resourceLoader = createSkillSourceLoader(pi, {
      cwd,
      agentDir,
      additionalSkillPaths: skillPaths,
      noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true
    }, cwd, agentDir, context, target);
    await resourceLoader.reload({
      resolveProjectTrust: async () => true
    });
    const skills = resourceLoader.getSkills()?.skills ?? [];
    const out: AgentSkillInfo[] = [];
    for (const s of skills) {
      const name = String(s.name ?? '').trim();
      if (!name) continue;
      out.push((s as typeof s & { musterSkill?: AgentSkillInfo }).musterSkill ?? {
        name,
        description: String(s.description ?? '').trim(),
        filePath: String(s.filePath ?? '').trim() || undefined,
        baseDir: String(s.baseDir ?? '').trim() || undefined
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    for (const [oldKey, old] of cache) if (Date.now() - old.at >= CACHE_TTL_MS) cache.delete(oldKey);
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), skills: out });
    return out;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

// `/skill:name` 展开与预算/审计已合并进 agent/skillInject.ts
// （expandSkillTextWithBudget / prepareEngineSkillText），此处不再留无预算的旧入口。
