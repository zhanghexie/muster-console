import {test,expect,_electron} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {buildSync} from 'esbuild';
import type {KnowledgeDraft,KnowledgeRecord,KnowledgeSnapshot} from '../../src/shared/knowledge';
import type {MemoryCorrectionInput,MemoryCuratorQueuePage,MemoryCuratorSnapshot} from '../../src/shared/memoryCurator';

test('受保护记忆的更正审查在真实中心展示未应用建议，用户主动修订后保留原审查记录',async()=>{
  test.setTimeout(90000);
  const project=path.resolve(__dirname,'../..');
  fs.mkdirSync(path.join(project,'.tmp'),{recursive:true});
  const fixture=fs.mkdtempSync(path.join(project,'.tmp','correction-review-app-'));
  const userData=path.join(fixture,'.dev-sandbox/userData'),work=path.join(fixture,'work'),home=path.join(fixture,'home');
  for(const directory of [userData,work,home])fs.mkdirSync(directory,{recursive:true});
  const workspaceId='demo-frontend',requestId='correction-review-request';
  const originalSummary='报告先写结论',proposalSummary='报告先写结论，再写验证范围';
  const savedSummary='报告先写结论、验证范围和未完成事项';
  const draft:KnowledgeDraft={kind:'user_preference',summary:originalSummary,applicability:['工作报告']};
  const source='更正报告偏好，改为先写结论，再写验证范围';
  const now=Date.now();
  const seeder=path.join(fixture,'seed.cjs');
  buildSync({stdin:{contents:"export {KnowledgeStore} from './src/main/memory/knowledgeStore';export {CuratorQueue} from './src/main/memory/curator/queue';export {curatorDirectory} from './src/main/memory/layout';",resolveDir:project},outfile:seeder,bundle:true,platform:'node',format:'cjs',packages:'external'});
  const {KnowledgeStore,CuratorQueue,curatorDirectory}=require(seeder);
  const directory=path.join(work,'.muster/memory/knowledge/worker');
  const store=new KnowledgeStore(directory,path.join(directory,'ledger'));
  const queue=new CuratorQueue(work,curatorDirectory(work,workspaceId));
  let original!:KnowledgeRecord,correction!:MemoryCorrectionInput;
  try{
    const initial=store.submit(draft,{namespace:'worker',origin:'user',explicit:true,evidence:[{id:'original-user',source:'e2e-host-user',eventTime:now,verification:'user_confirmed'}]}).record;
    original=store.revise(initial.id,initial.revision,draft);
    expect(original.userManaged).toBe(true);
    correction={memoryId:original.id,revision:original.revision,problem:'用户偏好已经增加验证范围，原结论遗漏这项要求。',evidence:'本轮用户明确更正报告偏好的原话。',suggestion:proposalSummary};
    const evidence=[{id:'correction-user',source:'e2e-host-turn',eventTime:now,verification:'user_confirmed',observation:'user_input',excerpt:source}];
    const candidate={id:requestId,eventId:'correction-review-event',namespace:'worker',origin:'worker',text:JSON.stringify(correction),sourceText:source,userText:source,evidence,createdAt:now,correction,requesterSessionId:'e2e-requester'};
    expect(queue.enqueue(candidate).queued).toBe(true);
    const [claim]=queue.claim(1,60000);expect(claim).toBeTruthy();
    const receipt=store.commitCuratorDecision({operationId:'correction-review-operation',candidateId:requestId,policyVersion:'e2e-review',decision:'correct',draft:{...draft,summary:proposalSummary,rationale:'来自用户本轮明确表达的偏好更正。'},sourceQuote:source,reason:'用户已确认的版本受保护，仅生成更正建议。',targetId:original.id,targetRevision:original.revision,reviewedDeletionIds:[],deletionComparisons:[]},{namespace:'worker',origin:'worker',sourceText:source,userText:source,evidence,correction,now,assertCurrent:()=>queue.assertClaim(claim,queue.generation)});
    expect(receipt.disposition).toBe('needs_user');expect(receipt.affected).toEqual([]);
    queue.settle(claim,receipt);
    expect(queue.inspect({state:'attention'}).items[0].result.proposedCorrection.draft.summary).toBe(proposalSummary);
    expect(store.list().records.find((record:KnowledgeRecord)=>record.id===original.id)).toEqual(JSON.parse(JSON.stringify(original)));
  }finally{queue.close();store.close();}

  fs.writeFileSync(path.join(userData,'config.json'),JSON.stringify({locale:'zh-CN',themeId:'dark',workspace:work,activeWorkspaceId:workspaceId,workspaces:[{id:workspaceId,name:'更正审查验收',path:work}],openai:{baseUrl:'',apiKey:'',model:''},mcp:{enabled:false,servers:[]},memoryConsolidation:{enabled:false}}));
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),MUSTER_SANDBOX:'1',MUSTER_INSTANCE_ID:`correction-review-e2e-${process.pid}`,MUSTER_WEB_PORT:'0',APPDATA:path.join(fixture,'appdata'),LOCALAPPDATA:path.join(fixture,'localappdata'),HOME:home,USERPROFILE:home};
  for(const directory of [env.APPDATA,env.LOCALAPPDATA])fs.mkdirSync(directory,{recursive:true});
  for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','MUSTER_NO_SANDBOX','MUSTER_DEVTOOLS_PORT'])delete env[key];
  // Both Electron and the workbench sandbox resolve only this test's temporary profile.
  const bootstrap=path.join(fixture,'bootstrap.cjs');
  fs.writeFileSync(bootstrap,`const {app}=require('electron');app.setPath('appData',${JSON.stringify(env.APPDATA)});app.setPath('userData',${JSON.stringify(userData)});require(${JSON.stringify(path.join(project,'out/main/index.js'))});`);
  const app=await _electron.launch({executablePath:require('electron'),args:[bootstrap,'--disable-gpu','--disable-software-rasterizer','--in-process-gpu',...(process.env.MUSTER_E2E_CHROMIUM_SANDBOX==='1'?[]:['--no-sandbox'])],cwd:fixture,env,timeout:45000});
  try{
    const win=await app.firstWindow();await win.locator('.app-shell').waitFor({timeout:30000});
    await win.evaluate(async()=>(window as any).api.app.bootWait());
    await win.setViewportSize({width:1280,height:1000});
    const readSnapshot=():Promise<KnowledgeSnapshot>=>win.evaluate(async workspaceId=>(window as any).api.knowledge.list(workspaceId),workspaceId);
    const inspect=():Promise<MemoryCuratorQueuePage>=>win.evaluate(async workspaceId=>(window as any).api.memoryCurator.inspect(workspaceId,{state:'attention',visibility:'visible',offset:0,limit:30}),workspaceId);
    const before=await readSnapshot(),reviewBefore=(await inspect()).items.find(item=>item.id===requestId)!;
    expect(before.records.find(record=>record.id===original.id)).toEqual(JSON.parse(JSON.stringify(original)));
    expect(reviewBefore.state).toBe('done');expect(reviewBefore.result?.disposition).toBe('needs_user');
    expect(before.processing?.pending).toBe(0);expect(before.processing?.running).toBe(false);
    await win.getByText('记忆整理',{exact:true}).first().click();
    await win.getByRole('tab',{name:'整理记录',exact:true}).click();
    const processing=win.locator('#knowledge-panel-index');
    await expect(processing.getByRole('button',{name:'待关注',exact:true})).toHaveAttribute('aria-pressed','true');
    const review=processing.getByRole('article').filter({hasText:'记忆更正请求'});
    await expect(review.getByText('审查完成，待你处理',{exact:true})).toBeVisible();
    await expect(review.getByText(`原记忆：${original.id} · 提交时版本 r${original.revision}`,{exact:true})).toBeVisible();
    await expect(review.getByText('本次审查已结束，建议尚未应用。请打开原记忆，核对当前版本后自行修订或停止使用。',{exact:true})).toBeVisible();
    const proposal=review.getByRole('region',{name:'审查建议（尚未应用）'});
    await expect(proposal).toContainText(proposalSummary);
    await expect(review.getByText(JSON.stringify(correction),{exact:true})).toHaveCount(0);
    await expect(review.getByText('已更正并生效',{exact:true})).toHaveCount(0);
    await expect(review.getByText(/结果版本：/)).toHaveCount(0);
    expect((await readSnapshot()).records.find(record=>record.id===original.id)?.revision).toBe(original.revision);
    const screenshots=path.join(project,'.tmp/ui-captures/memory-correction-review');fs.mkdirSync(screenshots,{recursive:true});
    await proposal.scrollIntoViewIfNeeded();await win.screenshot({path:path.join(screenshots,'electron-review-not-applied.png')});

    // This is the actual center route and card editor, followed by the real revision IPC.
    await review.getByRole('button',{name:'打开原记忆',exact:true}).click();
    await expect(win.getByRole('tab',{name:'长期知识',exact:true})).toHaveAttribute('aria-selected','true');
    const entries=win.locator('#knowledge-panel-entries');
    const card=entries.getByRole('article',{name:originalSummary,exact:true});
    await expect(card.getByRole('heading',{name:originalSummary,exact:true})).toBeVisible();
    await expect(card).toContainText('用户已确认，自动整理不会覆盖此版本。');
    await card.getByRole('button',{name:'修订内容与条件',exact:true}).click();
    await card.getByLabel('记忆结论',{exact:true}).fill(savedSummary);
    await card.getByRole('button',{name:'保存并生效',exact:true}).click();
    await expect(entries.getByRole('heading',{name:savedSummary,exact:true})).toBeVisible();
    await expect(entries.getByRole('status')).toContainText(`已保存 r${original.revision+1} · 已生效`);
    const after=await readSnapshot(),saved=after.records.find(record=>record.id===original.id)!;
    expect(saved.summary).toBe(savedSummary);expect(saved.revision).toBe(original.revision+1);expect(saved.userManaged).toBe(true);
    expect(saved.status).toBe('active');expect(after.records).toHaveLength(1);
    await win.screenshot({path:path.join(screenshots,'electron-user-correction-saved.png')});

    const reviewAfter=(await inspect()).items.find(item=>item.id===requestId);
    expect(reviewAfter).toEqual(reviewBefore);
    await win.getByRole('tab',{name:'整理记录',exact:true}).click();
    await expect(processing.getByText('审查完成，待你处理',{exact:true})).toBeVisible();
    await expect(processing.getByRole('region',{name:'审查建议（尚未应用）'})).toContainText(proposalSummary);
    const runtime:MemoryCuratorSnapshot=await win.evaluate(async workspaceId=>(window as any).api.memoryCurator.state(workspaceId),workspaceId);
    expect(runtime.running).toBe(false);expect(runtime.pending).toBe(0);expect(runtime.messages).toEqual([]);
  }finally{await app.close();}
});
