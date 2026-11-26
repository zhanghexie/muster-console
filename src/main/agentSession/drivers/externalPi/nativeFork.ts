import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GuiNativeForkPoint } from '../../types';
import { ConnectionCleanupError } from '../../host/retirement';
import { boundedAcpRequest } from '../acp/models';
import { externalPiLaunchArgs, externalPiLaunchEnvironment } from './executable';
import { ExternalPiRpc } from './rpc';

type Frame = Record<string, unknown>;
const object = (value: unknown): Frame => value && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

/** Runs only in an isolated Pi process on a copy of the source session. */
function extensionSource(command: string, point: GuiNativeForkPoint, nonce: string): string {
  const config = JSON.stringify({ command, entryId: point.entryId, role: point.role, nonce });
  return `const config = ${config};
export default function (api) {
  api.registerCommand(config.command, {
    description: 'Create an exact session branch',
    async handler(_args, ctx) {
      const send = (current, value) => current.ui.setStatus('muster-pi-fork-result', JSON.stringify({ nonce: config.nonce, ...value }));
      try {
        if (typeof ctx.fork !== 'function') { send(ctx, { status: 'unsupported' }); return; }
        const sourceBranch = ctx.sessionManager.getBranch();
        const sourceIndex = sourceBranch.findIndex(entry => entry.id === config.entryId);
        const source = sourceBranch[sourceIndex];
        if (!source || source.type !== 'message' || source.message?.role !== config.role) {
          send(ctx, { status: 'error', error: '指定消息不在当前原生会话分支中' }); return;
        }
        const expectedMessages = sourceBranch.slice(0, sourceIndex + 1).filter(entry => entry.type === 'message')
          .map(entry => [entry.id, entry.message?.role]);
        let reported = false;
        const result = await ctx.fork(config.entryId, { position: 'at', withSession: async child => {
          const messages = child.sessionManager.getBranch().filter(entry => entry.type === 'message');
          const last = messages[messages.length - 1];
          reported = true;
          if (!last || last.id !== config.entryId || last.message?.role !== config.role ||
              messages.length !== expectedMessages.length || messages.some((entry, index) =>
                entry.id !== expectedMessages[index][0] || entry.message?.role !== expectedMessages[index][1])) {
            send(child, { status: 'unsupported' }); return;
          }
          send(child, { status: 'forked', sessionId: child.sessionManager.getSessionId(), sessionFile: child.sessionManager.getSessionFile() });
        } });
        if (!reported) send(ctx, { status: result?.cancelled ? 'error' : 'unsupported', error: result?.cancelled ? '原生分叉被取消' : '' });
      } catch (error) { send(ctx, { status: 'error', error: String(error?.message || error) }); }
    }
  });
}`;
}

/**
 * Pi's command context switches sessions, so never invoke it on the live source.
 * The helper opens a private copy, validates its inclusive fork, then publishes
 * the newly-created native file next to the source with its parent corrected.
 */
