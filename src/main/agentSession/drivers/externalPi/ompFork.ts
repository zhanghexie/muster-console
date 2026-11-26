import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GuiNativeForkPoint } from '../../types';
import { ConnectionCleanupError } from '../../host/retirement';
import { boundedAcpRequest } from '../acp/models';
import { externalPiLaunchArgs, externalPiLaunchEnvironment } from './executable';
import { ExternalPiRpc } from './rpc';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 20_000;
const samePath = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

/** get_entries is append history, not a branch; follow its durable parent chain. */
export async function readOmpBranch(rpc: ExternalPiRpc): Promise<{ leaf: string | null; entries: Obj[] }> {
  const data = object((await rpc.request('get_entries', {}, 5000)).data);
  if (!Array.isArray(data.entries) || data.entries.length > 100000 || (data.leafId !== null && typeof data.leafId !== 'string'))
    throw new Error('Oh My Pi 未提供可校验的原生消息树');
  const indexed = new Map<string, Obj>();
  for (const value of data.entries) {
    const entry = object(value), id = text(entry.id);
    if (!id || indexed.has(id)) throw new Error('Oh My Pi 消息树标识无效');
    indexed.set(id, entry);
  }
  const leaf = data.leafId as string | null;
  const branch: Obj[] = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor) {
    if (visited.has(cursor)) throw new Error('Oh My Pi 消息树存在循环');
    visited.add(cursor);
    const entry = indexed.get(cursor);
    if (!entry) throw new Error('Oh My Pi 消息树缺少祖先');
    branch.push(entry);
    cursor = entry.parentId == null ? null : text(entry.parentId);
    if (entry.parentId != null && !cursor) throw new Error('Oh My Pi 消息树父标识无效');
  }
  return { leaf, entries: branch.reverse() };
}

/** OMP journals can have a fixed-width title slot before their session header. */
function replaceHeader(contents: Buffer, expectedId: string, change: (header: Obj) => Obj): Buffer {
  let start = 0;
  for (let index = 0; index < 2; index += 1) {
    const end = contents.indexOf(10, start);
    if (end < 0 || end - start > 64 * 1024) throw new Error('Oh My Pi 会话文件头格式无效');
    const entry = object(JSON.parse(contents.subarray(start, end).toString('utf8')));
    if (entry.type === 'session') {
      if (entry.id !== expectedId) throw new Error('Oh My Pi 会话文件身份不一致');
      return Buffer.concat([contents.subarray(0, start), Buffer.from(`${JSON.stringify(change(entry))}\n`), contents.subarray(end + 1)]);
    }
    if (index !== 0 || entry.type !== 'title') break;
    start = end + 1;
  }
  throw new Error('Oh My Pi 会话文件缺少会话头');
}

type ArtifactSnapshot = { path: string; size: number; mtimeMs: number; directory: boolean };
type CopyBudget = { entries: number; bytes: number; snapshot?: ArtifactSnapshot[] };
/** Copy only regular files and directories; never traverse user-controlled links. */
async function copyArtifacts(source: string, destination: string, budget: CopyBudget): Promise<void> {
  const before = await fs.promises.lstat(source);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Oh My Pi 产物目录包含链接或特殊文件，无法安全复制');
  budget.snapshot?.push({ path: source, size: before.size, mtimeMs: before.mtimeMs, directory: true });
  for (const name of await fs.promises.readdir(source)) {
    const from = path.join(source, name), to = path.join(destination, name);
    const stat = await fs.promises.lstat(from);
    if (++budget.entries > MAX_ARTIFACT_ENTRIES) throw new Error('Oh My Pi 产物文件过多，无法安全分叉');
    if (stat.isSymbolicLink()) throw new Error('Oh My Pi 产物包含链接，无法安全复制');
    if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { mode: 0o700 });
      await copyArtifacts(from, to, budget);
    } else if (stat.isFile()) {
      budget.bytes += stat.size;
      if (budget.bytes > MAX_ARTIFACT_BYTES) throw new Error('Oh My Pi 产物过大，无法安全分叉');
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      const after = await fs.promises.lstat(from);
      if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('Oh My Pi 产物在复制期间发生变化，请重试');
      budget.snapshot?.push({ path: from, size: stat.size, mtimeMs: stat.mtimeMs, directory: false });
    } else throw new Error('Oh My Pi 产物包含特殊文件，无法安全复制');
  }
  const after = await fs.promises.lstat(source);
  if (!after.isDirectory() || after.mtimeMs !== before.mtimeMs)
    throw new Error('Oh My Pi 产物目录在复制期间发生变化，请重试');
}

