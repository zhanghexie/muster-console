import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const exists = (value: string): boolean => { try { fs.lstatSync(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
export interface SkillPackage { path: string; fingerprint: string }
/** Complete package evidence, not just SKILL.md. Never follow package-owned links. */
export function skillPackageFingerprint(root: string): string {
  const entries: string[] = []; let bytes = 0, count = 0;
  const visit = (file: string, relative: string): void => {
    const stat = fs.lstatSync(file);
    if (++count > 20000 || bytes > 100 * 1024 * 1024) throw new Error('技能包超过归并大小限制，请先整理目录。');
    if (stat.isSymbolicLink()) throw new Error(`技能包内含链接，无法安全归并：${file}`);
    if (stat.isDirectory()) {
      if (relative && (path.basename(file) === '.git' || fs.existsSync(path.join(file, 'SKILL.md')))) throw new Error(`技能包含仓库或嵌套技能，无法整体删除：${file}`);
      entries.push(`d:${relative}:${stat.mode}`);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 100 * 1024 * 1024) throw new Error('技能包超过 100 MiB，无法归并。');
      entries.push(`f:${relative}:${stat.mode}:${digest(fs.readFileSync(file))}`);
    } else throw new Error(`技能包内存在特殊文件：${file}`);
  };
  visit(root, ''); return digest(JSON.stringify(entries));
}
export function skillDirectoryLinkSpec(target: string, link: string, platform: NodeJS.Platform = process.platform): { target: string; type: 'junction' | 'dir' } {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return { target: platform === 'win32' ? paths.resolve(target) : paths.relative(paths.dirname(link), target), type: platform === 'win32' ? 'junction' : 'dir' };
}
export function createSkillDirectoryLink(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const spec = skillDirectoryLinkSpec(target, link);
  fs.symlinkSync(spec.target, link, spec.type);
  try {
    if (fs.realpathSync(link) !== fs.realpathSync(target)) throw new Error(`技能链接读回失败：${link}`);
  } catch (error) {
    if (fs.lstatSync(link).isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(target)) fs.unlinkSync(link);
    throw error;
  }
}
export function pendingSkillConsolidation(backupRoot: string): string | undefined {
  if (!fs.existsSync(backupRoot)) return;
  for (const id of fs.readdirSync(backupRoot)) {
    const journal = path.join(backupRoot, id, 'transaction.json');
    if (!fs.existsSync(journal)) continue;
    const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (!['complete', 'rolled-back'].includes(value.phase)) return journal;
  }
}

/** Backup -> stage -> publish -> metadata. Any in-process failure restores original packages. */
export function consolidateSkillPackages(input: {
  packages: SkillPackage[]; selectedPath: string; destination: string; linkPaths: string[];
  destinationAlias?: string;
  backupRoot: string; validate: () => void; beforePublish: () => void; commit: () => void;
}): string {
  const pending = pendingSkillConsolidation(input.backupRoot);
  if (pending) throw new Error(`存在未完成的技能归并，请先按事务清单恢复：${pending}`);
  input.validate();
  const id = randomUUID(), backupPath = path.join(input.backupRoot, id);
  fs.mkdirSync(backupPath, { recursive: true });
  const selected = input.packages.find(item => item.path === input.selectedPath)!;
  const staged = input.packages.map((item, index) => ({ ...item, backup: path.join(backupPath, String(index)), stage: path.join(path.dirname(item.path), `.skill-consolidation-${id}-${index}`) }));
  const published: string[] = [], moved: typeof staged = [];
  const temp = path.join(path.dirname(input.destination), `.skill-consolidation-${id}-new`);
  const journal = path.join(backupPath, 'transaction.json');
  const aliasStage = path.join(path.dirname(input.destination), `.skill-consolidation-${id}-alias`);
  let aliasMoved = false;
  const record = (phase: string, error?: string): void => {
    const next = `${journal}.tmp`;
    fs.writeFileSync(next, JSON.stringify({ phase, error, destination: input.destination, destinationAlias: input.destinationAlias, aliasStage, selected: input.selectedPath, staged, linkPaths: input.linkPaths, temp }, null, 2));
    fs.renameSync(next, journal);
  };
  let metadataCommitted = false;
  try {
    record('preparing');
    for (const item of staged) {
      fs.cpSync(item.path, item.backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      if (skillPackageFingerprint(item.backup) !== item.fingerprint) throw new Error('技能备份读回不一致，未删除原文件。');
    }
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    fs.cpSync(selected.path, temp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    if (skillPackageFingerprint(temp) !== selected.fingerprint) throw new Error('技能暂存读回不一致。');
    input.validate(); input.beforePublish(); record('publishing');
    if (input.destinationAlias !== undefined) { fs.renameSync(input.destination, aliasStage); aliasMoved = true; }
    for (const item of staged) { fs.renameSync(item.path, item.stage); moved.push(item); }
    fs.renameSync(temp, input.destination); published.push(input.destination);
    for (const link of input.linkPaths) { createSkillDirectoryLink(input.destination, link); published.push(link); }
    if (skillPackageFingerprint(input.destination) !== selected.fingerprint) throw new Error('技能归并后读回不一致。');
    input.commit(); metadataCommitted = true; record('committed');
    for (const item of moved) {
      if (skillPackageFingerprint(item.stage) !== item.fingerprint) throw new Error(`归并后旧副本被外部修改，请检查事务清单：${journal}`);
      fs.rmSync(item.stage, { recursive: true });
    }
    if (aliasMoved) {
      if (!fs.lstatSync(aliasStage).isSymbolicLink() || fs.readlinkSync(aliasStage) !== input.destinationAlias) throw new Error('原通用目录链接被外部修改');
      fs.unlinkSync(aliasStage);
    }
    record('complete'); return backupPath;
  } catch (error) {
    if (metadataCommitted) { record('cleanup-required', String(error)); throw new Error(`统一源已保存，但旧副本清理未完成：${journal}；${String(error)}`); }
    const failures: string[] = [];
    for (const file of published.reverse()) {
      try {
        if (file === input.destination) {
          if (skillPackageFingerprint(file) !== selected.fingerprint) throw new Error('新源被外部修改');
          fs.rmSync(file, { recursive: true });
        } else {
          if (!fs.lstatSync(file).isSymbolicLink() || path.resolve(path.dirname(file), fs.readlinkSync(file)) !== path.resolve(input.destination)) throw new Error('链接被外部修改');
          fs.unlinkSync(file);
        }
      } catch (cause) { failures.push(`${file}: ${String(cause)}`); }
    }
    for (const item of moved.reverse()) {
      try { if (exists(item.path)) throw new Error('原路径被占用'); fs.renameSync(item.stage, item.path); }
      catch (cause) { failures.push(`${item.path}: ${String(cause)}`); }
    }
    if (aliasMoved) {
      try { if (exists(input.destination)) throw new Error('通用目录已被占用'); fs.renameSync(aliasStage, input.destination); }
      catch (cause) { failures.push(String(cause)); }
    }
    if (exists(temp)) { try { if (skillPackageFingerprint(temp) !== selected.fingerprint) throw new Error('暂存内容变化'); fs.rmSync(temp, { recursive: true }); } catch (cause) { failures.push(String(cause)); } }
    record(failures.length ? 'recovery-required' : 'rolled-back', `${String(error)} ${failures.join('; ')}`);
    throw new Error(`${String(error)}${failures.length ? `；回滚未完成，请检查 ${journal}: ${failures.join('; ')}` : '；原文件已保留或恢复。'}`);
  }
}
