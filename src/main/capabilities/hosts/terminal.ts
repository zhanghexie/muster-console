import { userDataStorage } from '../../runtimeKernel/storageRootResolver';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { requestRendererOnce } from '../../ipc/rendererRequest';
import type { AppContext } from '../../context';
import { flattenForTypedInput, sleep, submitOnly, typeAndSubmit } from '../../pty/submit';
import { resolveListTarget } from '../../../shared/workbenchCommands';
import { stripAnsiForDisplay as ansiStrip } from '../../detect/stripAnsi';
import { t } from '../../../shared/i18n';
import { waitForTerminalOutput, type TerminalWaitCondition } from '../../pty/outputWait';
import {
  CAPTURE_KEEP,
  CTRL_C,
  TEXT_TAIL_CHARS,
  captureFilesToDelete,
  resolveTerminalWriteIntent,
  terminalTextTail
} from '../../../shared/terminalCapture';

const CAPTURE_TIMEOUT_MS = 8_000;

function requireTerminalSession(ctx: AppContext, sessionId: string) {
  const s = ctx.sessions.get(sessionId);
  if (!s) throw new Error(t('会话不存在: {{id}}', { id: sessionId }));
  if (s.type !== 'terminal') throw new Error(t('不是终端会话: {{id}}（type={{type}}）', { id: sessionId, type: s.type }));
  return s;
}

function resolveTerminalTarget(
  ctx: AppContext,
  args: { sessionId?: string; name?: string }
) {
  const sid = args?.sessionId?.trim();
  if (sid) return requireTerminalSession(ctx, sid);
  const name = args?.name?.trim();
  if (!name) throw new Error(t('需要 sessionId 或 name'));
  const workspaceId = ctx.resolveBubbleWorkspaceId();
  const { sessions } = ctx.sessions.listForAgent(workspaceId);
  const terminals = sessions.filter((s) => s.type === 'terminal');
  const idx = resolveListTarget(name, terminals);
  if (idx < 0) {
    const names = terminals.map((s) => s.name).filter(Boolean).join('、') || t('(无)');
    throw new Error(t('没有匹配的终端会话：{{name}}。当前区：{{names}}', { name, names }));
  }
  return requireTerminalSession(ctx, terminals[idx].id);
}

function textTailFor(ctx: AppContext, sessionId: string): string {
  return terminalTextTail(ansiStrip(ctx.pty.getBuffer(sessionId) ?? ''), TEXT_TAIL_CHARS);
}

function capturesDir(): string {
  return userDataStorage(app.getPath('userData')).resolve('app', 'terminal-captures');
}

function pruneCaptureDir(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const files = names.map((name) => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return { name, mtimeMs };
  });
  for (const name of captureFilesToDelete(files, CAPTURE_KEEP)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

function saveCapturePng(dataUrl: string, sessionId: string): string {
  const raw = dataUrl.trim();
  const comma = raw.indexOf(',');
  if (comma < 0 || !/^data:image\/png;base64$/i.test(raw.slice(0, comma))) {
    throw new Error(t('截图不是 PNG data URL'));
  }
  const dir = capturesDir();
  fs.mkdirSync(dir, { recursive: true });
  const safeId = sessionId.replace(/[^\w-]/g, '').slice(0, 8) || 'sess';
  const file = `capture-${Date.now()}-${safeId}.png`;
  const abs = path.join(dir, file);
  fs.writeFileSync(abs, Buffer.from(raw.slice(comma + 1), 'base64'));
  pruneCaptureDir(dir);
  return abs;
}

export function readCapturePreview(
  absPath: string
): { ok: true; dataUrl: string } | { ok: false; error: string } {
  const root = path.resolve(capturesDir());
  let abs: string;
  try {
    abs = path.resolve(String(absPath ?? ''));
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: t('路径不合法') };
    }
  } catch {
    return { ok: false, error: t('路径不合法') };
  }
  if (!abs.toLowerCase().endsWith('.png')) return { ok: false, error: t('不是 PNG') };
  try {
    const buf = fs.readFileSync(abs);
    return { ok: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false, error: t('截图不存在或已清理') };
  }
}

function requestRendererCapture(
  ctx: AppContext,
  sessionId: string
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  const win = ctx.getWindow();
  if (!win) return Promise.resolve({ ok: false, error: t('窗口未就绪') });
  return requestRendererOnce<{ ok: boolean; dataUrl?: string; error?: string }>(win, {
    requestChannel: 'terminal:capture-request',
    prefix: 'terminal:capture',
    payload: { sessionId },
    timeoutMs: CAPTURE_TIMEOUT_MS,
    onTimeout: () => ({ ok: false, error: t('截图超时') }),
    map: (raw) => {
      const payload = raw as { ok?: boolean; dataUrl?: string; error?: string };
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: t('应答无效') };
      }
      return {
        ok: !!payload.ok && typeof payload.dataUrl === 'string',
        dataUrl: payload.dataUrl,
        error: payload.error
      };
    }
  });
}

