import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * USER.md 画像层落位（memory-refactor §10，B7）：userData 全局单文件
 * `<userData>/memory/USER.md`——跨工作区跟着人走，不进任何工作区（工作区记忆文件
 * 不碰它；`.muster` 与 docs/memory 均不涉及）。
 *
 * 职责：
 * - 路径解析：userDataDir 由宿主注入（index.ts boot 传 app.getPath('userData')，
 *   照 setAgentMessagesUserDataDir 同款注入先例）；模块保持零 electron 依赖。
 * - 读：全文读（注入/面板/索引共用；文件缺省返回 null）。
 * - 写：**人在面板直改 = 终审免审直写**（决策 #7——人就是审批者）与治理路径
 *   （画像巩固/审批执行）共用的受控落盘：伪造 origin 注解剥离、4000 字符硬上限
 *   （§10「只可调低不能调高」；治理超限拒写、面板超限拒绝保存）、原子写。
 *
 * 纯盘上操作（路径注入；.mjs 可转译直测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomicSync } from '../atomicJson';
import { USER_PROFILE_MAX_CHARS, stripOriginAnnotationTail } from './entryFormat';
import { readTextFile } from './fileRead';

/** userData 下画像目录/文件名（§10 落位） */
export const USER_MD_DIR_NAME = 'memory';
export const USER_MD_FILE_NAME = 'USER.md';

let userProfilePath: string | null = null;

/** USER.md 绝对路径（未注入返回 null——调用方按缺省画像文件缺席处理） */
export function getUserProfileFilePath(): string | null {
  return userProfilePath;
}

/** `<userDataDir>/memory/USER.md`（纯路径计算，供注入与 boot 装配） */
export function userProfileFilePathFor(userDataDir: string): string {
  return path.join(userDataStorage(userDataDir).resolve('app', 'memory'), USER_MD_FILE_NAME);
}

/** boot 装配：注入 userData 目录（内部拼 `<userData>/memory/USER.md`；幂等；null 卸载——测试用） */
export function setUserProfileFilePath(userDataDir: string | null): void {
  userProfilePath = userDataDir == null ? null : userProfileFilePathFor(userDataDir);
}

/** 读 USER.md 全文（缺省/不可读 null） */
export function readUserProfile(): string | null {
  const p = userProfilePath;
  if (!p) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export type UserProfileWriteResult =
  | { ok: true; chars: number; totalChars: number; file: string }
  | { ok: false; code: 'no_path' | 'empty' | 'too_long' | 'over_cap' | 'read_failed'; message: string };

// ---------------------------------------------------------------------------
// 画像写事件观察点（记忆面板条目 1A：`profile_write` 事件唯一收口）
// ---------------------------------------------------------------------------

export interface ProfileWriteEventInfo {
  chars: number;
  totalChars: number;
}

type ProfileWriteObserver = ((info: ProfileWriteEventInfo) => void) | null;

let profileWriteObserver: ProfileWriteObserver = null;

/**
 * 注入画像写观察点（boot/服务装配时接线）：USER.md 全局无归属工作区，事件落
 * 「最近活跃」的工作区派生库（MemoryService.init 打开库时注入——面板/工具的读写
 * 都会先 init 活跃工作区）。观察点内部失败自行消化，绝不影响写盘。传 null 卸载。
 */
export function setProfileWriteObserver(fn: ProfileWriteObserver): void {
  profileWriteObserver = fn;
}

function notifyProfileWrite(info: ProfileWriteEventInfo): void {
  try {
    profileWriteObserver?.(info);
  } catch (err) {
    console.error('[memory] profile_write 事件观察点失败（不影响写盘）', err);
  }
}

/** 单条画像 directive 的规范形态（§10 契约：元数据行 + 一条指令式条目；纯函数） */
export function formatProfileDirective(directiveText: string, now: Date = new Date()): string {
  const body = stripOriginAnnotationTail(String(directiveText ?? '')).replace(/\s+/g, ' ').trim();
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `<!-- observed: ${d} | status: active -->\n\n- ${body}`;
}

/**
 * 追加一条 active directive 到 USER.md（memory.remember 画像路由的落盘通道，
 * §10「新增可自动」档）：文件不存在则创建；沿用 writeUserProfile 的守卫
 * （origin 剥离 / 4000 上限超限不硬写 / 原子写）。正文折成单行（一条指令一条）。
 */
export function appendProfileDirective(directiveText: string, opts: { now?: Date } = {}): UserProfileWriteResult {
  const p = userProfilePath;
  if (!p) return { ok: false, code: 'no_path', message: 'USER.md 路径未装配（userData 未注入）' };
  const entry = formatProfileDirective(directiveText, opts.now ?? new Date());
  if (!entry.includes('- ') || entry.endsWith('- ')) {
    return { ok: false, code: 'empty', message: '画像内容不能为空' };
  }
  // 写前读取（M3）：读取失败（EIO/EACCES 等）中止追加——旧指令不允许被当空文件覆盖；
  // ENOENT/真实空文件仍按首次创建放行。展示面继续用 readUserProfile（null 容错）。
  const existingRead = readTextFile(p);
  if (existingRead.status === 'error') {
    return {
      ok: false,
      code: 'read_failed',
      message: `读取 ${p} 失败（${existingRead.code}）：${existingRead.message}——已中止追加，防止覆盖既有画像`
    };
  }
  const existing = existingRead.status === 'ok' ? existingRead.content : null;
  const merged = existing == null || !existing.trim() ? entry : `${existing.trimEnd()}\n\n${entry}`;
  return writeUserProfile(merged, opts);
}

/**
 * 受控直写 USER.md 全文（终审免审通道 + 治理执行共用）：
 * - 伪造 origin 注解剥离（画像条目本身不落 origin 注解——展示面在策展条目）；
 * - 硬上限 USER_PROFILE_MAX_CHARS（4000，§10 只可调低）：全文超限拒绝写盘；
 * - 原子写（目录不存在自动建）。
 */
export function writeUserProfile(content: string, opts: { now?: Date } = {}): UserProfileWriteResult {
  const p = userProfilePath;
  if (!p) return { ok: false, code: 'no_path', message: 'USER.md 路径未装配（userData 未注入）' };
  const clean = stripOriginAnnotationTail(String(content ?? ''));
  if (!clean.trim()) return { ok: false, code: 'empty', message: '画像内容不能为空' };
  const finalContent = clean.endsWith('\n') || !clean ? clean : `${clean}\n`;
  const total = finalContent.trim().length;
  if (total > USER_PROFILE_MAX_CHARS) {
    return {
      ok: false,
      code: 'over_cap',
      message: `画像超出 ${USER_PROFILE_MAX_CHARS} 字符上限（当前 ${total}）——USER.md 上限只可调低不能调高，请先合并/淘汰旧指令`
    };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeTextAtomicSync(p, finalContent);
  // `profile_write` 事件（条目 1A 写点收口）：面板直改 / memory.remember 画像路由 /
  // 画像治理共用本落盘函数，每次成功写盘恰好一行（经观察点注入 db，失败不阻塞）
  notifyProfileWrite({ chars: clean.length, totalChars: total });
  return { ok: true, chars: clean.length, totalChars: total, file: p };
}
