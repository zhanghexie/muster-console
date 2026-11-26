import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type OwnedPids = { nonce: string; shell: number; root: number; child?: number };
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const readJson = <T,>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
};
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const quote = (value: string, powershell: boolean): string => powershell
  ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;

/** Real terminal input and cooked Ctrl+C; every process belongs to this fixture. */
test('普通交互PTY输入、resize、Ctrl+C与正常退出回收进程树', async ({}, info) => {
  test.setTimeout(120_000);
  const project = path.resolve(__dirname, '../..');
  const root = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  const nonce = randomUUID();
  const stopFile = path.join(root, 'owned-stop');
  const script = path.join(root, 'owned-terminal.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const base=${JSON.stringify(root)}, nonce=${JSON.stringify(nonce)}, mode=process.argv[2];
const stop=${JSON.stringify(stopFile)};
let child;
if(mode==='hold') child=spawn(process.execPath,['-e',
  "const fs=require('node:fs');const [stop,file,nonce]=process.argv.slice(1);setInterval(()=>{if(fs.existsSync(stop))process.exit(0);fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce}));},100)",
  stop,path.join(base,'child-heartbeat.json'),nonce],{stdio:'ignore'});
const ready=()=>{fs.writeFileSync(path.join(base,mode+'-pids.json'),JSON.stringify({nonce,shell:process.ppid,root:process.pid,child:child?.pid}));process.stdout.write('PTY_REAL_READY_'+mode+'\\n');};
if(child) child.once('spawn',ready);else ready();
// Windows emits SIGWINCH for a reading raw TTY; keep ctrl mode cooked.
if(mode==='hold' && process.stdin.isTTY) process.stdin.setRawMode(true);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{input+=data;if(/[\\r\\n]/.test(input))fs.writeFileSync(path.join(base,'input-ack.json'),JSON.stringify({nonce,input:input.trim()}));});
let lastSize='';const recordSize=()=>{const size={cols:process.stdout.columns,rows:process.stdout.rows};const current=JSON.stringify(size);if(current!==lastSize){lastSize=current;fs.appendFileSync(path.join(base,mode+'-sizes.ndjson'),current+'\\n');}};
process.stdout.on('resize',recordSize);recordSize();setInterval(()=>{if(fs.existsSync(stop))process.exit(0);},100);
`);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'pty-lifecycle', workspaces: [{ id: 'pty-lifecycle', name: 'PTY lifecycle', path: root }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `interactive-pty-${nonce}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  const launcher = app.process();
  let stdout = '', stderr = '';
  launcher.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-262144); });
  launcher.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-262144); });
  const diagnostics: Array<Record<string, unknown>> = [];
  const commands: string[] = [];
  let captureDiagnostic: (label: string) => Promise<void> = async () => {};
  const launcherClosed = new Promise<void>(resolve => {
    if (launcher.exitCode !== null || launcher.signalCode !== null) resolve(); else launcher.once('close', () => resolve());
  });
  let closeAttempted = false;
  let normalClosed = false;
  let ctrl: OwnedPids | undefined, held: OwnedPids | undefined;
  const closeNormally = async (): Promise<void> => {
    closeAttempted = true;
    // app.close invokes app.quit and must traverse production before-quit.
    // A timeout fails the test; it is never counted as a successful close.
    await bounded(Promise.all([app.close(), launcherClosed]), 20_000, 'Normal Electron close did not release the fixture launcher');
    normalClosed = true;
  };
  try {
    const page = await app.firstWindow();
    let selectedSessionId: string | undefined;
    captureDiagnostic = async label => {
      try {
        const state = await bounded(page.evaluate(async id => ({ sessions: await window.api.sessions.list(), buffer: id ? await window.api.pty.getBuffer(id) : null, notifications: await window.api.notify.list('pty-lifecycle') }), selectedSessionId),
          3000, 'PTY diagnostic IPC exceeded 3s');
        diagnostics.push({ label, at: Date.now(), state });
      } catch (error) { diagnostics.push({ label, error: String(error) }); }
      fs.writeFileSync(path.join(info.outputDir, 'pty-lifecycle-diagnostics.json'), JSON.stringify({ commands, diagnostics, stdout, stderr }, null, 2));
    };
    await page.locator('.app-shell').waitFor({ timeout: 45_000 });
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') diagnostics.push({label:'renderer-console',type:message.type(),text:message.text()}); });
    page.on('pageerror', error => { diagnostics.push({label:'renderer-pageerror',error:String(error)}); });
    await page.exposeFunction('__savePtyLifecycleEvent', (record: unknown) => {
      diagnostics.push({label:'live-event',at:Date.now(),record});
      if(diagnostics.length>500)diagnostics.splice(0,diagnostics.length-500);
      fs.writeFileSync(path.join(info.outputDir, 'pty-lifecycle-diagnostics.json'), JSON.stringify({ commands, diagnostics, stdout, stderr }, null, 2));
    });
    // Subscribe before sessions.create: a failed bootstrap may remove the
    // session and its buffer before the polling assertion observes its exit.
    await page.evaluate(() => {
      const save = (record: unknown): void => { void (window as unknown as {__savePtyLifecycleEvent(record:unknown):Promise<void>}).__savePtyLifecycleEvent(record).catch(()=>{}); };
      window.api.on('pty:data', event => save({type:'pty:data',event}));
      window.api.on('pty:exit', event => save({type:'pty:exit',event}));
      window.api.on('sessions:changed', event => save({type:'sessions:changed',event}));
    });
    const profiles = await page.evaluate(() => window.api.shell.listProfiles());
    const preferred = process.platform === 'win32' ? ['powershell', 'pwsh'] : process.platform === 'darwin' ? ['zsh', 'bash'] : ['bash', 'zsh'];
    const profile = preferred.map(id => profiles.find(candidate => candidate.id === id)).find(Boolean);
    expect(profile, `No supported local interactive shell; platform=${process.platform}, available=${profiles.map(row => row.id).join(',')}`).toBeTruthy();
    const powershell = profile!.id === 'powershell' || profile!.id === 'pwsh';
    diagnostics.push({label:'shell-profile',profile,profiles});
    const session = await page.evaluate(async ({ cwd, shellProfileId }) => window.api.sessions.create({
      name: 'PTY lifecycle fixture', shellProfileId, cwd, workspaceId: 'pty-lifecycle'
    }), { cwd: root, shellProfileId: profile!.id });
    expect(typeof session?.id, JSON.stringify(session)).toBe('string');
    selectedSessionId = session.id;
    diagnostics.push({label:'session-create',session});
    await page.locator('.session-item').filter({ hasText: 'PTY lifecycle fixture' }).click();
    const terminal = page.locator('.terminal-wrap.is-shown');
    await terminal.locator('.xterm-helper-textarea').waitFor();
    await captureDiagnostic('terminal-mounted-before-input');
    const type = async (command: string): Promise<void> => {
      commands.push(command);
      await terminal.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(command); await page.keyboard.press('Enter');
    };
    const readBuffer = (): Promise<string> => page.evaluate(id => window.api.pty.getBuffer(id), session.id);
    const stripTerminal = (text: string): string => text
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const afterCheckpoint = (buffer: string, checkpoint: string): string => buffer.startsWith(checkpoint) ? buffer.slice(checkpoint.length) : '';
    const waitShellReady = async (phase: string, checkpoint = ''): Promise<void> => {
      if (powershell) {
        await expect.poll(async () => {
          if (ctrl && !alive(ctrl.shell)) throw new Error('Interactive shell exited before its next prompt');
          const fresh = stripTerminal(afterCheckpoint(await readBuffer(), checkpoint));
          return /(?:^|[\r\n])[^\r\n]*> $/.test(fresh);
        }, { timeout: 15_000, message: `${phase}: waiting for an actual new PowerShell prompt` }).toBe(true);
        return;
      }
      // bash/zsh startup files may define any PS1. A split printf marker is
      // absent from the echoed command and proves actual shell acceptance.
      // Retrying this readiness probe only prints; it has no persistent effect.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (ctrl && !alive(ctrl.shell)) throw new Error('Interactive shell exited before its readiness receipt');
        const before = await readBuffer();
        const suffix = `${nonce}_${phase}_${attempt}`;
        const marker = `PTY_SHELL_READY_${suffix}`;
        await type(`printf '%s%s\\n' 'PTY_SHELL_READY_' '${suffix}'`);
        const deadline = Date.now() + 1800;
        while (Date.now() < deadline) {
          const output = await readBuffer();
          if (afterCheckpoint(output, checkpoint).length && stripTerminal(afterCheckpoint(output, before)).includes(marker)) return;
          await pause(100);
        }
      }
      throw new Error(`${phase}: bash/zsh did not acknowledge the bounded readiness probes`);
    };
    await expect.poll(async () => (await page.evaluate(() => window.api.sessions.list())).sessions.find(row => row.id === session.id)?.status,
      { timeout: 20_000, message: 'Ordinary shell must finish its production ownership/startup barrier' }).toBe('running');
    await waitShellReady('initial');
    await captureDiagnostic('shell-ready-before-input');
    const command = (mode: string) => `${powershell ? '& ' : ''}${quote(process.execPath, powershell)} ${quote(script, powershell)} ${mode}`;
    await type(command('ctrl'));
    await captureDiagnostic('ctrl-command-typed');
    await expect.poll(() => readJson<OwnedPids>(path.join(root, 'ctrl-pids.json')), { timeout: 15_000 }).toMatchObject({ nonce });
    ctrl = readJson<OwnedPids>(path.join(root, 'ctrl-pids.json'))!;
    expect(alive(ctrl.root)).toBe(true); expect(alive(ctrl.shell)).toBe(true);
    const interruptCheckpoint = await readBuffer();
    await page.keyboard.press('Control+c');
    await expect.poll(() => alive(ctrl!.root), { timeout: 10_000, message: 'Cooked Ctrl+C must stop the foreground long command' }).toBe(false);
    expect(alive(ctrl.shell), 'Ctrl+C must preserve the interactive shell').toBe(true);
    await waitShellReady('after-interrupt', interruptCheckpoint);
    await captureDiagnostic('shell-ready-after-interrupt');
    await type(powershell ? "Write-Output ('PTY_CTRL_' + 'RECOVERED')" : "printf 'PTY_CTRL_%s\\n' 'RECOVERED'");
    await expect.poll(() => page.evaluate(id => window.api.pty.getBuffer(id), session.id), { timeout: 10_000 }).toContain('PTY_CTRL_RECOVERED');

    await type(command('hold'));
    await expect.poll(() => readJson<OwnedPids>(path.join(root, 'hold-pids.json')), { timeout: 15_000 }).toMatchObject({ nonce });
    held = readJson<OwnedPids>(path.join(root, 'hold-pids.json'))!;
    expect(held.shell).toBe(ctrl.shell); expect(held.child).toBeGreaterThan(0);
    await expect.poll(() => readJson<{ pid: number; nonce: string }>(path.join(root, 'child-heartbeat.json')), { timeout: 10_000 }).toEqual({ pid: held.child, nonce });
    await type(`input-${nonce}`);
    await expect.poll(() => readJson(path.join(root, 'input-ack.json')), { timeout: 10_000 }).toEqual({ nonce, input: `input-${nonce}` });
    const readSizes = (): Array<{ cols: number; rows: number }> => {
      try { return fs.readFileSync(path.join(root, 'hold-sizes.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
    };
    await expect.poll(() => readSizes().filter(size => size.cols > 0 && size.rows > 0).length).toBeGreaterThan(0);
    const initialSize = readSizes().at(-1)!;
    const browserWindow = await app.browserWindow(page);
    const beforeWindow = await browserWindow.evaluate(win => ({ size: win.getSize(), content: win.getContentSize(), maximized: win.isMaximized() }));
    await browserWindow.evaluate(win => { if (win.isMaximized()) win.unmaximize(); const [width, height] = win.getSize(); win.setSize(width > 1300 ? 1150 : 1500, height > 800 ? 700 : 900); });
    await expect.poll(() => browserWindow.evaluate(win => win.getSize()), { message: 'The actual window must change size before checking PTY delivery' }).not.toEqual(beforeWindow.size);
    diagnostics.push({ label: 'window-resize', before: beforeWindow,
      after: await browserWindow.evaluate(win => ({ size: win.getSize(), content: win.getContentSize(), maximized: win.isMaximized() })) });
    await expect.poll(() => readSizes().some(size => size.cols > 0 && size.rows > 0 && (size.cols !== initialSize.cols || size.rows !== initialSize.rows)), {
      timeout: 10_000, message: 'Actual BrowserWindow resize must reach the user process PTY'
    }).toBe(true);
    expect(alive(held.root)).toBe(true); expect(alive(held.child!)).toBe(true);
    await page.screenshot({ path: path.join(info.outputDir, 'interactive-pty-ready.png') });
    await closeNormally();
    expect(launcher.exitCode, 'Launcher must exit cleanly through the shutdown barrier').toBe(0);
    for (const pid of new Set([ctrl.root, held.shell, held.root, held.child!])) {
      await expect.poll(() => alive(pid), { timeout: 5_000, message: `Owned fixture process ${pid} survived normal close` }).toBe(false);
    }
  } catch (error) {
    await captureDiagnostic('failure-before-normal-close');
    throw error;
  } finally {
    if (!closeAttempted) await closeNormally().catch(() => {});
    const survivingFixtureScripts = [ctrl?.root, held?.root, held?.child].filter((pid): pid is number => typeof pid === 'number').some(pid => alive(pid));
    if (!normalClosed || survivingFixtureScripts) {
      // Cooperatively stop only nonce-owned scripts; never taskkill a PID tree
      // or app.exit around the production shutdown barrier.
      fs.writeFileSync(stopFile, nonce);
      await pause(1000);
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
      await bounded(launcherClosed, 5000, 'Owned fixture launcher cleanup failed').catch(() => {});
    }
    fs.writeFileSync(path.join(info.outputDir, 'pty-lifecycle-diagnostics.json'), JSON.stringify({ commands, diagnostics, stdout, stderr }, null, 2));
    fs.writeFileSync(path.join(info.outputDir, 'pty-lifecycle-evidence.json'), JSON.stringify({ platform: process.platform, nonce, ctrl, held, normalClosed,
      launcherExitCode: launcher.exitCode, launcherSignal: launcher.signalCode }, null, 2));
    if (!normalClosed || survivingFixtureScripts) throw new Error('PTY lifecycle fixture required failure cleanup; normal shutdown was not proven');
  }
});
