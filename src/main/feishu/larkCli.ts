import type { ChildProcess } from 'node:child_process';
import { createControlledChild } from '../agentSession/process/controlledChild';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { boundedAcpRequest } from '../agentSession/processReclamation';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { claimFeishuConsumer } from './consumerArbiter';
/**
 * 飞书官方 lark-cli（@larksuite/cli，Go 二进制）的子进程封装。
 * 凭证由 lark-cli 自行保管（OS 密钥链）；本封装只负责：
 *  - 扫码接入（config init --new 输出授权链接，等用户在飞书完成）
 *  - 事件流（event consume im.message.receive_v1 → stdout NDJSON）
 *  - 执行指定手机连接 profile 的 CLI 命令并确认子进程关闭
 *  - 生成二维码（auth qrcode）
 */

const MISSING_PROFILE = '飞书连接缺少有效的 CLI profile，请在 Channels 中重新接入飞书。';

/**
 * asar 内不能 spawn 原生 exe；electron-builder asarUnpack 后实体在 app.asar.unpacked。
 * （与 workspaceRg.resolveRgPath 同一套路；fs.existsSync 对 asar 虚路径可能仍为 true。）
 */
function toSpawnablePath(p: string): string {
  return p.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked');
}

/** 定位 lark-cli 可执行文件（依赖装在工作台 node_modules；找不到返回 null） */
export function resolveCliExe(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates: string[] = [];
  try {
    const req = createRequire(path.join(app.getAppPath(), 'package.json'));
    const pkgPath = req.resolve('@larksuite/cli/package.json');
    candidates.push(path.join(path.dirname(pkgPath), 'bin', `lark-cli${ext}`));
  } catch {
    /* 未安装 */
  }
  candidates.push(
    path.join(app.getAppPath(), 'node_modules', '@larksuite', 'cli', 'bin', `lark-cli${ext}`)
  );
  for (const c of candidates) {
    const spawnable = toSpawnablePath(c);
    try {
      if (fs.existsSync(spawnable)) return spawnable;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** lark-cli 在 OpenClaw 等宿主环境变量下会拒绝 config init；统一清掉 */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCLAW_HOME;
  delete env.HERMES_HOME;
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return env;
}

function validProfile(profile: unknown): profile is string {
  return typeof profile === 'string' && profile.length > 0 && profile.trim() === profile &&
    !profile.startsWith('-') && !/[\x00-\x1f\x7f]/u.test(profile);
}

function baseArgs(args: string[], profile: string): string[] {
  return ['--profile', profile, ...args];
}

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * lark-cli 错误摘要：优先解析 JSON 信封里的 error.message（lark-cli 输出是多行 pretty JSON，
 * 只截末尾两行会把真实错误吃掉），解析失败才退回原始输出尾部。
 */
export function cliErrorDetail(res: CliRunResult): string {
  for (const src of [res.stderr, res.stdout]) {
    if (!src.trim()) continue;
    // Event commands prefix the pretty JSON envelope with diagnostic lines.
    const candidates = [src, ...[...src.matchAll(/^\s*\{/gm)].map(match => src.slice(match.index))];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as {
          ok?: boolean;
          error?: { message?: string; code?: number; msg?: string } | string;
          msg?: string;
        };
        if (parsed && parsed.ok === false) {
          const e = parsed.error;
          const msg = typeof e === 'string' ? e : (e?.message ?? e?.msg ?? parsed.msg);
          if (msg) return e && typeof e !== 'string' && e.code !== undefined ? `code ${e.code}：${msg}` : msg;
        }
      } catch {
        /* 不是完整 JSON，走尾部截取 */
      }
    }
  }
  return (res.stderr || res.stdout)
    .trim()
    .split(/\r?\n/)
    .slice(-3)
    .join(' ')
    .slice(0, 300);
}

/** 跑一次性命令（收齐输出后退出） */
export function runCli(
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number; profile?: string } = {}
): Promise<CliRunResult> {
  const profile = opts.profile;
  const qrCode = args[0] === 'auth' && args[1] === 'qrcode';
  if (profile === undefined ? !qrCode : !validProfile(profile)) {
    return Promise.resolve({ code: -1, stdout: '', stderr: JSON.stringify({ ok: false, error: { message: MISSING_PROFILE } }) });
  }
  const exe = resolveCliExe();
  if (!exe) return Promise.resolve({ code: -1, stdout: '', stderr: 'lark-cli 未安装' });
  return new Promise((resolve) => {
    const child = createControlledChild(exe, profile === undefined ? args : baseArgs(args, profile), {
      cwd: opts.cwd,
      env: cliEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }).child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    // 统一完成入口：无论哪路事件先到（stdin error/child error/close/timeout），
    // 都清理 timer 并终止自有 child + 释放 stdin——stdin 断裂时 CLI 往往还活着，
    // 只 clearTimeout 不 kill 会留下残留进程（丢失最后的超时兜底）；对已退出的
    // child，kill/destroy 均为幂等 no-op。
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(-2);
    }, opts.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (e) => {
      stderr += String(e);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    // stdin 的流错误与 child 的 error 是两路事件（R3，审计 2026-10-02）：CLI 提前
    // 关闭输入管道时 Writable 自己发 error，child 监听接不住——必须在写入前挂监听，
    // 收口为一次 CLI 失败（finish 幂等），不让 EventEmitter 异常逃逸到全局。
    // 错误信息只含流错误本身（EPIPE 等），不含写入的凭证内容。
    child.stdin.on('error', (e) => {
      stderr += `stdin: ${String(e)}`;
      finish(-1);
    });
    try {
      if (opts.input != null) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    } catch (e) {
      // 同步 write/end 异常（如写入已销毁的流）：同样收口为失败，不截断 Promise
      stderr += `stdin write: ${String(e)}`;
      finish(-1);
    }
  });
}

