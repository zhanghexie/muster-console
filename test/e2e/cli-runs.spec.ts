import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('外部 CLI 经真实调度派 GUI/PTY、问答、显式交付、取消及打开工作台', async () => {
  test.setTimeout(120_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'cli-runs-e2e-'));
  const fixtureApp = path.join(fixture, 'app');
  fs.mkdirSync(fixtureApp, { recursive: true });
  fs.cpSync(path.join(project, 'out'), path.join(fixtureApp, 'out'), { recursive: true });
  fs.cpSync(path.join(project, 'resources'), path.join(fixtureApp, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(project, 'package.json'), path.join(fixtureApp, 'package.json'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const home = path.join(userData, 'cli-discovery');
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.mkdirSync(userData, { recursive: true });
  const textOf = (message: any): string => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map((part: any) => part.text ?? '').join('');
  const deep = (value: any): any[] => {
    if (typeof value === 'string') { try { return deep(JSON.parse(value)); } catch { return []; } }
    if (!value || typeof value !== 'object') return [];
    return [value, ...Object.values(value).flatMap(deep)];
  };
  const eventDeliveries = new Set<string>();
  const observedToolsets: Map<string, any>[] = [];
  const observingRun = new Map<string, string>();
  const parsedCall = (fn: any) => {
    if (!fn) return undefined;
    const args = JSON.parse(fn.arguments || '{}');
    // R5：发现层退役——调度常驻工具原生注册，host.dispatch.run 直发 dispatch_run（无代理）
    return { name: fn.name.replace(/_/g, '.'), args };
  };
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => body += data);
    req.on('end', async () => {
      const payload = JSON.parse(body), messages = payload.messages ?? [], last = messages.at(-1);
      observedToolsets.push(new Map((payload.tools ?? []).map((tool: any) => [tool.function.name, tool.function.parameters])));
      const lastUser = [...messages].reverse().find((message: any) => message.role === 'user');
      const text = textOf(lastUser), previousCall = parsedCall([...messages].reverse().find((message: any) => message.tool_calls?.length)?.tool_calls[0]?.function);
      let call: { name: string; args: any } | undefined;
      let answer = 'Fixture response; a plain reply is not a delivery.';
      // R3b：runs.* 直调名从模型面退役，mock 模型改发 host.dispatch.run 信封；
      // R5：host.dispatch.run 已是调度常驻，直接以 dispatch_run 下划线形态调用（无 tools.call 代理）
      const dispatch = (action: string, params: any) => ({ name: 'host.dispatch.run', args: { action, params } });
      if (last.role !== 'tool' && text.includes('External CLI task:')) {
        call = dispatch('get', { runId: /External CLI task: ([a-f0-9-]+)/.exec(text)?.[1] });
      } else if (last.role !== 'tool' && text.includes('宿主收信提醒')) {
        call = { name: 'host.mail.read', args: {} };
      } else if (last.role === 'tool' && previousCall?.name === 'host.mail.read') {
        const contents = deep(textOf(last)).map((value: any) => value.text || '').join('\n');
        if (contents.includes('CLI-E2E-GUI-WORKER')) {
          call = { name: 'host.sessions.setStatus', args: { phase: 'needs_you', note: 'GUI done', reason: 'Controlled fixture work is complete; awaiting explicit run delivery.' } };
        } else {
          const runId = /CLI-E2E-WORKER-DONE RUN_ID=([a-f0-9-]+)/.exec(contents)?.[1];
          if (runId) { eventDeliveries.add(runId); call = dispatch('get', { runId }); }
        }
      } else if (last.role === 'tool' && previousCall?.name === 'host.sessions.setStatus') {
        const runId = /CLI-E2E-GUI-WORKER RUN_ID=([a-f0-9-]+)/.exec(messages.map(textOf).join('\n'))?.[1];
        if (runId) call = { name: 'host.mail.send', args: { to: 'scheduler', kind: 'notice', text: `CLI-E2E-WORKER-DONE RUN_ID=${runId}` } };
      } else if (last.role === 'tool' && previousCall?.name === 'host.dispatch.run' && eventDeliveries.has(previousCall.args.params?.runId)) {
        const run = deep(textOf(last)).find((item: any) => item.runId === previousCall.args.params.runId && item.workers);
        if (run?.state === 'running' && run.workers[0]?.sessionId) {
          observingRun.set(run.workers[0].sessionId, run.runId);
          call = { name: 'host.sessions.observe', args: { sessionId: run.workers[0].sessionId } };
        }
      } else if (last.role === 'tool' && previousCall?.name === 'host.sessions.observe') {
        const snapshot = deep(textOf(last)).find((item: any) => item.sessionId === previousCall.args.sessionId && 'busy' in item);
        const runId = observingRun.get(previousCall.args.sessionId);
        if (runId && snapshot?.busy === false && ['needs_you', 'done'].includes(snapshot.phase)) {
          call = dispatch('deliver', { runId, summary: `Event delivered ${runId}`, artifacts: [], verification: 'Real worker mail and idle observation with a controlled model.' });
        } else if (runId) {
          await new Promise(resolve => setTimeout(resolve, 100));
          call = { name: 'host.sessions.observe', args: previousCall.args };
        }
      } else if (text.includes('External CLI task:') && last.role === 'tool' && previousCall?.name === 'host.dispatch.run' && previousCall.args?.action === 'get') {
        // R3b 迁移坑位：旧代码以 previousCall.name==='runs.get' 区分「get 之后读任务」；
        // 九域收敛后所有域调用同名 host.dispatch.run，必须以 action==='get' 判别，否则
        // deliver 成功后的工具结果仍命中本分支，对已交付 run 无限重发 deliver。
        const runId = previousCall.args.params.runId;
        const taskPath = /Read original task: ([^\n]+)/.exec(text)?.[1]!;
        const inputPath = /Read current input: ([^\n]+)/.exec(text)?.[1]!;
        const task = fs.readFileSync(taskPath, 'utf8');
        if (task === 'ask' && inputPath === taskPath) call = dispatch('ask', { runId, question: 'Which option?' });
        else if (['gui', 'tty', 'cancel', 'bad-delegate'].includes(task) && inputPath === taskPath) call = dispatch('delegate', { runId, task: `${task === 'gui' ? 'CLI-E2E-GUI-WORKER' : 'CLI-E2E-TTY-WORKER'} RUN_ID=${runId} RUN_KIND=${task}`, runtime: task === 'bad-delegate' ? 'nonexistent-runtime' : task === 'gui' ? 'pi' : 'fixture-cli', isolation: 'shared', ...(task === 'gui' ? { guiMode: 'auto' } : {}) });
        else if (task !== 'bad') call = dispatch('deliver', { runId, summary: `Delivered ${task}: ${runId}`, artifacts: [], verification: 'Isolated Electron, mock model and fixture workers only.' });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'cli-e2e', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (call) {
        chunk({ tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: call.name.replace(/\./g, '_'), arguments: JSON.stringify(call.args) } }] }, null); chunk({}, 'tool_calls');
      }
      else { chunk({ content: answer }, null); chunk({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'CLI fixture', path: initial }],
    openai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture', model: 'fixture' },
    llm: { activeProviderId: 'cli-fixture', activeModelId: 'fixture', providers: [{ id: 'cli-fixture', name: 'CLI fixture', enabled: true,
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 4096 }] }] },
    mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  const runtimeRoot = path.join(userData, 'agent-runtimes');
  const builtinRoot = path.join(project, 'src/main/runtime/builtins');
  fs.cpSync(path.join(builtinRoot, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtinRoot, 'registry.json'), 'utf8'));
  registry.runtimes.push({ id: 'fixture-cli', label: 'CLI fixture', script: 'fixture-cli.mjs', enabled: true, builtin: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  const fixtureBuiltins = path.join(fixtureApp, 'out/main/runtime/builtins');
  fs.writeFileSync(path.join(fixtureBuiltins, 'registry.json'), JSON.stringify(registry));
  const child = path.join(fixture, 'worker.cjs');
  // 新建 CLI Worker 的首轮任务经 launch argv 注入文件直发（appendPrompt 管线，
  // 「请使用 UTF-8 编码读取并立即执行任务文件：<path>」），不再寄首封任务信等 idle 唤醒（对齐
  // docs/features/session-mailbox.md 唤醒规则与 test/delegate-launch.mjs 的 cli-prompt 断言）。
  // PTY fixture 据此从 argv 读任务文件完成派活，仍以真实 setStatus(needs_you) + DONE 信收口。
  fs.writeFileSync(child, `const tool = async (name, args) => { const response = await fetch(process.env.MUSTER_TOOL_URL, {method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.MUSTER_SESSION_TOKEN},body:JSON.stringify({name,arguments:args})}); return response.json(); };
const fs = require('node:fs');
const taskPrefix = '请使用 UTF-8 编码读取并立即执行任务文件：';
process.stdout.write('TTY fixture ready\\n');
let working=false,completed=false;
const idle=()=>fetch(process.env.MUSTER_STATUS_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({activity:'idle',event:'stop'})});
setInterval(()=>{if(!working)void idle();},250);
async function readAssignment(){
 if(working||completed)return true;working=true;
 const arg=process.argv.find(a=>a.startsWith(taskPrefix));
 const file=arg?arg.slice(taskPrefix.length):'';
 const text=file&&fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
 if(!text.includes('CLI-E2E-TTY-WORKER')){working=false;return false;}
 if(text.includes('RUN_KIND=cancel'))return true;
 const runId=/RUN_ID=([a-f0-9-]+)/.exec(text)[1];
 await tool('host.sessions.setStatus',{phase:'needs_you',note:'TTY done',reason:'Controlled fixture work is complete; awaiting explicit run delivery.'});
 completed=true;working=false;await idle();
 await tool('host.mail.send',{to:'scheduler',kind:'notice',text:'CLI-E2E-WORKER-DONE RUN_ID='+runId});
 return true;
}
process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdin.resume();
process.stdin.on('data',data=>{for(const ch of data){if(ch==='\\x03')process.exit(0);}});
(async()=>{for(let tries=0;tries<40;tries++){let done=false;try{done=await readAssignment();}catch(error){process.stderr.write(String(error));process.exit(1);}if(done)break;await new Promise(r=>setTimeout(r,250));}})();
`);
  const fixtureRuntime = `import {randomUUID} from 'node:crypto';
import {appendCliPrompt} from './_helpers.mjs';
export async function allocate(){return {sessionId:randomUUID()};}
export function appendPrompt(options){return appendCliPrompt(options);}
export function resolveLaunch({extraArgs}){return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(child)},...extraArgs]};}
`;
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-cli.mjs'), fixtureRuntime);
  fs.writeFileSync(path.join(fixtureBuiltins, 'scripts/fixture-cli.mjs'), fixtureRuntime);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `cli-runs-${process.pid}`, MUSTER_CLI_HOME: home, MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1' });
  const app = await _electron.launch({ executablePath: require('electron'), args: [fixtureApp, '--disable-gpu'], cwd: fixture, env });
  const workers: string[] = [];
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await expect.poll(() => fs.existsSync(home) ? fs.readdirSync(home).filter(name => name.endsWith('.json')).length : 0).toBe(1);
    const descriptor = JSON.parse(fs.readFileSync(path.join(home, fs.readdirSync(home).find(name => name.endsWith('.json'))!), 'utf8'));
    const command = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/command`, { method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}` }, body: JSON.stringify({ command: name, args }) });
      const result = await response.json() as any; expect(result.ok, JSON.stringify(result.error)).toBe(true); return result.result;
    };
    const status = await command('status'); const workspaceId = status.workspaces[0].id;
    const cli = (...args: string[]) => new Promise<{ code: number | null; result: any }>((resolve, reject) => {
      const proc = spawn(require('electron'), [path.join(project, 'out/main/cliRuns/entry.mjs'), ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
      let output = ''; proc.stdout.on('data', data => output += data); proc.on('error', reject); proc.on('close', code => { try { resolve({ code, result: JSON.parse(output) }); } catch (error) { reject(error); } });
    });
    expect((await cli('status')).result.result.id).toBe(descriptor.id);
    const submit = (text: string) => command('run submit', { workspace: workspaceId, text });
    const direct = await submit('direct');
    await expect.poll(async () => (await command('run get', { runId: direct.runId })).state, { timeout: 30000 }).toBe('delivered');
    expect((await cli('run', 'result', direct.runId)).result.result.result.summary).toContain(direct.runId);
    const ask = await submit('ask');
    await expect.poll(async () => (await command('run get', { runId: ask.runId })).state, { timeout: 20000 }).toBe('waiting');
    const question = (await command('run get', { runId: ask.runId })).question;
    expect((await cli('run', 'wait', ask.runId, '--timeout', '0')).code).toBe(3);
    await command('run reply', { runId: ask.runId, text: 'A', 'question-id': question.id });
    await expect.poll(async () => (await command('run get', { runId: ask.runId })).state, { timeout: 20000 }).toBe('delivered');
    for (const kind of ['gui', 'tty']) {
      const run = await submit(kind);
      let currentRun: any;
      try {
        await expect.poll(async () => {
          currentRun = await command('run get', { runId: run.runId });
          return currentRun.workers[0]?.sessionId;
        }, { timeout: 30000 }).toBeTruthy();
      } catch (error) {
        console.log('Controlled CLI fixture run state:', kind, JSON.stringify(currentRun));
        console.log('Controlled CLI fixture run logs:', JSON.stringify(await command('run logs', { runId: run.runId, limit: 200 })));
        throw error;
      }
      const worker = (await command('run get', { runId: run.runId })).workers[0]; workers.push(worker.sessionId);
      expect(worker.taskId.length).toBeLessThanOrEqual(64);
      await expect.poll(async () => {
        const all = await win.evaluate(async () => (window as any).api.sessions.list());
        return all.sessions.find((session: any) => session.id === worker.sessionId)?.phase?.value;
      }, { timeout: 20000 }).toBe('needs_you');
      // Explicit worker result mail wakes the scheduler; delivery still requires observed idle.
      await expect.poll(async () => (await command('run get', { runId: run.runId })).state, { timeout: 45000 }).toBe('delivered');
      expect(eventDeliveries.has(run.runId)).toBe(true);
      const logs = await command('run logs', { runId: run.runId, limit: 200 });
      expect(logs.events.some((event: any) => event.source === `worker:${worker.sessionId}`)).toBe(true);
    }
    const schedulerTools = observedToolsets.find(tools => tools.has('host_sessions_review'));
    expect(schedulerTools, 'real scheduler payload has resident review tools').toBeTruthy();
    expect(schedulerTools?.get('host_sessions_create')?.required).toContain('isolation');
    expect(schedulerTools?.get('host_sessions_create')?.properties.isolation.enum).toEqual(['shared', 'isolated']);
    for (const id of ['host_ask', 'host_sessions_review', 'host_sessions_integrate', 'host_terminal_write', 'host_terminal_capture']) expect(schedulerTools?.get(id)?.properties, id).toBeTruthy();
    expect(schedulerTools?.has('host_sessions_requestIntegrate')).toBe(false);
    // R4 调度常驻终态（tool-exposure 计划 §2.2「观察与事件剩余 9」，SCHEDULER_RESIDENT_TOOL_IDS）：
    // events.subscribe 从 Worker 专属升为调度常驻，这里按新契约断言其在场。
    expect(schedulerTools?.has('host_events_subscribe')).toBe(true);
    const workerTools = observedToolsets.find(tools => tools.has('host_sessions_requestIntegrate'));
    expect(workerTools, 'real GUI Worker payload has resident self-bound merge request').toBeTruthy();
    expect(workerTools?.get('host_sessions_create')?.required).toContain('isolation');
    expect(workerTools?.get('host_sessions_create')?.properties.isolation.enum).toEqual(['shared', 'isolated']);
    expect(workerTools?.has('host_sessions_integrate')).toBe(false);
    expect(workerTools?.has('host_sessions_review')).toBe(false);
    const cancelled = await submit('cancel');
    await expect.poll(async () => (await command('run get', { runId: cancelled.runId })).workers[0]?.sessionId, { timeout: 20000 }).toBeTruthy();
    workers.push((await command('run get', { runId: cancelled.runId })).workers[0].sessionId);
    const cancel = await command('run cancel', { runId: cancelled.runId });
    expect(cancel.state).toBe('cancelled'); expect(cancel.cancellationErrors).toEqual([]);
    expect((await command('run result', { runId: direct.runId })).state).toBe('delivered');
    const bad = await submit('bad');
    await expect.poll(async () => (await command('run get', { runId: bad.runId })).state, { timeout: 20000 }).toBe('failed');
    const badDelegate = await submit('bad-delegate');
    await expect.poll(async () => (await command('run get', { runId: badDelegate.runId })).state, { timeout: 20000 }).toBe('failed');
    expect((await command('run get', { runId: badDelegate.runId })).workers).toEqual([]);
    await command('open', { runId: direct.runId });
    await expect(win.locator('.agent-float')).toBeVisible();
    fs.mkdirSync(path.join(project, '.tmp/cli-e2e'), { recursive: true });
    await win.screenshot({ path: path.join(project, '.tmp/cli-e2e/open.png') });
  } finally {
    const win = await app.firstWindow().catch(() => undefined);
    for (const id of workers) await win?.evaluate(async sessionId => (window as any).api.sessions.setArchived(sessionId, true), id).catch(() => {});
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
  }
});
