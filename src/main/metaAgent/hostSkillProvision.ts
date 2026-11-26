/**
 * 宿主能力域技能正文的安装/升级链（P1 修复，2026-10-23）：run 工具和宿主创作合同指向
 * `~/.muster/skills/<域>/SKILL.md`（runFactory SKILL_ROOT），此前该目录只在开发机上
 * 手工存在——换机/新用户安装后工具指向不存在的参数说明，应用升级后内容也不会更新。
 *
 * 真源：仓库 `resources/skills/<域>/SKILL.md`，经 electron-builder extraResources
 * （`from: resources/skills` → `to: skills`）随安装包分发。主进程启动时（先于 scaffold
 * 的显式加载，index.ts）ensure 到 `~/.muster/skills/`。
 *
 * 版本机制：每份 SKILL.md 的 frontmatter 带 `x-muster-version`（拷入真源时打当前
 * package.json 版本）；内容有改动时随发布节奏 bump 该字段。启动时逐域比对包内版本与
 * 磁盘版本：
 * - 磁盘缺失（或无版本字段，如 R3a 时代手工部署的旧文件）→ 写入（installed）；
 * - 包版本新 → 覆盖（updated）；
 * - 磁盘版本 ≥ 包 → 不动（kept，幂等零写入）。
 * 取舍：磁盘文件被用户改过但版本旧 → 仍覆盖——这些是宿主自有文档，不是用户资产；
 * 包内某域缺失或版本字段不可解析 → 跳过 + warn（不猜、不降级覆盖）。
 *
 * 单一真源：本模块不出现第二份 SKILL_ROOT 字面量、不抄域清单——目标根经
 * hostDomainSkills 的 resolveHostSkillRootDir()、声明域清单经 hostSkillDomainDirs()
 * （= runFactory SKILL_ROOT + runTools RUN_TOOL_DOMAINS 派生，守卫见
 * test/host-domain-skills.mjs 与 test/host-skill-provision.mjs）。
 *
 * dev/打包两态的包内根解析（resolveBundledSkillsDir，可注入环境便于测试）：
 * - dev（app.isPackaged=false）：主 bundle 在 out/main → 仓库根 resources/skills 原地；
 * - 打包：extraResources 落在安装目录 `process.resourcesPath/skills`
 *   （与 resources/cli 的 scheduler-guide.txt 同机制）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { hostSkillDomainDirs, resolveHostSkillRootDir } from './hostDomainSkills';
import { t } from '../../shared/i18n';

/** frontmatter 升级判定字段（版本为点分数字串，如 0.1.31） */
export const SKILL_VERSION_FIELD = 'x-muster-version';

/** 包内真源解析所需的最小 Electron 环境（index.ts 注入真值；测试注 fixture） */
export interface BundledSkillsEnv {
  isPackaged: boolean;
  resourcesPath: string;
  moduleDir: string;
}

/**
 * 包内宿主技能真源根目录：
 * - 打包态 = 安装目录 `<resources>/skills`（electron-builder extraResources `to: skills`）；
 * - dev 态 = 主 bundle（out/main）上溯两级到仓库根的 resources/skills 原地。
 */
export function resolveBundledSkillsDir(env: BundledSkillsEnv): string {
  return env.isPackaged
    ? path.join(env.resourcesPath, 'skills')
    : path.resolve(env.moduleDir, '..', '..', 'resources', 'skills');
}

/**
 * 从 SKILL.md 文本读 frontmatter 版本字段；无 frontmatter / 无字段 / frontmatter 未闭合
 * → null。只在 frontmatter 块内找，正文同名文本不算。
 */