const AUTH_URL_RE = /https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/page\/cli\?\S+/;

export interface OnboardingHandle {
  /** 用户完成扫码配置后 resolve（exit 0） */
  promise: Promise<{ ok: boolean; error?: string }>;
  cancel(): void;
  stopAndWait(): Promise<void>;
}

/**
 * 扫码接入：后台跑 `config init --new`，从输出提取授权链接（同时终端里会有二维码，
 * 我们拿到 URL 后自己渲染二维码）。用户在飞书完成应用创建后命令自动退出。
 */
export function startConfigInitNew(onUrl: (url: string) => void, profile: string): OnboardingHandle {
  const error = validProfile(profile) ? undefined : MISSING_PROFILE;
  const exe = error ? null : resolveCliExe();
  if (!exe) {
    return {
      promise: Promise.resolve({ ok: false, error: error ?? 'lark-cli 未安装（依赖 @larksuite/cli）' }),
      cancel: () => {}, stopAndWait: async () => {}
    };
  }
  const owner = createControlledChild(
    exe,
    baseArgs(['config', 'init', '--new', '--brand', 'feishu', '--lang', 'zh', '--name', profile], profile),
    { env: cliEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const child = owner.child;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let out = '';
  let err = '';
  let urlSent = false;
  const tryUrl = (): void => {
    if (urlSent) return;
    // 二维码与授权链接在 stderr（实测 stdout 为空）；对累计缓冲匹配防跨 chunk 截断
    const m = AUTH_URL_RE.exec(`${out}\n${err}`);
    if (m) {
      urlSent = true;
      onUrl(m[0]);
    }
  };
  const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      out += d;
      tryUrl();
    });
    child.stderr.on('data', (d: string) => {
      err += d;
      tryUrl();
    });
    child.on('error', (e) => resolve({ ok: false, error: `启动 lark-cli 失败：${String(e)}` }));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        const tail = (err || out).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
        resolve({ ok: false, error: `接入未完成（exit ${code}）${tail ? `：${tail}` : ''}` });
      }
    });
  });
  return {
    promise,
    stopAndWait: async () => {
      await owner.reclaim();
      await boundedAcpRequest(closed, 7000, 'Feishu onboarding process close');
    },
    cancel: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  };
}

