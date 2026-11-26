import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import { getSubagentCharacter } from '../../src/shared/subagentCharacters';

/** Own app cwd + controlled model; tools, sessions, IPC, storage and renderer are real. */
test('子代理共用宿主邮箱：完整报告、主动收信、宿主去重唤醒与历史身份', async () => {
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'subagent-role-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  fs.mkdirSync(userData, { recursive: true });
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    userAvatar: { kind: 'emoji', value: '🌸', displayName: 'User' },
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  let heldResponse: http.ServerResponse | undefined;
  let displayItemsSentToModel = false;
  const model = http.createServer((req, res) => {
    const body:Buffer[]=[];req.on('data',data=>body.push(Buffer.from(data)));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (JSON.stringify(payload.messages ?? []).includes('"displayItems"')) displayItemsSentToModel = true;
      const last = payload.messages?.at(-1) ?? {};
      const content = typeof last.content === 'string' ? last.content
        : (last.content ?? []).map((block: { text?: string }) => block.text ?? '').join('');
      const directive = content.slice(content.lastIndexOf('\ntool:') + 1).trim();
      const match = last.role === 'user' ? /^tool:(\w+)\s*(\{[\s\S]*\})$/.exec(directive) : null;
      if (last.role === 'user' && content.includes('HOLD_NATIVE_TURN')) {
        heldResponse = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'held-turn', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Waiting for interruption.' }, finish_reason: null }] })}\n\n`);
        return;
      }
      const modelMessages = payload.messages as Array<{ role: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
      const previousCall = [...(modelMessages ?? [])].reverse().find(m => m.role === 'assistant' && m.tool_calls?.length)?.tool_calls?.at(-1)?.function;
      const finishReportedResult = last.role === 'tool' && previousCall?.name === 'host_mail_send'
        && previousCall.arguments.includes('SINGLE_RESULT_REPORT');
      const unwrap = (value: string): any => {
        try { const parsed=JSON.parse(value); return parsed.content ? JSON.parse(parsed.content[0].text).result : parsed.result ?? parsed; }
        catch { return null; }
      };
      let mailboxCall: {name:string;arguments:string}|null=null;
      if(last.role==='user' && content.includes('【宿主收信提醒】')) {
        mailboxCall={name:'host_mail_read',arguments:JSON.stringify({unreadOnly:true,limit:20})};
      } else if(last.role==='tool' && previousCall?.name==='host_mail_read') {
        const result=unwrap(content);
        if(result?.messages?.[0]) mailboxCall={name:'host_mail_read',arguments:JSON.stringify({messageId:result.messages[0].id,length:1500})};
        else if(result?.nextOffset!=null && result?.id) mailboxCall={name:'host_mail_read',arguments:JSON.stringify({messageId:result.id,bodyOffset:result.nextOffset,length:1500})};
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
        id: 'subagent-role', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`);
      if (mailboxCall) {
        chunk({tool_calls:[{index:0,id:`mail-${Date.now()}`,type:'function',function:mailboxCall}]});chunk({},'tool_calls');
      } else if (match) {
        chunk({ tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: match[1], arguments: match[2] } }] });
        chunk({}, 'tool_calls');
      } else if (finishReportedResult) {
        chunk({ tool_calls: [{ index: 0, id: `status-${Date.now()}`, type: 'function',
          function: { name: 'host_sessions_setStatus', arguments: JSON.stringify({ phase: 'done', note: '验证已闭环' }) } }] });
        chunk({}, 'tool_calls');
      } else { chunk({ content: 'Local role fixture completed.' }); chunk({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `subagent-role-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const appOutput: string[]=[];
  app.process().stdout?.on('data',data=>appOutput.push(String(data)));
  app.process().stderr?.on('data',data=>appOutput.push(String(data)));
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.bringToFront();
    await win.evaluate(async baseUrl => window.api.config.update({ openai: { baseUrl, apiKey: 'local-test', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    const root = path.join(fixture, 'source'); fs.mkdirSync(root);
    const ws = await win.evaluate(async root => window.api.workspaces.open({ name: 'Role test',
      roots: [{ id: 'source', path: root }], defaultRootId: 'source', controlRootId: 'source' }), root);
    expect(ws.ok, ws.message).toBe(true);
    const parent = await win.evaluate(async workspaceId => window.api.sessions.create({ workspaceId,
      rootId: 'source', runtime: 'pi', name: 'Role parent' }), ws.activeWorkspaceId);
    await win.evaluate(async id => window.api.agentSession.setMode(id, 'auto'), parent.id);
    const children = () => win.evaluate(async id => (await window.api.sessions.list()).sessions.filter(s => s.parentSessionId === id), parent.id);
    const history = (id: string) => win.evaluate(id => window.api.agentSession.historyRange(id), id);
    for (const choice of [{}, { isolation: 'auto' }, { isolation: 'isolated' }]) {
      const before = (await history(parent.id))!.messages.length;
      await win.evaluate(async ({ id, text }) => window.api.agentSession.send(id, text), { id: parent.id,
        text: `tool:host_sessions_create ${JSON.stringify({ asSubagent: true, task: 'Invalid isolation must not create a worker', ...choice })}` });
      await expect.poll(async () => (await history(parent.id))?.busy, { timeout: 30_000 }).toBe(false);
      const tools = (await history(parent.id))!.messages.slice(before).flatMap(m => m.parts).filter(p => p.kind === 'tool');
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map(p => p.kind === 'tool' ? p.tool.output : '').join('\n')).toMatch(/isolation|Validation failed/);
      expect(await children()).toHaveLength(0);
    }
    await win.evaluate(async ({ id, text }) => window.api.agentSession.send(id, text), { id: parent.id,
      text: `tool:host_sessions_create ${JSON.stringify({ asSubagent: true, name: '按钮布局',
        task: '检查按钮布局。仅回复检查结束，不修改文件。', isolation: 'shared', select: false })}` });
    await expect.poll(async () => (await children()).length, { timeout: 30_000 }).toBe(1);
    const child = (await children())[0];
    const character = getSubagentCharacter(child.subagentCharacterId);
    expect(character).toBeTruthy();
    expect(child.name).toBe(`${character!.name} · 按钮布局`);
    expect((child as unknown as Record<string, unknown>).agentTaskId).toBeUndefined();
    await expect.poll(async () => (await history(child.id))?.messages.filter(m => m.role === 'assistant').at(-1)?.finishedAt ?? 0,
      { timeout: 30_000 }).toBeGreaterThan(0);
    const finished = (await history(child.id))!.messages.filter(m => m.role === 'assistant').at(-1)!;
    expect(finished.finishedAt).toBeGreaterThan(0);
    await expect.poll(async () => (await history(parent.id))?.busy, { timeout: 30_000 }).toBe(false);
    const initialNotices=(await history(parent.id))!.messages.filter(m=>m.host||m.source==='agent');
    expect(initialNotices).toHaveLength(0); // Native final replies never generate automatic result mail.
    const beforeObserve = (await history(parent.id))!.messages.length;
    await win.evaluate(async ({ id, text }) => window.api.agentSession.send(id, text), { id: parent.id,
      text: `tool:host_sessions_observe ${JSON.stringify({ sessionId: child.id })}` });
    const observation = async () => {
      const tools = (await history(parent.id))!.messages.slice(beforeObserve).flatMap(m => m.parts)
        .filter(p => p.kind === 'tool');
      const tool = tools.reverse().find(p => p.kind === 'tool' && p.tool.name.replace(/_/g, '.') === 'host.sessions.observe');
      if (tool?.kind !== 'tool' || !tool.tool.output) return null;
      const output = JSON.parse(tool.tool.output);
      return output.content ? JSON.parse(output.content[0].text).result : output.result;
    };
    await expect.poll(async () => (await observation())?.lastReply?.messageId, { timeout: 30_000 }).toBe(finished.id);
    const observed = await observation();
    expect(observed.parentSessionId).toBe(parent.id);
    expect(observed.lastReply.status).toBe('completed');
    expect(observed.lastReply.finishedAt).toBe(finished.finishedAt);
    expect(observed.lastReply.text).toContain('Local role fixture completed.');
    expect(observed.busy).toBe(false);
    await expect.poll(async () => (await history(parent.id))?.busy, { timeout: 30_000 }).toBe(false);
    // Workers can observe the scheduler through the same tool, with a real completed turn.
    const schedulerSent = await win.evaluate(workspaceId => window.api.chat.send('SCHEDULER_OBSERVE_FIXTURE：只回复结束。', workspaceId), ws.activeWorkspaceId);
    expect(schedulerSent.accepted, schedulerSent.error).toBe(true);
    await expect.poll(async () => (await win.evaluate(workspaceId => window.api.chat.state(workspaceId), ws.activeWorkspaceId)).busy,
      { timeout: 30_000 }).toBe(false);
    const schedulerMessages = await win.evaluate(async workspaceId => ((await window.api.chat.historyRange(workspaceId)).messages) as Array<{
      id: string; role: string; finishedAt?: number
    }>, ws.activeWorkspaceId);
    const schedulerReply = schedulerMessages.filter(m => m.role === 'assistant').at(-1)!;
    expect(schedulerReply.finishedAt).toBeGreaterThan(0);
    await win.evaluate(async ({ id, text }) => window.api.agentSession.send(id, text), { id: parent.id,
      text: 'tool:host_sessions_observe {"sessionId":"scheduler"}' });
    await expect.poll(async () => (await observation())?.sessionId, { timeout: 30_000 }).toBe(`orchestrator:${ws.activeWorkspaceId}`);
    expect((await observation()).lastReply.messageId).toBe(schedulerReply.id);
    expect((await observation()).lastReply.status).toBe('completed');
    await expect.poll(async () => (await history(parent.id))?.busy, { timeout: 30_000 }).toBe(false);
    const beforeGeneric = (await history(parent.id))!.messages.length;
    const longReport='SINGLE_RESULT_REPORT：17×23=391。'+('完整证据及验证记录。'.repeat(900))+'FINAL_REPORT_END';
    await win.evaluate(async ({ id, text }) => window.api.agentSession.send(id, text), { id: child.id,
      text: `tool:host_mail_send ${JSON.stringify({ to: parent.id, subject:'完整交付', text:longReport,idempotencyKey:'final-result' })}` });
    const newParent=async()=>(await history(parent.id))!.messages.slice(beforeGeneric);
    await expect.poll(async()=>(await newParent()).filter(m=>m.host).length,{timeout:30000}).toBe(1);
    await expect.poll(async()=>(await history(parent.id))?.busy,{timeout:30000}).toBe(false);
    const received=await newParent();
    expect(received.filter(m=>m.source==='agent')).toHaveLength(0);
    const wake=received.find(m=>m.host)!;expect(wake.parts).toEqual(expect.arrayContaining([expect.objectContaining({kind:'text',text:expect.stringContaining('宿主收信提醒')})]));
    expect(JSON.stringify(wake)).not.toContain('SINGLE_RESULT_REPORT');
    const readTools=received.flatMap(m=>m.parts).filter(p=>p.kind==='tool'&&p.tool.name==='host_mail_read');
    expect(readTools.length).toBeGreaterThan(3);expect(JSON.stringify(readTools)).toContain('FINAL_REPORT_END');
    expect(received.flatMap(m => m.displayItems ?? []).some(item => item.kind === 'mail' && item.pages.some(page => page.text.includes('SINGLE_RESULT_REPORT')))).toBe(true);
    expect(displayItemsSentToModel).toBe(false);
    await win.evaluate(async id=>window.api.sessions.select(id),parent.id);
    const notice=win.locator('.chat-msg.is-host').filter({hasText:'宿主收信提醒'}).first();
    await expect(notice).toBeVisible();await expect(notice.locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);
    await expect(notice.locator('.chat-msg-avatar')).toHaveAttribute('data-avatar-sender','host');
    const letter = win.locator('[data-mail-read]').filter({ hasText: 'SINGLE_RESULT_REPORT' }).first();
    await letter.scrollIntoViewIfNeeded();
    await expect(letter).toBeVisible();
    await expect(letter.locator('.chat-msg-avatar')).toHaveAttribute('data-avatar-sender', 'agent');
    await expect(letter.locator('img')).toHaveAttribute('src', new RegExp(character!.id));
    // Production Electron renderer, actual theme settings, plus a narrow viewport.
    for(const theme of ['dark','light'] as const){
      const switched=await win.evaluate(theme=>window.api.themes.activate(theme,{scope:'workspace'}),theme);
      expect(switched.ok).toBe(true);
      await expect(win.locator('html')).toHaveAttribute('data-theme',theme);
      await win.screenshot({path:path.join(fixture,`mailbox-${theme}.png`)});
    }
    const mailboxDir=path.join(userData,'agent-messages');
    const mails=()=>fs.readdirSync(mailboxDir).filter(f=>f.endsWith('.sqlite')).flatMap(f=>{
      const db=new DatabaseSync(path.join(mailboxDir,f));
      try { return db.prepare('SELECT entry_json FROM mailbox_message ORDER BY sequence').all().map((row:any)=>JSON.parse(row.entry_json)); }
      finally { db.close(); }
    });
    const delivered=mails().find((m:any)=>m.subject==='完整交付');
    expect(delivered.receipt).toBe('stored');expect(delivered.read).toBe(true);expect(delivered.readAt).toBeGreaterThan(0);
    expect(delivered.bodyChars).toBe(longReport.length);expect(delivered.text.length).toBeLessThanOrEqual(240);
    expect(fs.readFileSync(path.join(mailboxDir,`${ws.activeWorkspaceId}-bodies`,`${createHash('sha256').update(delivered.id).digest('hex')}.txt`),'utf8')).toBe(longReport);
    // Same letter retry cannot create either another result record or another wake.
    await expect.poll(async()=>(await history(child.id))?.busy,{timeout:30000}).toBe(false);
    await win.evaluate(async({id,text})=>window.api.agentSession.send(id,text),{id:child.id,
      text:`tool:host_mail_send ${JSON.stringify({to:parent.id,subject:'完整交付',text:longReport,idempotencyKey:'final-result'})}`});
    await expect.poll(async()=>(await history(child.id))?.busy,{timeout:30000}).toBe(false);
    expect(mails().filter((m:any)=>m.subject==='完整交付')).toHaveLength(1);
    expect((await newParent()).filter(m=>m.host)).toHaveLength(1);
    await win.evaluate(async ({ id, text }) => window.api.agentSession.send(id, text), { id: child.id,
      text: `tool:host_mail_send ${JSON.stringify({to:parent.id,text:'ROLE_MAIL_REPORT：按钮布局检查完成。'})}` });
    await expect.poll(async()=>(await newParent()).filter(m=>m.host).length,{timeout:30000}).toBe(2);
    await expect.poll(async()=>(await history(parent.id))?.busy,{timeout:30000}).toBe(false);
    const report=mails().find((m:any)=>m.text.includes('ROLE_MAIL_REPORT'));
    expect(report.from).toBe(child.id);expect(report.fromName).toBe(child.name);expect(report.read).toBe(true);
    await expect.poll(async()=>(await history(child.id))?.busy,{timeout:30000}).toBe(false);
    await win.evaluate(async({id,text})=>window.api.agentSession.send(id,text),{id:child.id,
      text:'tool:host_mail_send '+JSON.stringify({to:'scheduler',text:'SCHEDULER_MAILBOX_REPORT：共享宿主验证。'})});
    const schedulerMail=()=>mails().find((m:any)=>m.text.includes('SCHEDULER_MAILBOX_REPORT'));
    await expect.poll(()=>schedulerMail()?.read,{timeout:30000}).toBe(true);
    expect(schedulerMail().to).toBe(`orchestrator:${ws.activeWorkspaceId}`);
    await expect.poll(async()=>(await win.evaluate(id=>window.api.chat.state(id),ws.activeWorkspaceId)).busy,{timeout:30000}).toBe(false);
    // Real shared tool -> transient sender preview -> durable launch -> stored receipt.
    const shellBase=JSON.parse(fs.readFileSync(path.join(userData,'shell-api.json'),'utf8')).baseUrl as string;
    expect(child.statusToken).toBeTruthy();
    const sendBatch=async(subject:string,kind='notice')=>Promise.all(Array.from({length:3},async(_,i)=>{
      const response=await fetch(`${shellBase}/v1/tool`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${child.statusToken}`},
        body:JSON.stringify({name:'host.mail.send',arguments:{to:parent.id,subject:`${subject}-${i}`,kind,text:`${subject}：代理间协作进展 ${i+1}，无需用户回复。`}})});
      const result=await response.json();expect(result.ok,JSON.stringify(result)).toBe(true);return result;
    }));
    await win.evaluate(id=>window.api.sessions.select(id),child.id);await win.bringToFront();
    await expect.poll(()=>win.evaluate(()=>document.hasFocus())).toBe(true);
    // Previous functional-mail events can reach the renderer after the tool finishes.
    // Wait for an observed quiet window so this visual batch contains only its own three letters.
    const envelopeBeforeBatch=win.locator('.mail-envelope-scene');let lastEnvelopeAt=Date.now();
    await expect.poll(async()=>{const active=await envelopeBeforeBatch.count();if(active)lastEnvelopeAt=Date.now();return !active&&Date.now()-lastEnvelopeAt>=1000;},{timeout:20000}).toBe(true);
    const sending=sendBatch('信封寄出验收');
    void sending.catch(()=>{});
    const envelope=win.locator('.mail-envelope-scene');
    await expect(envelope).toHaveAttribute('data-direction','send');await expect(envelope).toHaveAttribute('data-count','3');
    await expect(envelope).toHaveAttribute('data-phase','preview');
    await expect(envelope.locator('.es-flight')).toHaveCount(3);
    await expect(envelope.locator('input,button')).toHaveCount(0);
    await win.screenshot({path:path.join(fixture,'envelope-send-preview.png')});
    await sending;
    await expect(envelope).toHaveCount(0,{timeout:10000});
    await win.evaluate(id=>window.api.sessions.select(id),parent.id);await win.bringToFront();
    await expect(envelope).toHaveCount(0); // Selecting a mailbox never replays past mail.
    await sendBatch('信封收信验收','ask');
    await expect(envelope).toHaveAttribute('data-direction','receive');await expect(envelope).toHaveAttribute('data-count','3');
    await expect(envelope).toHaveAttribute('data-phase','preview',{timeout:6000});
    await expect(win.locator('.scheduler-asks')).toHaveCount(0);
    await expect(win.getByPlaceholder('直接答复…')).toHaveCount(0);
    await win.screenshot({path:path.join(fixture,'envelope-receive-preview.png')});
    await expect(envelope).toHaveCount(0,{timeout:10000});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.hide());
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
    // Native visibility is authoritative here: the automated renderer may still
    // report document.visibilityState='visible' after the BrowserWindow is hidden.
    await sendBatch('后台邮件不补播');await expect(envelope).toHaveCount(0);
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window?.show();window?.focus();});
    await win.bringToFront();await expect.poll(()=>win.evaluate(()=>document.hasFocus())).toBe(true);
    await win.waitForTimeout(500);await expect(envelope).toHaveCount(0);
    expect(mails().filter((m:any)=>m.subject?.startsWith('后台邮件不补播'))).toHaveLength(3);
    // R5：发现层退役——tools_search/tools_call 用例按语义迁移为常驻直调：
    // browser 域收敛为 browser.run 单入口，直调 action=tabs（无发现轮次）
    for (const directive of ['tool:host_browser_run {"action":"tabs","params":{}}']) {
      await win.evaluate(async ({id,text})=>window.api.agentSession.send(id,text),{id:parent.id,text:directive});
      await expect.poll(async()=>(await history(parent.id))?.busy).toBe(false);
    }
    const discovered=JSON.stringify((await history(parent.id))!.messages);
    expect(discovered).toContain('host_browser_run');
    const abortedBefore = (await history(child.id))!.messages.filter(m=>m.role==='assistant'&&m.aborted).length;
    await win.evaluate(({id})=>{void window.api.agentSession.send(id,'HOLD_NATIVE_TURN');},{id:child.id});
    await expect.poll(async()=>(await history(child.id))?.busy).toBe(true);
    await expect.poll(()=>!!heldResponse).toBe(true);
    await win.evaluate(async({id,text})=>window.api.agentSession.send(id,text),{id:parent.id,
      text:'tool:host_mail_send '+JSON.stringify({to:child.id,subject:'native-follow-up',text:'NORMAL_FOLLOW_UP：当前工作之后读取新信。',idempotencyKey:'e2e-native-follow-up'})});
    await expect.poll(()=>!!mails().find((m:any)=>m.subject==='native-follow-up')).toBe(true);
    await expect.poll(async()=>(await history(parent.id))?.busy).toBe(false);
    const pendingMail=mails().find((m:any)=>m.subject==='native-follow-up');
    expect(pendingMail.deliveryMethod).toBeUndefined();
    expect(pendingMail.notifiedAt ?? null).toBeNull();
    expect(pendingMail.read).toBe(false);
    expect(heldResponse!.destroyed, 'ordinary mail waits for idle without queuing into the active turn').toBe(false);
    await win.evaluate(async({id,text})=>window.api.agentSession.send(id,text),{id:parent.id,
      text:'tool:host_mail_send '+JSON.stringify({to:child.id,text:'INTERRUPT_MAIL_ONLY：请读取新信。',interrupt:true,idempotencyKey:'e2e-interrupt'})});
    await expect.poll(()=>mails().find((m:any)=>m.meta?.interrupt)?.deliveryMethod,{timeout:20000}).toBe('steered');
    expect(mails().find((m:any)=>m.meta?.interrupt)?.interruption).toBe('accepted');
    expect(heldResponse!.destroyed, 'native Pi steering must not abort the in-flight API response').toBe(false);
    heldResponse!.end(`data: ${JSON.stringify({id:'held-turn',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
    await expect.poll(async()=>(await history(child.id))?.busy,{timeout:20000}).toBe(false);
    await expect.poll(()=>mails().find((m:any)=>m.meta?.interrupt)?.read,{timeout:20000}).toBe(true);
    await expect.poll(()=>mails().find((m:any)=>m.subject==='native-follow-up')?.read,{timeout:20000}).toBe(true);
    expect((await history(child.id))!.messages.filter(m=>m.role==='assistant'&&m.aborted)).toHaveLength(abortedBefore);
    const beforeReopen=(await history(parent.id))!.messages.filter(m=>m.host).length;
    await win.evaluate(()=>{void window.api.app.quit();}).catch(()=>{});await app.close();
    const saved=JSON.parse(fs.readFileSync(path.join(userData,'agent-sessions',`${parent.id}.json`),'utf8'));
    expect(saved.messages.filter((m:any)=>m.host)).toHaveLength(beforeReopen);
    expect(saved.messages.some((m:any)=>m.role==='user'&&m.parts.some((p:any)=>p.kind==='text'&&p.text.includes('SINGLE_RESULT_REPORT')))).toBe(false);
    console.log('mailbox artifacts:',fixture);
  } finally {
    fs.writeFileSync(path.join(fixture,'electron-output.log'),appOutput.join(''));
    console.log('Electron output:',appOutput.join('').slice(-8000));
    await app.close().catch(() => {});
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
