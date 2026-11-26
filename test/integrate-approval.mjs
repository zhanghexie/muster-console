import ts from 'typescript';
/**
 * sessions.integrate：保留 legacy required/auto 留痕，合入统一由共享业务门授权。
 * 自查：跳过服务授权或让 approval=auto 绕过业务门，本文件应转红。
 * Run: node test/integrate-approval.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-approval-'));
const compile = createSharedCompiler(root, tmp);

const {
  resolveIntegrateApproval,
  shouldSkipIntegrateConfirm,
  shouldNotifyUserOnIntegrateFail,
  integrateAutoAcceptanceNote,
  buildIntegrateAutoApprovalTrace,
  buildIntegrateFailNotify,
  buildIntegrateFailNotifyPush,
  clipIntegrateFailReason,
  INTEGRATE_AUTO_ACCEPTANCE_NOTE,
  INTEGRATE_FAIL_UPDATE_KEY_PREFIX
} = await import(pathToFileURL(compile('shared/integrateApproval.ts')).href);

{
  assert.equal(resolveIntegrateApproval(undefined), 'required');
  assert.equal(resolveIntegrateApproval(null), 'required');
  assert.equal(resolveIntegrateApproval(''), 'required');
  assert.equal(resolveIntegrateApproval('required'), 'required');
  assert.equal(resolveIntegrateApproval('auto'), 'auto');
  assert.equal(resolveIntegrateApproval('Auto'), 'required', '大小写变体不得免批');
  assert.equal(resolveIntegrateApproval(true), 'required');
  assert.equal(resolveIntegrateApproval({ approval: 'auto' }), 'required');
}

{
  assert.equal(shouldSkipIntegrateConfirm('sessions.integrate', { approval: 'auto' }), true);
  assert.equal(shouldSkipIntegrateConfirm('sessions.integrate', {}), false);
  assert.equal(shouldSkipIntegrateConfirm('sessions.integrate', { approval: 'required' }), false);
  assert.equal(shouldSkipIntegrateConfirm('sessions.integrate', { approval: 'AUTO' }), false);
  assert.equal(
    shouldSkipIntegrateConfirm('sessions.review', { approval: 'auto' }),
    false,
    'review 不吃 auto'
  );
  assert.equal(shouldSkipIntegrateConfirm('sessions.delete', { approval: 'auto' }), false);
  assert.equal(shouldSkipIntegrateConfirm('sessions.integrate', null), false);
}

{
  assert.equal(integrateAutoAcceptanceNote(), INTEGRATE_AUTO_ACCEPTANCE_NOTE);
  assert.equal(integrateAutoAcceptanceNote('  样式微调  '), 'approval=auto: 样式微调');
  assert.match(INTEGRATE_AUTO_ACCEPTANCE_NOTE, /^approval=auto$/);
}

{
  const base = buildIntegrateAutoApprovalTrace({
    sessionName: '修登录',
    sessionId: 'sess-1',
    target: 'main'
  });
  assert.equal(base.label, '免审批合入');
  assert.match(base.text, /修登录/);
  assert.match(base.text, /main/);
  assert.equal(base.updateKey, 'integrate-auto:sess-1');

  const noted = buildIntegrateAutoApprovalTrace({
    sessionName: '修登录',
    sessionId: 'sess-1',
    note: '样式微调，无 IPC 变化'
  });
  assert.match(noted.text, /样式微调，无 IPC 变化/);

  const anon = buildIntegrateAutoApprovalTrace({});
  assert.ok(!anon.updateKey);
  assert.match(anon.text, /会话/);
}

{
  const { buildIntegrateRequestMessage } = await import(
    pathToFileURL(compile('shared/integrateRequest.ts')).href
  );
  const msg = buildIntegrateRequestMessage({
    sessionId: 'id-1',
    sessionName: '修登录',
    branch: 'ao/id-1'
  });
  assert.match(msg, /approval=auto/);
  assert.match(msg, /required/);
  assert.match(msg, /sessions_integrate/);
}

{
  const { buildDefaultDispatcherAppendBody } = await import(
    pathToFileURL(compile('main/agent/systemPrompt.ts')).href
  );
  const body = buildDefaultDispatcherAppendBody();
  assert.match(body, /approval='auto'/);
  assert.match(body, /approval defaults to required/);
  assert.match(body, /product shape\/data flow\/IPC contracts/);
  assert.doesNotMatch(body, /立刻 sessions_integrate（sessionId 在通知里），会弹确认/);
}

{
  const executorSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'capabilities', 'executor.ts'),
    'utf8'
  );
  assert.match(executorSrc, /shouldSkipIntegrateConfirm/, '确认门必须走共享判定，禁止另写 if');
  assert.match(executorSrc, /skipIntegrateConfirm/, 'legacy auto still identifies desktop trace behavior');
  assert.match(executorSrc, /emitIntegrateAutoApprovalTrace/, '成功后必须留桌面通知');
  // Execute the actual service entry: legacy auto controls tracing, never business authorization.
  const source = ts.createSourceFile('sessions.ts', fs.readFileSync(path.join(root,'src/main/sessions.ts'),'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='SessionsService');
  const method = declaration.members.find(node=>node.name?.getText(source)==='integrateWorktree');
  const emitted = ts.transpileModule(`class Gate { ${method.getText(source)} }; exports.Gate=Gate;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  let effects=0, reviews=0, allowed=false;
  const exports={};new Function('exports','integrateSessionWorktree','usesTaskWorktreeLifecycle','beginTaskWorktreeOperation','createSafetyGitEvidenceCollector',emitted)(exports,async()=>{effects++;return {merged:true};},()=>false,()=>({release(){}}),()=>({capture(){},finish:()=>({}),clear(){}}));
  const gate=new exports.Gate();gate.config={};gate.get=()=>({id:'s',workspaceId:'ws'});gate.integrateCtx=()=>({});gate.approvalSnapshot=async()=> 'current actual repository evidence';
  gate.businessApproval=async()=>{reviews++;return allowed;};
  for(const approval of ['auto','required',undefined]) await assert.rejects(gate.integrateWorktree('s',{approval}),/approval denied/);
  assert.equal(effects,0,'no merge before shared host approval, including approval=auto');assert.equal(reviews,3);
  allowed=true;await gate.integrateWorktree('s',{approval:'auto'});assert.equal(effects,1);assert.equal(reviews,4);

}

{
  assert.equal(shouldNotifyUserOnIntegrateFail('sessions.integrate', { approval: 'auto' }), false);
  assert.equal(shouldNotifyUserOnIntegrateFail('sessions.integrate', {}), true);
  assert.equal(shouldNotifyUserOnIntegrateFail('sessions.integrate', { approval: 'required' }), true);
  assert.equal(shouldNotifyUserOnIntegrateFail('sessions.review'), true);
  assert.equal(shouldNotifyUserOnIntegrateFail('sessions.requestIntegrate'), true);
  assert.equal(shouldNotifyUserOnIntegrateFail('sessions.delete'), false);
}

{
  const fail = buildIntegrateFailNotify({
    sessionName: '修登录',
    sessionId: 'sess-1',
    reason: '主仓 2 个文件未提交挡住合入：a.ts、b.ts'
  });
  assert.equal(fail.label, '合入失败');
  assert.equal(fail.kind, 'error');
  assert.match(fail.text, /修登录/);
  assert.match(fail.text, /主仓 2 个文件/);
  assert.equal(fail.updateKey, `${INTEGRATE_FAIL_UPDATE_KEY_PREFIX}sess-1`);

  const push = buildIntegrateFailNotifyPush({
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    sessionName: '修登录',
    reason: '主仓脏文件挡住合入'
  });
  assert.equal(push.toast, true);
  assert.equal(push.update, true);
  assert.equal(push.kind, 'error');
  assert.equal(push.workspaceId, 'ws-1');
  assert.match(push.text, /主仓脏文件挡住合入/);

  const long = 'x'.repeat(900);
  assert.ok(clipIntegrateFailReason(long).endsWith('…'));
  assert.ok(clipIntegrateFailReason(long).length <= 801);
}

{
  const hostSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'capabilities', 'hosts', 'sessions.ts'),
    'utf8'
  );
  assert.match(hostSrc, /shouldNotifyUserOnIntegrateFail\('sessions.integrate'/);
  assert.match(hostSrc, /shouldNotifyUserOnIntegrateFail\('sessions.review'/);
  assert.match(hostSrc, /shouldNotifyUserOnIntegrateFail\('sessions.requestIntegrate'/);
  assert.match(hostSrc, /notifyUserOnFail/);
  assert.match(hostSrc, /notifyUserIntegrateFail/);

  // 2026-09-26 sessions.ts 拆分：integrateWorktree 实现在 git/worktreeIntegrate.ts——守卫随代码走
  const sessionsSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'git', 'worktreeIntegrate.ts'),
    'utf8'
  );
  assert.match(sessionsSrc, /notifyUserOnFail/);
  assert.match(sessionsSrc, /notifyIntegrateFail/);
  assert.match(sessionsSrc, /buildIntegrateFailNotifyPush/);
  assert.match(
    sessionsSrc,
    /notifyIntegrateFail\(ctx, s, merge\.message, opts\?\.notifyUserOnFail\)/,
    '单仓合入失败必须按旗标弹 toast'
  );

  const mergeSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'git', 'mergeIsolate.ts'),
    'utf8'
  );
  assert.match(mergeSrc, /\.\.\.overlap/, 'stashMain 必须带重叠 pathspec，禁止空 --');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] integrate-approval');
