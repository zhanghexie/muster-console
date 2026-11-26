import { userDataStorage } from './runtimeKernel/storageRootResolver';
/**
 * 用户自定义头像文件：userData/avatars/user.png。
 * ConfigManager 在 update/load 时调用；config.json 的 image 项不内嵌 data URL。
 */
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../shared/i18n';
import {
  isAvatarDataUrl,
  normalizeUserAvatar,
  type UserAvatarConfig,
  DEFAULT_USER_AVATAR_EMOJI
} from '../shared/userAvatar';

export const USER_AVATAR_REL = path.join('avatars', 'user.png');
const MAX_BYTES = 256 * 1024;

let tmpSeq = 0;

/** 原子写 Buffer：同目录临时文件 + rename（同 atomicJson 的模式；那边的函数是 utf8 文本专用） */
function writeBufferAtomicSync(abs: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  tmpSeq = (tmpSeq + 1) % 0xffff;
  const tmp = `${abs}.${process.pid}-${tmpSeq}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能压根没建出来 */
    }
    throw err;
  }
}

export function userAvatarFilePath(userDataDir: string): string {
  return path.join(userDataStorage(userDataDir).resolve('app', 'avatars'), 'user.png');
}

export function writeUserAvatarImage(userDataDir: string, dataUrl: string): boolean {
  const compact = dataUrl.replace(/\s+/g, '');
  if (!isAvatarDataUrl(compact) && !compact.startsWith('data:image/')) return false;
  const comma = compact.indexOf(',');
  if (comma < 0) return false;
  let buf: Buffer;
  try {
    buf = Buffer.from(compact.slice(comma + 1), 'base64');
  } catch {
    return false;
  }
  if (!buf.length || buf.length > MAX_BYTES) return false;
  writeBufferAtomicSync(userAvatarFilePath(userDataDir), buf);
  return true;
}

export function readUserAvatarDataUrl(userDataDir: string): string | undefined {
  const dest = userAvatarFilePath(userDataDir);
  try {
    if (!fs.existsSync(dest)) return undefined;
    const buf = fs.readFileSync(dest);
    if (!buf.length) return undefined;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export function removeUserAvatarFile(userDataDir: string): void {
  const dest = userAvatarFilePath(userDataDir);
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
  } catch {
    /* ignore */
  }
}

function keepName(base: UserAvatarConfig, from: UserAvatarConfig): UserAvatarConfig {
  return from.displayName ? { ...base, displayName: from.displayName } : base;
}

/** update 入参：写/删文件，返回内存态（image 保留 data URL 供 get()）。
 * 头像图片落盘失败（处理后仍超 256KB / 数据无效）不再静默回落 emoji（P3 头像 F-01）：
 * 抛错让 config.update 整单失败，设置页得以提示并保留原头像。 */
export function persistUserAvatarPatch(
  userDataDir: string,
  incoming: unknown
): UserAvatarConfig {
  const norm = normalizeUserAvatar(incoming);
  if (norm.kind !== 'image') {
    removeUserAvatarFile(userDataDir);
    return norm;
  }
  if (norm.value && (isAvatarDataUrl(norm.value) || norm.value.startsWith('data:image/'))) {
    if (!writeUserAvatarImage(userDataDir, norm.value)) {
      throw new Error(t('图片处理后仍超过 256KB 上限或数据无效，未更新头像'));
    }
    return keepName({ kind: 'image', value: norm.value }, norm);
  }
  const existing = readUserAvatarDataUrl(userDataDir);
  if (existing) return keepName({ kind: 'image', value: existing }, norm);
  return keepName({ kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI }, norm);
}

export function hydrateUserAvatar(
  userDataDir: string,
  av: UserAvatarConfig | undefined
): UserAvatarConfig {
  const norm = normalizeUserAvatar(av);
  if (norm.kind !== 'image') {
    return norm;
  }
  if (norm.value) return norm;
  const existing = readUserAvatarDataUrl(userDataDir);
  if (existing) return keepName({ kind: 'image', value: existing }, norm);
  return keepName({ kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI }, norm);
}