export const terminalHost = {

  'terminal.write': async (
    ctx: AppContext,
    args: {
      sessionId?: string;
      name?: string;
      text?: string;
      submit?: boolean;
      mode?: string;
      key?: string;
      enterCount?: number;
    },
    options?: { signal?: AbortSignal; onFirstSubmit?: () => void }
  ) => {
    options?.signal?.throwIfAborted();
    const s = resolveTerminalTarget(ctx, args);
    const outputCursor = ctx.pty.getOutputCursor(s.id);
    const intent = resolveTerminalWriteIntent(args);
    const raw = args.text ?? '';
    const onlyEnter = !raw.replace(/[\r\n]/g, '').length;
    const shouldSubmit = intent.submit || intent.keyKind === 'enter';
    if (!intent.keyKind && onlyEnter && !shouldSubmit) {
      throw new Error(t('需要 text、key 或 submit'));
    }

    if (intent.keyKind === 'ctrl-c') {
      if (!ctx.pty.write(s.id, CTRL_C)) {
        throw new Error(t('终端进程未在运行，可先 sessions.select 拉起'));
      }
      await sleep(60);
      if (onlyEnter && !shouldSubmit) {
        return {
          written: true,
          sessionId: s.id,
          outputCursor,
          name: s.name,
          chars: 1,
          mode: 'key' as const,
          key: 'ctrl-c'
        };
      }
    }

    const pressEnters = async (): Promise<number> => {
      for (let i = 0; i < intent.enterCount; i++) {
        await submitOnly(ctx.pty, s.id);
        if (i < intent.enterCount - 1) await sleep(60);
      }
      return intent.enterCount;
    };

    if (onlyEnter && shouldSubmit) {
      const submits = await pressEnters();
      return {
        written: true,
        sessionId: s.id,
        outputCursor,
        name: s.name,
        chars: submits,
        mode: 'submit-only' as const,
        submits
      };
    }

    if (intent.typed) {
      if (shouldSubmit) {
        const generation = options && ctx.pty.desktopProcessGeneration(s.id);
        const writer = options ? ctx.pty.captureWriter(s.id) : ctx.pty;
        const r = await typeAndSubmit(writer, s.id, raw, { enterCount: intent.enterCount,
          generation, signal: options?.signal, onFirstSubmit: options?.onFirstSubmit });
        return {
          written: true,
          sessionId: s.id,
          outputCursor,
          name: s.name,
          chars: r.typed + r.submits,
          mode: 'typed' as const,
          typed: r.typed,
          submits: r.submits
        };
      }
      const flat = flattenForTypedInput(raw);
      if (!flat) throw new Error(t('写入内容为空'));
      if (!ctx.pty.write(s.id, flat)) {
        throw new Error(t('终端进程未在运行，可先 sessions.select 拉起'));
      }
      return {
        written: true,
        sessionId: s.id,
        outputCursor,
        name: s.name,
        chars: flat.length,
        mode: 'typed-write' as const
      };
    }

    if (shouldSubmit) {
      const text = raw.replace(/\r+$/g, '');
      if (text) {
        if (!ctx.pty.write(s.id, text)) {
          throw new Error(t('终端进程未在运行，可先 sessions.select 拉起'));
        }
        await sleep(80);
      }
      const submits = await pressEnters();
      return {
        written: true,
        sessionId: s.id,
        outputCursor,
        name: s.name,
        chars: text.length + submits,
        mode: 'write-submit' as const,
        submits
      };
    }

    const ok = ctx.pty.write(s.id, raw);
    if (!ok) throw new Error(t('终端进程未在运行，可先 sessions.select 拉起'));
    return { written: true, sessionId: s.id, outputCursor, name: s.name, chars: raw.length, mode: 'write' as const };
  },

  'terminal.capture': async (ctx: AppContext, args: {
    sessionId?: string; name?: string;
    waitFor?: TerminalWaitCondition; after?: string;
  }, options?: { signal?: AbortSignal }) => {
    if (args && ('delivery' in args || 'caption' in args)) throw new Error('Terminal capture is local; remove delivery and caption');
    const s = resolveTerminalTarget(ctx, args);
    if (args.after !== undefined && !args.waitFor) throw new Error('after 需要与 waitFor 一起使用');
    const wait = args.waitFor ? await waitForTerminalOutput(ctx.pty, s.id, args.waitFor, { after: args.after, signal: options?.signal }) : undefined;
    options?.signal?.throwIfAborted();
    const outputCursor = ctx.pty.getOutputCursor(s.id);
    const textTail = textTailFor(ctx, s.id);
    let dataUrl: string | undefined;
    let captureError: string | undefined;
    try {
      const shot = await requestRendererCapture(ctx, s.id);
      if (shot.ok && shot.dataUrl) dataUrl = shot.dataUrl;
      else captureError = shot.error || t('截图失败');
    } catch (e) {
      captureError = e instanceof Error ? e.message : String(e);
    }
    options?.signal?.throwIfAborted();

    let previewPath: string | undefined;
    if (dataUrl) {
      try {
        previewPath = saveCapturePng(dataUrl, s.id);
      } catch (e) {
        captureError = e instanceof Error ? e.message : String(e);
      }
    }

    if (!previewPath && !textTail) {
      throw new Error(captureError || t('截图失败且缓冲区为空'));
    }
    return {
      ok: true,
      sessionId: s.id,
      outputCursor,
      name: s.name,
      textTail,
      imageCaptured: !!previewPath,
      ...(wait ? { wait } : {}),
      ...(previewPath ? { previewPath } : {}),
      ...(captureError ? { captureError } : {})
    };
  }
};