const messages = (entries: Obj[]): string[] => entries
  .filter(entry => entry.type === 'message' && ['user', 'assistant'].includes(text(object(entry.message).role)))
  .map(entry => `${text(entry.id)}:${text(object(entry.message).role)}`);
const equalList = (left: string[], right: string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const unknownCommand = (error: unknown, command: string): boolean =>
  new RegExp(`^Unknown command: ${command}$`, 'i').test(error instanceof Error ? error.message : '');

/** Fork in a private OMP process, never switch the live source RPC session. */
export async function forkOmp(input: {
  rpc: ExternalPiRpc; sessionId: string; sessionFile: string; point: GuiNativeForkPoint;
  executable: string; cwd: string; log(message: string): void;
}): Promise<{ status: 'forked'; token: string; preservesPointIds: true } | { status: 'unsupported' }> {
  if (input.point.engine !== 'omp' || input.point.sessionToken !== input.sessionId || !input.sessionFile) return { status: 'unsupported' };
  const beforeState = object((await input.rpc.request('get_state')).data);
  if (beforeState.sessionId !== input.sessionId || !path.isAbsolute(input.sessionFile) ||
      !samePath(text(beforeState.sessionFile), input.sessionFile) || beforeState.isSettled !== true || beforeState.hasPendingAsyncWork !== false)
    return { status: 'unsupported' };
  let source: string;
  try { source = await fs.promises.realpath(input.sessionFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      input.log('Oh My Pi 会话文件不可在本机读取，使用原有分叉方式');
      return { status: 'unsupported' };
    }
    throw error;
  }
  if (!source.endsWith('.jsonl') || !(await fs.promises.lstat(source)).isFile()) return { status: 'unsupported' };
  if ((await fs.promises.stat(source)).size > MAX_SESSION_BYTES) throw new Error('Oh My Pi 会话过大，无法安全创建原生分叉');
  const original = await fs.promises.readFile(source);
  if (original.length > MAX_SESSION_BYTES) throw new Error('Oh My Pi 会话过大，无法安全创建原生分叉');
  const alias = randomUUID();
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'muster-omp-native-fork-'));
  const sourceCopy = path.join(temp, `source_${alias}.jsonl`);
  const sourceArtifacts = source.slice(0, -'.jsonl'.length);
  const copiedArtifacts = sourceCopy.slice(0, -'.jsonl'.length);
  let helper: ExternalPiRpc | undefined;
  let cleanupError: unknown;
  let published = '';
  try {
    await fs.promises.writeFile(sourceCopy, replaceHeader(original, input.sessionId, header => ({ ...header, id: alias })), { flag: 'wx', mode: 0o600 });
    let hasArtifacts = false;
    try { await fs.promises.lstat(sourceArtifacts); hasArtifacts = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const artifactSnapshot: ArtifactSnapshot[] = [];
    if (hasArtifacts) {
      await fs.promises.mkdir(copiedArtifacts, { mode: 0o700 });
      await copyArtifacts(sourceArtifacts, copiedArtifacts, { entries: 0, bytes: 0, snapshot: artifactSnapshot });
    }

    let ready!: (frame: Obj) => void;
    const greeting = new Promise<Obj>(resolve => { ready = resolve; });
    const args = ['--mode', 'rpc', '--session', sourceCopy, '--session-dir', temp, '--no-extensions', '--no-skills', '--no-context-files'];
    helper = new ExternalPiRpc({ ...externalPiLaunchArgs(input.executable, args), cwd: input.cwd, env: externalPiLaunchEnvironment(input.executable),
      onFrame(frame) {
        if (frame.type === 'ready') ready(frame);
        else if (frame.type === 'extension_ui_request' && typeof frame.id === 'string') {
          try { helper?.send({ type: 'extension_ui_response', id: frame.id, cancelled: true }); }
          catch (error) { ready({ error: helper?.sanitize((error as Error).message) || 'Oh My Pi 分叉进程交互失败' }); }
        }
      },
      onFailure(error) { ready({ error: error.message }); },
      log(message) { input.log(message); }
    });
    await boundedAcpRequest(helper.waitReady(), 30_000, 'Oh My Pi 分叉进程启动');
    const protocol = await boundedAcpRequest(greeting, 30_000, 'Oh My Pi 分叉协议');
    if (text(protocol.error)) throw new Error(text(protocol.error));
    if (Array.isArray(protocol.supportedProtocolVersions) && protocol.supportedProtocolVersions.includes(2))
      await helper.request('negotiate_protocol', { protocolVersion: 2 });
    const helperState = object((await helper.request('get_state')).data);
    if (helperState.sessionId !== alias || !samePath(text(helperState.sessionFile), sourceCopy))
      throw new Error('Oh My Pi 未能在隔离副本中恢复源会话');
    if (typeof beforeState.messageCount === 'number' && helperState.messageCount !== beforeState.messageCount)
      throw new Error('Oh My Pi 隔离副本与源会话消息不一致');
    let copiedBranch: Awaited<ReturnType<typeof readOmpBranch>>;
    try { copiedBranch = await readOmpBranch(helper); }
    catch (error) {
      if (unknownCommand(error, 'get_entries')) {
        input.log('当前 Oh My Pi 未提供消息树接口，使用原有分叉方式');
        return { status: 'unsupported' };
      }
      throw error;
    }
    const target = copiedBranch.entries.findIndex(entry => entry.id === input.point.entryId && entry.type === 'message' && object(entry.message).role === input.point.role);
    if (target < 0) return { status: 'unsupported' };
    const expected = messages(copiedBranch.entries.slice(0, target + 1));
    let response: Obj;
    try { response = object((await helper.request('fork', { entryId: input.point.entryId })).data); }
    catch (error) {
      if (unknownCommand(error, 'fork')) {
        input.log('当前 Oh My Pi 未提供原生分叉接口，使用原有分叉方式');
        return { status: 'unsupported' };
      }
      throw error;
    }
    if (response.cancelled === true) throw new Error('Oh My Pi 拒绝了原生分叉');
    const child = object((await helper.request('get_state')).data);
    const token = text(child.sessionId), childFile = text(child.sessionFile);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(token) || token === alias || token === input.sessionId ||
        !path.isAbsolute(childFile) || !samePath(path.dirname(childFile), temp) ||
        !path.basename(childFile).endsWith(`_${token}.jsonl`) || !(await fs.promises.lstat(childFile)).isFile())
      throw new Error('Oh My Pi 返回的分叉文件身份无效');
    if (!equalList(messages((await readOmpBranch(helper)).entries), expected))
      throw new Error('Oh My Pi 新分支没有停在指定消息');
    await helper.close();
    helper = undefined;

    const current = object((await input.rpc.request('get_state')).data);
    const currentSize = (await fs.promises.stat(source)).size;
    if (current.sessionId !== input.sessionId || !samePath(text(current.sessionFile), input.sessionFile) ||
        current.isSettled !== true || current.hasPendingAsyncWork !== false || currentSize > MAX_SESSION_BYTES ||
        !(await fs.promises.readFile(source)).equals(original))
      throw new Error('Oh My Pi 源会话在分叉期间发生变化，请重试');
    if (!hasArtifacts) {
      try { await fs.promises.lstat(sourceArtifacts); throw new Error('Oh My Pi 产物在分叉期间发生变化，请重试'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const snapshot of artifactSnapshot) {
      const stat = await fs.promises.lstat(snapshot.path);
      if (stat.isSymbolicLink() || (snapshot.directory ? !stat.isDirectory() : !stat.isFile()) ||
          stat.size !== snapshot.size || stat.mtimeMs !== snapshot.mtimeMs)
        throw new Error('Oh My Pi 产物在分叉期间发生变化，请重试');
    }
    if ((await fs.promises.stat(childFile)).size > MAX_SESSION_BYTES) throw new Error('Oh My Pi 分叉文件过大，无法安全发布');
    const body = replaceHeader(await fs.promises.readFile(childFile), token, header => {
      if (!samePath(text(header.parentSession), sourceCopy)) throw new Error('Oh My Pi 分叉文件与隔离源会话不匹配');
      return { ...header, parentSession: source };
    });
    const destination = path.join(path.dirname(source), path.basename(childFile));
    const destinationArtifacts = destination.slice(0, -'.jsonl'.length);
    const stagedFile = path.join(path.dirname(source), `.muster-omp-fork-${randomUUID()}.tmp`);
    let createdArtifacts = false;
    let createdFile = false;
    let createdStage = false;
    try {
      // Reserve the child's artifact namespace even if the source has none,
      // so an unrelated pre-existing directory cannot be adopted by the fork.
      await fs.promises.mkdir(destinationArtifacts, { mode: 0o700 });
      createdArtifacts = true;
      if (hasArtifacts) {
        await copyArtifacts(copiedArtifacts, destinationArtifacts, { entries: 0, bytes: 0 });
      }
      const file = await fs.promises.open(stagedFile, 'wx', 0o600);
      createdStage = true;
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      // A same-directory hard link is atomic and refuses an existing target on
      // all supported platforms; never expose a partially written session file.
      try { await fs.promises.link(stagedFile, destination); }
      catch (error) { throw new Error(`Oh My Pi 无法原子发布分叉，请检查会话目录权限及文件系统是否支持硬链接：${(error as Error).message}`); }
      createdFile = true;
      await fs.promises.unlink(stagedFile);
      createdStage = false;
    } catch (error) {
      const failures: string[] = [];
      if (createdStage) {
        try { await fs.promises.unlink(stagedFile); } catch (cleanup) { failures.push((cleanup as Error).message); }
      }
      if (createdFile) {
        try { await fs.promises.unlink(destination); } catch (cleanup) { failures.push((cleanup as Error).message); }
      }
      if (createdArtifacts && samePath(path.dirname(destinationArtifacts), path.dirname(source))) {
        try { await fs.promises.rm(destinationArtifacts, { recursive: true, force: true }); }
        catch (cleanup) { failures.push((cleanup as Error).message); }
      }
      if (failures.length) throw new Error(`${(error as Error).message}；Oh My Pi 分叉产物清理失败：${failures.join('；')}`);
      throw error;
    }
    published = token;
    return { status: 'forked', token, preservesPointIds: true };
  } finally {
    if (helper) {
      try { await helper.close(); } catch (error) { cleanupError = error; }
    }
    if (!cleanupError && samePath(path.dirname(temp), os.tmpdir()) && path.basename(temp).startsWith('muster-omp-native-fork-')) {
      try { await fs.promises.rm(temp, { recursive: true, force: true }); }
      catch (error) { throw new Error(`Oh My Pi 临时文件清理失败：${(error as Error).message}${published ? `（已创建原生会话 ${published}）` : ''}`); }
    }
    if (cleanupError) throw new ConnectionCleanupError(`Oh My Pi 分叉进程回收失败：${(cleanupError as Error).message}`);
  }
}