/** 用 lark-cli 生成二维码 PNG → dataURL（失败返回 undefined，调用方降级为纯链接） */
export async function makeQrDataUrl(content: string): Promise<string | undefined> {
  const dir = userDataStorage(app.getPath('userData')).resolve('app', 'feishu-qr');
  const file = path.join(dir, `qr-${randomUUID().slice(0, 8)}.png`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const res = await runCli(['auth', 'qrcode', content, '-o', path.basename(file), '--size', '320'], {
      cwd: dir,
      timeoutMs: 30_000
    });
    if (res.code !== 0) return undefined;
    const buf = fs.readFileSync(file);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface EventStreamHandle {
  stop(): void;
  stopAndWait(): Promise<void>;
}

/**
 * 事件流：长驻 `event consume <eventKey>` 子进程，stdout 按 NDJSON 逐行回调。
 * 退出（异常/被杀）由 onExit 上报，重连策略由调用方决定。
 * 身份必须显式 bot：auto-detect 在 1.0.89 起会解析成 user 并 exit 2（invalid_argument）。
 */
export function startEventConsume(
  eventKey: string,
  onLine: (line: string) => void,
  onExit: (code: number, stderrTail: string) => void,
  onStderr: ((line: string) => void) | undefined,
  asBot: boolean,
  profile: string,
  exclusive = false
): EventStreamHandle {
  if (!validProfile(profile)) {
    onExit(-1, MISSING_PROFILE);
    return { stop: () => {}, stopAndWait: async () => {} };
  }
  if (exclusive && asBot) return startExclusiveEventConsume(eventKey, onLine, onExit, onStderr, profile);
  const exe = resolveCliExe();
  if (!exe) {
    onExit(-1, 'lark-cli 未安装');
    return { stop: () => {}, stopAndWait: async () => {} };
  }
  const owner = createControlledChild(
    exe,
    baseArgs([
      'event',
      'consume',
      eventKey,
      ...(asBot ? ['--as', 'bot'] : [])
    ], profile),
    // stdin 必须保持打开：lark-cli 把 stdin EOF 当作消费端的优雅退出信号，
    // stdio ignore 会让进程启动即退出（exit 5 context canceled）
    { env: cliEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const child: ChildProcess = owner.child;
  let stdoutBuf = '';
  let stderrBuf = '';
  let stderrTail = '';
  let stopped = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopPending: Promise<void> | undefined;
  const closed = new Promise<void>(resolve => child.once('close', () => {
    if (forceTimer) clearTimeout(forceTimer);
    resolve();
  }));
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (d: string) => {
    stdoutBuf += d;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  child.stderr?.on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-16000);
    stderrBuf += d;
    let nl: number;
    while ((nl = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, nl).trim();
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line && onStderr) onStderr(line);
    }
  });
  // stdin 流错误单独监听（与 child error 两路）：CLI 崩溃/退出时管道断裂的 error
  // 不落地到全局；退出上报仍由 close 统一触发，这里只防止 uncaught
  child.stdin?.on('error', (e) => {
    stderrTail += `stdin: ${String(e)}`;
  });
  child.on('error', (e) => {
    stderrTail += String(e);
  });
  child.on('close', (code) => {
    // agent-apps F-03：残余 stderrBuf 按 \n 拆行逐行回调（与流式路径同粒度），
    // 不再整块交付——行级语义（如手机端 onReady 的 startsWith('[event] ready ')
    // 匹配）不被 close 尾冲里混排的其他行吞掉
    if (!stopped && onStderr && stderrBuf.trim()) {
      for (const line of stderrBuf.split('\n')) {
        const text = line.trim();
        if (text) onStderr(text);
      }
    }
    if (!stopped) onExit(code ?? -1, cliErrorDetail({ code: code ?? -1, stdout: '', stderr: stderrTail }));
  });
  const stopAndWait = (): Promise<void> => {
    if (stopPending) return stopPending;
      stopped = true;
      // 官方退出路径：先关 stdin（优雅退出并清理服务端订阅），3s 后兜底 kill
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
      // 事件总线是常驻 daemon；完成必须包含对应 profile 的停止回执。
      stopPending = (async () => {
        const streamClosed = (async () => {
          if (owner.started) await Promise.race([closed, new Promise<void>(resolve => { forceTimer = setTimeout(resolve, 3000); forceTimer.unref?.(); })]);
          if (forceTimer) clearTimeout(forceTimer);
          await owner.reclaim();
          await closed;
        })();
        const results = await Promise.allSettled([streamClosed, runCli(['event', 'stop'], { timeoutMs: 10_000, profile }).then(result => {
          if (result.code !== 0) throw new Error(`lark-cli event stop failed (${result.code}): ${result.stderr.slice(-500)}`);
        })]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Feishu event stream shutdown failed');
      })();
      void stopPending.catch(() => { stopPending = undefined; });
      return stopPending;
  };
  return { stop: () => { void stopAndWait().catch(error => console.error('[feishu] event stream shutdown failed', error)); }, stopAndWait };
}

function startExclusiveEventConsume(eventKey: string, onLine: (line: string) => void,
  onExit: (code: number, stderrTail: string) => void, onStderr: ((line: string) => void) | undefined,
  profile: string): EventStreamHandle {
  let stopping = false;
  let stream: EventStreamHandle | undefined;
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const startup = (async () => {
    const result = await runCli(['auth', 'status', '--json'], { profile, timeoutMs: 5000 });
    if (stopping) return;
    let application: { appId?: string; identities?: { bot?: { available?: boolean } } };
    try { application = JSON.parse(result.stdout || result.stderr); }
    catch { throw new Error('无法确认飞书应用身份，请检查已连接的应用。'); }
    if (result.code !== 0 || typeof application?.appId !== 'string' || application.identities?.bot?.available !== true) {
      throw new Error('无法确认飞书应用身份，请检查已连接的应用。');
    }
    release = claimFeishuConsumer(application.appId, `lark-cli:${profile}`, eventKey);
    try {
      stream = startEventConsume(eventKey, onLine, (code, tail) => {
        const cleanup = stopAndWait();
        onExit(code, tail);
        void cleanup.catch(() => console.error('[feishu] exclusive profile daemon closure not confirmed'));
      }, onStderr, true, profile);
    } catch (error) { release(); release = undefined; throw error; }
  })().catch(error => {
    const code = (error as { code?: string })?.code;
    const reason = error instanceof Error && (code === 'feishu-account-in-use' || code === 'feishu-account-unverified')
      ? error.message : '无法确认飞书应用身份，请检查已连接的应用。';
    if (!stopping) onExit(-1, reason);
  });
  const stopAndWait = (): Promise<void> => {
    if (pending) return pending;
    stopping = true;
    pending = (async () => {
      await startup;
      await stream?.stopAndWait();
      release?.();
      release = undefined;
    })();
    void pending.catch(() => { pending = undefined; });
    return pending;
  };
  return { stop: () => { void stopAndWait().catch(() => console.error('[feishu] exclusive profile daemon closure not confirmed')); }, stopAndWait };
}