export async function forkExternalPi(input: {
  executable: string; cwd: string; sourceFile: string; point: GuiNativeForkPoint; log(message: string): void;
}): Promise<{ status: 'forked'; token: string; preservesPointIds: true } | { status: 'unsupported' }> {
  const source = input.sourceFile;
  if (!path.isAbsolute(source) || !fs.lstatSync(source).isFile()) return { status: 'unsupported' };
  if (fs.statSync(source).size > MAX_SESSION_BYTES) throw new Error('外部 Pi 会话过大，无法安全创建原生分叉');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-pi-native-fork-'));
  const sourceCopy = path.join(temp, 'source.jsonl');
  const extension = path.join(temp, 'fork.mjs');
  const nonce = randomUUID();
  const command = `muster-fork-${nonce.replace(/-/g, '')}`;
  let rpc: ExternalPiRpc | undefined;
  let cleanupError: unknown;
  let published = '';
  let settle!: (value: Frame) => void;
  const outcome = new Promise<Frame>(resolve => { settle = resolve; });
  try {
    fs.copyFileSync(source, sourceCopy, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(extension, extensionSource(command, input.point, nonce), { mode: 0o600 });
    const args = ['--mode', 'rpc', '--session', sourceCopy, '--session-dir', temp,
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--extension', extension];
    rpc = new ExternalPiRpc({ ...externalPiLaunchArgs(input.executable, args), cwd: input.cwd,
      env: { ...externalPiLaunchEnvironment(input.executable), PI_OFFLINE: '1' },
      onFrame(frame) {
        if (frame.type === 'extension_ui_request' && frame.method === 'setStatus' && frame.statusKey === 'muster-pi-fork-result') {
          try {
            const result = object(JSON.parse(text(frame.statusText)));
            if (result.nonce === nonce) settle(result);
          } catch { settle({ status: 'error', error: '外部 Pi 分叉结果格式无效' }); }
        } else if (frame.type === 'extension_error') {
          settle({ status: 'error', error: text(frame.error) || '外部 Pi 分叉扩展失败' });
        } else if (frame.type === 'agent_start') {
          settle({ status: 'error', error: '外部 Pi 未将分叉命令作为扩展处理' });
        }
      },
      onFailure(error) { settle({ status: 'error', error: error.message }); },
      log(message) { input.log(message); }
    });
    await boundedAcpRequest(rpc.waitReady(), 30_000, '外部 Pi 分叉进程启动');
    const state = object((await rpc.request('get_state')).data);
    if (text(state.sessionId) !== input.point.sessionToken || !samePath(text(state.sessionFile), sourceCopy))
      throw new Error('外部 Pi 未能在隔离副本中恢复源会话');
    let commands: unknown;
    try { commands = object((await rpc.request('get_commands')).data).commands; }
    catch (error) {
      if (/unknown (?:rpc )?command|unsupported|not supported/i.test((error as Error).message)) {
        input.log('当前 Pi 版本没有可确认的扩展命令目录，使用原有分叉方式');
        return { status: 'unsupported' };
      }
      throw error;
    }
    if (!Array.isArray(commands) || !commands.some(item => object(item).name === command && object(item).source === 'extension'))
      return { status: 'unsupported' };
    const accepted = object((await rpc.request('prompt', { message: `/${command}` })).data);
    if (accepted.disposition === undefined) {
      // Older Pi versions do not acknowledge extension command handling. All
      // work is still confined to the temporary copy; do not publish a child.
      input.log('当前 Pi 版本没有扩展命令处理回执，使用原有分叉方式');
      return { status: 'unsupported' };
    }
    if (accepted.disposition !== 'handled') throw new Error('外部 Pi 未确认分叉命令由扩展处理');
    const result = await boundedAcpRequest(outcome, 30_000, '外部 Pi 分叉结果');
    if (result.status === 'unsupported') return { status: 'unsupported' };
    if (result.status !== 'forked') throw new Error(rpc.sanitize(text(result.error)) || '外部 Pi 原生分叉失败');
    const token = text(result.sessionId), childFile = text(result.sessionFile);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(token) || token === input.point.sessionToken ||
        !path.isAbsolute(childFile) || !samePath(path.dirname(childFile), temp) ||
        !path.basename(childFile).endsWith(`_${token}.jsonl`) || !fs.lstatSync(childFile).isFile())
      throw new Error('外部 Pi 返回的分叉文件身份无效');
    const childState = object((await rpc.request('get_state')).data);
    if (childState.sessionId !== token || !samePath(text(childState.sessionFile), childFile))
      throw new Error('外部 Pi 未确认新分支身份');

    // Stop the helper before publishing, so it cannot write the new file while
    // its generated header is being adjusted to reference the actual source.
    await rpc.close();
    rpc = undefined;
    if (fs.statSync(childFile).size > MAX_SESSION_BYTES) throw new Error('外部 Pi 分叉文件过大，无法安全发布');
    const contents = fs.readFileSync(childFile);
    const newline = contents.indexOf(10);
    if (newline < 0 || newline > 64 * 1024) throw new Error('外部 Pi 分叉文件头格式无效');
    const header = object(JSON.parse(contents.subarray(0, newline).toString('utf8')));
    if (header.type !== 'session' || header.id !== token || !samePath(text(header.parentSession), sourceCopy))
      throw new Error('外部 Pi 分叉文件与隔离源会话不匹配');
    const destination = path.join(path.dirname(source), path.basename(childFile));
    const body = Buffer.concat([Buffer.from(`${JSON.stringify({ ...header, parentSession: source })}\n`), contents.subarray(newline + 1)]);
    let fd: number | undefined;
    try { fd = fs.openSync(destination, 'wx', 0o600); fs.writeFileSync(fd, body); fs.closeSync(fd); fd = undefined; }
    catch (error) {
      // Remove only a file whose exclusive creation succeeded in this call.
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* preserve original error */ }
        try { fs.unlinkSync(destination); } catch { /* preserve original error */ }
      }
      throw error;
    }
    published = token;
    return { status: 'forked', token, preservesPointIds: true };
  } finally {
    if (rpc) {
      try { await rpc.close(); } catch (error) { cleanupError = error; }
    }
    if (!cleanupError && samePath(path.dirname(temp), os.tmpdir()) && path.basename(temp).startsWith('muster-pi-native-fork-')) {
      try { fs.rmSync(temp, { recursive: true, force: true }); }
      catch (error) { throw new Error(`外部 Pi 临时文件清理失败：${(error as Error).message}${published ? `（已创建原生会话 ${published}）` : ''}`); }
    }
    if (cleanupError) throw new ConnectionCleanupError(`外部 Pi 分叉进程回收失败：${(cleanupError as Error).message}`);
  }
}
