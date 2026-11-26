/**
 * Host-owned skill storage.
 *
 * Host skills are installed under ~/.muster/skills and are loaded by host
 * runtimes through explicit paths. They are not projected into a workspace's
 * .agents/skills directory: that directory is reserved for user/project
 * skills managed by the capability manager.
 */
import os from 'node:os';
import path from 'node:path';
import { SKILL_ROOT } from '../capabilities/catalog/runFactory';
import { RUN_TOOL_DOMAINS } from '../capabilities/catalog/runTools';
import { APP_SKILL_PATH } from '../capabilities/catalog/agentApps';
import {
  MEMORY_SKILL_PATH,
  FEEDBACK_SKILL_PATH,
  DESKTOP_SKILL_PATH,
  TURN_CHANGES_SKILL_PATH,
  CORE_CONTEXT_SKILL_PATH,
  MUSTER_EXTENSIONS_SKILL_PATH,
  UI_WIDGET_SKILL_PATH,
  SESSIONS_SKILL_PATH
} from './hostSkillPaths';

/** Resolve the single SKILL_ROOT declaration to an absolute local path. */
export function resolveHostSkillRootDir(): string {
  if (SKILL_ROOT.startsWith('~/')) return path.join(os.homedir(), SKILL_ROOT.slice(2));
  return path.resolve(SKILL_ROOT);
}

/** Derive the bundled host-skill domain list from the catalog declarations. */
export function hostSkillDomainDirs(): readonly string[] {
  const prefix = `${SKILL_ROOT}/`;
  const dirs: string[] = [];
  for (const domain of [
    ...RUN_TOOL_DOMAINS,
    { skillPath: APP_SKILL_PATH },
    { skillPath: MEMORY_SKILL_PATH },
    { skillPath: FEEDBACK_SKILL_PATH },
    { skillPath: DESKTOP_SKILL_PATH },
    { skillPath: TURN_CHANGES_SKILL_PATH },
    { skillPath: CORE_CONTEXT_SKILL_PATH },
    { skillPath: MUSTER_EXTENSIONS_SKILL_PATH },
    { skillPath: UI_WIDGET_SKILL_PATH },
    { skillPath: SESSIONS_SKILL_PATH }
  ]) {
    const rel = domain.skillPath.startsWith(prefix) ? domain.skillPath.slice(prefix.length) : '';
    const dir = rel.split('/')[0] ?? '';
    if (dir && rel === `${dir}/SKILL.md` && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}
