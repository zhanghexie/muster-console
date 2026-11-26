import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  META_AGENT_DIR,
  defaultWorkspaceFileConfig,
  type WorkspaceFileConfig
} from '../../shared/metaAgent';

function workspaceJsonPath(root: string): string {
  return path.join(root, META_AGENT_DIR, 'workspace.json');
}

function writeWorkspaceJson(root: string, cfg: WorkspaceFileConfig): void {
  const dir = path.join(root, META_AGENT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(workspaceJsonPath(root), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/** 只补 undefined/缺键，不覆盖已有值；git 子对象同样只补缺键 */
export function mergeWorkspaceDefaults(existing: WorkspaceFileConfig): WorkspaceFileConfig {
  const defaults = defaultWorkspaceFileConfig();
  const out: WorkspaceFileConfig = { ...defaults, ...existing };

  for (const key of Object.keys(defaults) as (keyof WorkspaceFileConfig)[]) {
    if (existing[key] === undefined) {
      (out as Record<string, unknown>)[key] = defaults[key];
    } else {
      (out as Record<string, unknown>)[key] = existing[key];
    }
  }

  const existingGit = existing.git;
  const defaultGit = defaults.git ?? {};
  if (existingGit === undefined) {
    out.git = { ...defaultGit };
  } else {
    out.git = { ...defaultGit };
    for (const key of Object.keys(defaultGit) as (keyof NonNullable<WorkspaceFileConfig['git']>)[]) {
      if (existingGit[key] !== undefined) {
        (out.git as Record<string, unknown>)[key] = existingGit[key];
      }
    }
    for (const key of Object.keys(existingGit) as (keyof NonNullable<WorkspaceFileConfig['git']>)[]) {
      if (!(key in defaultGit)) {
        (out.git as Record<string, unknown>)[key] = existingGit[key];
      }
    }
  }

  return out;
}

/** 无文件 → 默认并写出；合法文件补缺省键。读取/解析失败保留原文件并报错。 */
export function readWorkspaceFile(root: string, options: { readonly?: boolean } = {}): WorkspaceFileConfig {
  const p = workspaceJsonPath(root);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const cfg = defaultWorkspaceFileConfig();
    if (!options.readonly) writeWorkspaceJson(root, cfg);
    return cfg;
  }
  const parsed = JSON.parse(raw) as WorkspaceFileConfig;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed.git !== undefined && (!parsed.git || typeof parsed.git !== 'object' || Array.isArray(parsed.git)))) {
    throw new Error(`Invalid workspace configuration: ${p}`);
  }
  const merged = mergeWorkspaceDefaults(parsed);
  if (!options.readonly && `${JSON.stringify(merged, null, 2)}\n` !== raw) {
    writeWorkspaceJson(root, merged);
  }
  return merged;
}

/** 浅合并顶层；git 字段浅合并 */
export function patchWorkspaceFile(root: string, patch: Partial<WorkspaceFileConfig>): WorkspaceFileConfig {
  const current = readWorkspaceFile(root);
  const next: WorkspaceFileConfig = { ...current, ...patch };
  if (patch.git !== undefined) {
    next.git = { ...(current.git ?? {}), ...patch.git };
  }
  if (patch.rightWorkspace) {
    const { bookmarks: _bookmarks, bookmarkDefaultsVersion: _version, ...layout } = patch.rightWorkspace;
    // A tab save may arrive while migration is publishing the standalone file.
    next.rightWorkspace = { ...layout, ...legacyWorkspaceBookmarks(current) };
  }
  writeWorkspaceJson(root, next);
  return next;
}

export function legacyWorkspaceBookmarks(config: WorkspaceFileConfig) {
  const saved = config.rightWorkspace;
  return {
    ...(saved && Object.hasOwn(saved, 'bookmarks') ? { bookmarks: saved.bookmarks } : {}),
    ...(saved && Object.hasOwn(saved, 'bookmarkDefaultsVersion') ? { bookmarkDefaultsVersion: saved.bookmarkDefaultsVersion } : {})
  };
}

export function removeLegacyWorkspaceBookmarks(root: string, matches: (fields: ReturnType<typeof legacyWorkspaceBookmarks>) => boolean): void {
  const config = readWorkspaceFile(root, { readonly: true });
  if (!config.rightWorkspace || !matches(legacyWorkspaceBookmarks(config))) return;
  const { bookmarks: _bookmarks, bookmarkDefaultsVersion: _version, ...layout } = config.rightWorkspace;
  writeJsonAtomicSync(workspaceJsonPath(root), { ...config, rightWorkspace: layout });
}