export function readSkillVersion(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return null; // frontmatter 闭合，字段不在
    const match = new RegExp(`^${SKILL_VERSION_FIELD}:\\s*(\\S+)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return null;
}

/** 点分数字版本比较（缺失段按 0，非数字段按 0）；返回 -1/0/1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((seg) => Number.parseInt(seg, 10) || 0);
  const pb = b.split('.').map((seg) => Number.parseInt(seg, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export interface HostSkillProvisionResult {
  /** 磁盘缺失（或无版本字段）而新写入的域 */
  installed: string[];
  /** 包版本新而覆盖的域 */
  updated: string[];
  /** 磁盘版本 ≥ 包版本而未动的域 */
  kept: string[];
  /** 包内缺失或版本字段不可解析而跳过的域（warn，不写盘） */
  invalidBundled: string[];
  errors: string[];
}

export interface HostSkillProvisionOptions {
  /** Optional bounded maintenance selection; unknown domains are rejected. */
  domains?: readonly string[];
  /** 包内真源根（dev=仓库 resources/skills，打包=process.resourcesPath/skills） */
  bundledRootDir: string;
  /** 落盘根；缺省 resolveHostSkillRootDir()（= ~/.muster/skills）。测试注入受控根 */
  skillRootDir?: string;
}

function bundledFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, relative = ''): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) files.push(childRelative);
    }
  };
  visit(rootDir);
  return files;
}

/** Keep packaged companion files (for example UI examples) alongside SKILL.md. */
function syncBundledResources(bundledDir: string, diskDir: string, overwrite: boolean): void {
  for (const relative of bundledFiles(bundledDir)) {
    if (relative === 'SKILL.md') continue;
    const source = path.join(bundledDir, relative);
    const target = path.join(diskDir, relative);
    if (!overwrite && fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(source));
  }
}

/**
 * 对每个宿主域逐一确保 `~/.muster/skills/<域>/SKILL.md` 与包内真源同步（三态：
 * 缺→写 / 包新→覆盖 / 磁盘≥包→不动）。同步、廉价（按声明域逐个读取）；
 * 单域失败进 errors 不炸整轮。
 */
export function provisionHostDomainSkills(opts: HostSkillProvisionOptions): HostSkillProvisionResult {
  const res: HostSkillProvisionResult = {
    installed: [],
    updated: [],
    kept: [],
    invalidBundled: [],
    errors: []
  };
  const skillRoot = path.resolve(opts.skillRootDir ?? resolveHostSkillRootDir());
  const domains=hostSkillDomainDirs();
  if(opts.domains?.some(dir=>!domains.includes(dir)))throw new Error('未知宿主技能');
  for (const dir of domains.filter(dir=>!opts.domains||opts.domains.includes(dir))) {
    try {
      const bundledPath = path.join(opts.bundledRootDir, dir, 'SKILL.md');
      let bundledText: string;
      try {
        bundledText = fs.readFileSync(bundledPath, 'utf8');
      } catch {
        console.warn(t('宿主域技能包内正文缺失，跳过安装：{{path}}', { path: bundledPath }));
        res.invalidBundled.push(dir);
        continue;
      }
      const bundledVersion = readSkillVersion(bundledText);
      if (!bundledVersion) {
        console.warn(
          t('宿主域技能包内正文缺少有效的 {{field}}，跳过安装：{{path}}', {
            field: SKILL_VERSION_FIELD,
            path: bundledPath
          })
        );
        res.invalidBundled.push(dir);
        continue;
      }
      const diskPath = path.join(skillRoot, dir, 'SKILL.md');
      const bundledDir = path.join(opts.bundledRootDir, dir);
      if(dir==='memory'||dir==='feedback'){
        for(const candidate of [path.dirname(diskPath),diskPath]){
          if(fs.existsSync(candidate)&&fs.lstatSync(candidate).isSymbolicLink())throw new Error(`${dir} 技能路径由外部链接占用，未覆盖`);
        }
        if (fs.existsSync(diskPath)) {
          const existing = fs.readFileSync(diskPath, 'utf8');
          // Repair only an exact bundled copy left in the new Muster root by
          // the interrupted rename. This is not an old-root import or a
          // fallback parser for user-authored/legacy skills.
          const exactInterruptedCopy = existing.replace(/\r\n/g, '\n').replace(/^x-metaagent-version:/m, `${SKILL_VERSION_FIELD}:`) === bundledText.replace(/\r\n/g, '\n');
          if (!readSkillVersion(existing) && !exactInterruptedCopy) throw new Error(`${dir} 同名技能没有宿主版本标记，未覆盖，请保留用户技能并解决名称冲突`);
        }
      }
      // 读不到（文件缺失）与读到但无版本字段（R3a 手工部署旧文件）都算待安装：
      // 无版本 = 旧于任何带版本真源，按「包新→覆盖」处理
      let diskVersion: string | null = null;
      try {
        diskVersion = readSkillVersion(fs.readFileSync(diskPath, 'utf8'));
      } catch {
        /* 缺失 → 安装 */
      }
      if (diskVersion && compareVersions(diskVersion, bundledVersion) >= 0) {
        syncBundledResources(bundledDir, path.dirname(diskPath), false);
        res.kept.push(dir);
        continue;
      }
      fs.mkdirSync(path.join(skillRoot, dir), { recursive: true });
      fs.writeFileSync(diskPath, bundledText, 'utf8');
      syncBundledResources(bundledDir, path.dirname(diskPath), true);
      if (diskVersion) res.updated.push(dir);
      else res.installed.push(dir);
    } catch (e) {
      res.errors.push(`${dir}: ${String(e)}`);
    }
  }
  return res;
}
