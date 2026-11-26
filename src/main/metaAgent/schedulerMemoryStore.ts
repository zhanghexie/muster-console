/**
 * 调度机械态势通道（R-12 保留项）文件 IO 层：`.muster/scheduler/SITUATION.md`
 * ——宿主机械生成、模型只读（§3 tier 映射的前瞻层机械态势部分）。
 *
 * 定位与 tasks.json 同口径（R-05 拍板）：编排域本地运行时资产——进
 * `.muster/.gitignore`（人可直读直改，跨机不共享）。原子写沿用 atomicJson；
 * 读路径一律 fail-soft（缺失/损坏返回空串，注入不被拖垮）。
 * 纯格式/拼装逻辑在 shared/schedulerMemory.ts，本模块只做盘上读写。
 *
 * B8 退役说明（memory-refactor §12）：调度 MEMORY.md 的注入/追加路径已退役——
 * 注入走 MemoryService.inject（scheduler 面 bootstrap），写入走 memory.note/remember
 * （直写门/巩固）；整理工具 scheduler.memory.write 的落盘在 memory/schedulerCurated.ts。
 * 本模块不再承载任何 MEMORY.md 通道。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomicSync } from '../atomicJson';
import { META_AGENT_DIR } from '../../shared/metaAgent';
import { SCHEDULER_SITUATION_FILE } from '../../shared/schedulerMemory';

export const SCHEDULER_DIR_REL = path.join(META_AGENT_DIR, 'scheduler');

export function schedulerSituationFilePath(root: string): string {
  return path.join(root, SCHEDULER_DIR_REL, SCHEDULER_SITUATION_FILE);
}

function readTextSoft(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** 读机械态势快照（fail-soft；模型注入与工具回显共用） */
export function readSchedulerSituation(root: string): string {
  return readTextSoft(schedulerSituationFilePath(root)).trim();
}

/**
 * `.muster/.gitignore` 确保 `scheduler/` 在册（软确保）：scaffold 的 DIR_GITIGNORE
 * 已含，但存量工作区只在全套重写时刷新——写路径顺手补一行，自愈且幂等。
 */
export function ensureSchedulerGitignoreEntry(root: string): void {
  try {
    const gi = path.join(root, META_AGENT_DIR, '.gitignore');
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (/^scheduler\/\s*$/m.test(cur)) return;
    const next = `${cur}${cur.endsWith('\n') || !cur ? '' : '\n'}scheduler/\n`;
    fs.mkdirSync(path.dirname(gi), { recursive: true });
    fs.writeFileSync(gi, next, 'utf8');
  } catch (err) {
    console.error('[scheduler-memory] .gitignore 补 scheduler/ 失败（忽略）', err);
  }
}

/** 写机械态势快照（宿主唯一写者；目录随写随建 + gitignore 自愈） */
export function writeSchedulerSituation(root: string, markdown: string): void {
  ensureSchedulerGitignoreEntry(root);
  writeTextAtomicSync(schedulerSituationFilePath(root), markdown);
}
