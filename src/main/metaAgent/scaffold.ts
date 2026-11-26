import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  META_AGENT_DIR,
  META_AGENT_PRODUCT,
  META_AGENT_SCHEMA_VERSION
} from '../../shared/metaAgent';
import { readWorkspaceFile } from './workspaceFile';
import { removeRetiredAuthoringReadmes } from './retiredAuthoringReadmes';

export { patchWorkspaceFile, readWorkspaceFile } from './workspaceFile';

// .muster/.gitignore：runtime.json=退役的历史发现文件，仅继续忽略，不读取/更新/删除；
// local/=本地存储（宿主私有
// 约定目录，R-17 评估后暂留——内容不可枚举，物理迁移留给后续）；tasks*.json=历史共享任务记录
// （功能已退役，仅继续忽略旧文件，不读写）；scheduler/=调度私有
// 记忆双文件（R-12 MEMORY.md/SITUATION.md，编排域本地运行时资产）——本地运行时
// 状态，不随仓同步、跨机不同步（人可直读直改，写路径有守卫）。
// memory/=记忆派生态库 state.sqlite（memory-refactor §4.2，Markdown canonical 之外
// 的纯派生索引，删库可重建）——同属本地运行时状态，不随仓同步。
// 发布前 schema v1 起邮箱 SQLite 和不可变正文文件落宿主 userData，不再落
// .muster。旧邮箱由显式 pre-release reset 清理，scaffold 不读取、迁移或删除旧文件。
// workflows/**/.exec-*.mjs=工作流执行快照（dw F-01）：workflows/ 目录本身进仓（人与
// 调度共写），但 kernel 的 .exec-<指纹>-<runId>.mjs（validate 为 .exec-validate-*）是
// 绑定执行字节的短期快照，terminate/宿主崩溃时残留——功能无害但不能进 git status。
const DIR_GITIGNORE =
  'runtime.json\nlocal/\ntasks.json\ntasks-archive.json\nscheduler/\nmemory/\nknowledge/\nworkflows/**/.exec-*.mjs\n';

const LEGACY_ROOT_DOC_NAMES = new Set(['agents.md', 'agent.md', 'claude.md']);
const LEGACY_HOST_BLOCK = /^<!-- (muster(?:-memory)?|metaagent(?:-memory)?):begin -->\r?\n(?:(?!^<!-- (?:muster|metaagent)(?:-memory)?:(?:begin|end) -->)[\s\S])*^<!-- \1:end -->(?:\r?\n|$)/gm;

function metaAgentPath(root: string, ...parts: string[]): string {
  return path.join(root, META_AGENT_DIR, ...parts);
}

/** Retire complete blocks written by previous releases, including pre-rename markers. */
function removeLegacyAgentBlocks(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !LEGACY_ROOT_DOC_NAMES.has(entry.name.toLowerCase())) continue;
    const file = path.join(root, entry.name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) continue;
    const previous = fs.readFileSync(file, 'utf8');
    const bom = previous.startsWith('\uFEFF') ? '\uFEFF' : '';
    const next = bom + previous.slice(bom.length).replace(LEGACY_HOST_BLOCK, '');
    if (previous === next) continue;
    if (next.trim()) fs.writeFileSync(file, next, 'utf8');
    else fs.unlinkSync(file);
  }
}

function writeManifest(root: string): void {
  const p = metaAgentPath(root, 'manifest.json');
  let initializedAt = new Date().toISOString();
  if (fs.existsSync(p)) {
    try {
      const prev = JSON.parse(fs.readFileSync(p, 'utf8')) as { initializedAt?: string };
      if (typeof prev.initializedAt === 'string' && prev.initializedAt) {
        initializedAt = prev.initializedAt;
      }
    } catch {
      /* ignore */
    }
  }
  const manifest = {
    product: META_AGENT_PRODUCT,
    schemaVersion: META_AGENT_SCHEMA_VERSION,
    initializedAt
  };
  fs.writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const RETIRED_HOST_EXT_DIGESTS = new Set([
  '837bd96bf58d748a555b54aa210e18ac47e8d2a410f1df04db9d15b451313595',
  'f213e23809aa18a5e9a18c8b00519a6301d681cfcd03c42357030be83f32c33b',
]);

/** Remove known generated protocols on upgrade. Custom files and links stay in place. */
function removeRetiredHostDocs(directory: string): void {
  if (!fs.lstatSync(directory).isDirectory()) return;
  for (const name of ['HOST.md', 'HOST-EXT.md']) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) continue;
    const previous = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const content = name === 'HOST.md'
      ? previous.split('\n## Global Conduct Rules (user-set; must be followed)\n', 1)[0]
      : previous;
    const digest = createHash('sha256').update(content).digest('hex');
    const generated = name === 'HOST.md'
      ? digest === 'bf5c4859a4cdd935bb800637dc734a6b3a4513d77691e27f6d26ce5af7140003'
      : RETIRED_HOST_EXT_DIGESTS.has(digest);
    if (generated) fs.unlinkSync(file);
  }
}

/** 去掉早期误放的 skills/metaagent-host（曾伪装成 CLI Skill） */
function removeLegacyHostSkill(root: string): void {
  const legacy = metaAgentPath(root, 'skills', 'metaagent-host');
  try {
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
    const skillsDir = metaAgentPath(root, 'skills');
    if (fs.existsSync(skillsDir) && fs.readdirSync(skillsDir).length === 0) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

/** Scaffold and migrations run once per workspace root in this process. */
const ensuredRoots = new Set<string>();

export function ensureMetaAgentScaffold(root: string): { created: boolean; path: string } {
  const dir = metaAgentPath(root);
  const key = path.resolve(root);
  if (ensuredRoots.has(key)) {
    removeLegacyHostSkill(root);
    return { created: false, path: dir };
  }
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaAgentPath(root, '.gitignore'), DIR_GITIGNORE, 'utf8');
  writeManifest(root);
  removeRetiredHostDocs(dir);
  for (const directory of ['extensions', 'workflows']) {
    fs.mkdirSync(metaAgentPath(root, directory), { recursive: true });
  }
  removeRetiredAuthoringReadmes(dir);
  removeLegacyHostSkill(root);
  readWorkspaceFile(root);
  removeLegacyAgentBlocks(root);
  ensuredRoots.add(key);
  return { created, path: dir };
}
