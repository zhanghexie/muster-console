/**
 * 记忆重构 P2 写路径（memory-refactor B3）：溯源分类矩阵（§5）、凭证脱敏、
 * staging 写入门（判重/召回回路防护·还原即红）、转录摄入（种类门/污点走查/
 * 检查点防重放）、压缩前 flush（私有拷贝/超时不阻塞/配置解析/输出解析）、
 * 回合作用域证据面、工具面 catalog 注册。
 * 2026-10-26 F-01 起 MEMORY.md 直写门（directWrite/noteTools runMemoryRemember）
 * 已退役删除——remember 生产路径见 knowledgeTools.rememberKnowledge（类型化知识库
 * 候选，test/knowledge-tools.mjs / test/scheduler-memory-reach.mjs 守卫）。
 * Run: node test/memory-write-path.mjs
 * 全部落系统临时目录（mkdtemp），不触真模型（LLM 调用全注入 mock）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

// 本机 Node 构建缺 fts5（如 22.x 官方 win-x64）时 db 层建库即报 no such module: fts5，
// 属环境能力缺失而非回归——按仓库惯例打印原因后退出 0 跳过（详见 helpers/sqlite-fts5.mjs）。
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-write-path-'));
const compile = createSharedCompiler(root, tmp);

const provMod = await import(pathToFileURL(compile('main/memory/provenance.ts')).href);
const redactMod = await import(pathToFileURL(compile('main/memory/redact.ts')).href);
const stagingMod = await import(pathToFileURL(compile('main/memory/staging.ts')).href);
const ingestMod = await import(pathToFileURL(compile('main/memory/ingest.ts')).href);
const flushMod = await import(pathToFileURL(compile('main/memory/flush.ts')).href);
const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);
const turnScopeMod = await import(pathToFileURL(compile('main/agent/turnScope.ts')).href);
const flushCfgMod = await import(pathToFileURL(compile('shared/memoryFlush.ts')).href);
const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);

const {
  classifyOrigin,
  hasExplicitRememberInstruction,
  isPromotableSessionKind,
  isNetworkSourceTool
} = provMod;
const { redactCredentialShapes, REDACTED } = redactMod;
const { noteStaging, STAGING_CONSTANTS, transitionStaging } = stagingMod;
const { ingestTranscript, buildIngestCandidates, isInformativeAssertion, extractCandidateNote } = ingestMod;
const {
  runMemoryFlushTurn,
  parseFlushNotes,
  buildFlushConversation,
  createFetchFlushModelCall,
  FLUSH_CONSTANTS
} = flushMod;
const { openMemoryDb, insertChunk, recordRecallStat } = dbMod;
const {
  runAsNonUserTurn,
  currentTurnUserText,
  markTurnNetworkTaint,
  isCurrentTurnNetworkTainted
} = turnScopeMod;
const { MemoryService } = svcMod;

/* ---------------- 1. 溯源分类矩阵（§5） ---------------- */
{
  const base = {
    sessionKind: 'worker',
    latestUserTurnHasExplicitRemember: false,
    toolResultsTainted: false,
    writerSurface: 'worker'
  };
  assert.equal(classifyOrigin(base).origin, 'worker', 'worker 面 → worker');
  assert.equal(classifyOrigin({ ...base, sessionKind: 'scheduler', writerSurface: 'scheduler' }).origin, 'scheduler');
  assert.equal(
    classifyOrigin({ ...base, latestUserTurnHasExplicitRemember: true }).origin,
    'user',
    '明示记住且无污点 → user'
  );
  assert.equal(
    classifyOrigin({ ...base, latestUserTurnHasExplicitRemember: true, toolResultsTainted: true }).origin,
    'untrusted',
    '污点优先于明示记住（保守：外部内容推导不定 user）'
  );
  assert.equal(classifyOrigin({ ...base, toolResultsTainted: true }).origin, 'untrusted', '污点 → untrusted');
  for (const k of ['heartbeat', 'auto', 'headless']) {
    assert.equal(classifyOrigin({ ...base, sessionKind: k }).origin, 'system', `${k} → system`);
    assert.equal(isPromotableSessionKind(k), false, `${k} 不产生晋升候选`);
  }
  assert.equal(isPromotableSessionKind('worker'), true);
  assert.equal(isPromotableSessionKind('scheduler'), true);
  assert.equal(isPromotableSessionKind('chat'), true);
  assert.equal(isPromotableSessionKind(null), false, '未知种类保守拒收');
  assert.equal(isPromotableSessionKind(undefined), false);
  assert.equal(
    classifyOrigin({ sessionKind: 'chat', latestUserTurnHasExplicitRemember: false, toolResultsTainted: false, writerSurface: 'system' }).origin,
    'system',
    'chat 面无写入面证据 → 保守 system（永不默认 user）'
  );
  // reason 便于诊断
  assert.match(classifyOrigin({ ...base, toolResultsTainted: true }).reason, /污点|外部/);
  console.log('ok: 1 溯源分类矩阵');
}

/* ---------------- 2. 明示记住启发（zh/en/否定/裸「以后」） ---------------- */
{
  assert.equal(hasExplicitRememberInstruction('记住：部署用 npm 不用 pnpm'), true);
  assert.equal(hasExplicitRememberInstruction('请牢记这个结论'), true);
  assert.equal(hasExplicitRememberInstruction('别忘了先跑迁移'), true);
  assert.equal(hasExplicitRememberInstruction('以后要 先查 e2e'), true);
  assert.equal(hasExplicitRememberInstruction('以后记得提醒我复盘'), true);
  assert.equal(hasExplicitRememberInstruction('please remember to check the lockfile'), true);
  assert.equal(hasExplicitRememberInstruction('Keep in mind that the budget is 6000'), true);
  assert.equal(hasExplicitRememberInstruction("don't forget the regression test"), true);
  // 误伤面控制
  assert.equal(hasExplicitRememberInstruction('以后再说吧'), false, '裸「以后」不命中（非祈使形态）');
  assert.equal(hasExplicitRememberInstruction('这件事不要记住'), false, '否定先于肯定词剔除');
  assert.equal(hasExplicitRememberInstruction('把日志记下来看看'), false, '「记下来」属操作指令不进直写启发');
  // EN 否定/过去式/疑问防护（B3 评审 MINOR-1，照 zh lookbehind 先例）
  assert.equal(hasExplicitRememberInstruction("I don't remember the password"), false, "I don't remember 否定");
  assert.equal(hasExplicitRememberInstruction('I do not remember what we decided'), false, 'do not remember 否定');
  assert.equal(hasExplicitRememberInstruction("She can't remember the token"), false, "can't remember 否定");
  assert.equal(hasExplicitRememberInstruction('She remembered to commit yesterday'), false, '过去式 remembered 不算明示记住');
  assert.equal(hasExplicitRememberInstruction('do you remember the migration plan'), false, '疑问形不算');
  assert.equal(hasExplicitRememberInstruction('Did you remember to lock the door?'), false, '过去疑问形不算');
  // EN 正例不回退
  assert.equal(hasExplicitRememberInstruction('Remember to check the lockfile'), true);
  assert.equal(hasExplicitRememberInstruction('remember: the API limit is 100'), true);
  assert.equal(hasExplicitRememberInstruction('Please keep this in mind for future reviews'), true);
  // 「记一下」词表扩充（2026-09-22 用户真实措辞被误拒的回归；原 14 节退役后收口于此）
  assert.equal(hasExplicitRememberInstruction('记一下我喜欢简洁明了、结论先行的风格'), true, '「记一下…」算明示记住');
  assert.equal(hasExplicitRememberInstruction('不要记一下这个'), false, '否定 lookbehind 同样罩住记一下');
  assert.equal(hasExplicitRememberInstruction('帮我 runtests'), false);
  assert.equal(hasExplicitRememberInstruction(''), false);
  assert.equal(hasExplicitRememberInstruction(null), false);
  console.log('ok: 2 明示记住启发');
}

/* ---------------- 3. 网络来源工具污点面 ---------------- */
{
  assert.equal(isNetworkSourceTool('web.fetch'), true);
  assert.equal(isNetworkSourceTool('host.github.run'), true, 'GitHub descriptions and comments are external data');
  assert.equal(isNetworkSourceTool('apps.run'), true, '持久应用内容不能变成可信用户记忆来源');
  assert.equal(isNetworkSourceTool('apps_run'), true, '模型下划线入口同样保留外部来源边界');
  for (const name of ['host.apps.run', 'host_apps_run', 'host.browser.run', 'host_browser_run',
    'host.web.fetch', 'host_web_fetch', 'host.terminal.capture', 'host_terminal_getStatus',
    'host.mcp.call', 'host_mcp_search', 'desktop.list', 'host.desktop.list', 'host_desktop_list', 'desktop.look', 'host_desktop_look']) {
    assert.equal(isNetworkSourceTool(name), true, `${name} must retain untrusted provenance`);
  }
  assert.equal(isNetworkSourceTool('browser.tabs'), true);
  assert.equal(isNetworkSourceTool('browser.navigate'), true);
  assert.equal(isNetworkSourceTool('terminal.capture'), true);
  assert.equal(isNetworkSourceTool('terminal.getStatus'), true);
  assert.equal(isNetworkSourceTool('mcp__feishu__search'), true, '外部 MCP 前缀整组污点');
  // 控制面不是内容面
  assert.equal(isNetworkSourceTool('terminal.write'), false);
  assert.equal(isNetworkSourceTool('terminal.open'), false);
  assert.equal(isNetworkSourceTool('memory.note'), false);
  assert.equal(isNetworkSourceTool('sessions.observe'), false);
  assert.equal(isNetworkSourceTool('host.sessions.observe'), false);
  assert.equal(isNetworkSourceTool('host.terminal.write'), false);
  // MCP 名下划线归一（shell API 侧 mcp__x__y 与点名等价）
  assert.equal(isNetworkSourceTool('mcp__x__y'), true);
  console.log('ok: 3 网络来源工具污点面');
}

/* ---------------- 4. 凭证脱敏（保守优先） ---------------- */
{
  const r1 = redactCredentialShapes('部署脚本里 apiKey=sk-abcd1234efgh5678 记得保密');
  assert.equal(r1.text, `部署脚本里 apiKey=${REDACTED} 记得保密`);
  assert.ok(r1.hits.includes('assignment') || r1.hits.includes('openai-key'));
  const r2 = redactCredentialShapes('Header 用 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi');
  assert.ok(!r2.text.includes('eyJhbGciOiJIUzI1NiJ9'), 'Bearer/JWT 遮蔽');
  const r3 = redactCredentialShapes('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----');
  assert.equal(r3.text.includes('MIIEow'), false, '私钥块整块遮蔽');
  const r4 = redactCredentialShapes('仓库地址 https://ci:Hunter2Pass@repo.internal/x.git 拉代码');
  assert.ok(!r4.text.includes('Hunter2Pass'), 'URL 内嵌凭据遮蔽');
  assert.ok(r4.text.includes('repo.internal'), 'URL 其余部分保留');
  const r5 = redactCredentialShapes('github token ghp_' + 'a'.repeat(30) + ' 泄漏了');
  assert.ok(!r5.text.includes('ghp_'), '知名前缀 token 遮蔽');
  // 无凭证文本原样
  assert.equal(redactCredentialShapes('今天修好了 junction 删除bug。').text, '今天修好了 junction 删除bug。');
  console.log('ok: 4 凭证脱敏');
}

/* ---------------- 5. noteStaging 写入门（去重 + 召回回路防护·还原即红） ---------------- */
const wsA = path.join(tmp, 'ws-a');
{
  const db = openMemoryDb(wsA);
  // 基础落库
  const r1 = noteStaging(db, { text: '部署必须用 npm：pnpm 被 packageManager 字段挡下。', origin: 'worker', sessionKind: 'worker' });
  assert.equal(r1.ok, true, '正常候选落 pending');
  const row = db.handle.prepare('SELECT * FROM staging WHERE id = ?').get(r1.stagingId);
  assert.equal(row.state, 'pending');
  assert.equal(row.origin, 'worker');
  assert.equal(row.session_kind, 'worker');
  assert.ok(JSON.parse(row.signals_json).dupChecked, 'signals 记录判重扫描');

  // 空文本 / 超长
  assert.equal(noteStaging(db, { text: '   ', origin: 'worker', sessionKind: 'worker' }).reason, 'empty');
  assert.equal(
    noteStaging(db, { text: 'x'.repeat(STAGING_CONSTANTS.TEXT_MAX_CHARS + 1), origin: 'worker', sessionKind: 'worker' }).reason,
    'too_long'
  );

  // 种类门（§5）
  for (const kind of ['heartbeat', 'auto', 'headless']) {
    const rr = noteStaging(db, { text: `种类门测试 ${kind}`, origin: 'system', sessionKind: kind });
    assert.equal(rr.ok, false);
    assert.equal(rr.reason, 'session_kind_gate', `${kind} 候选拒收`);
  }

  // 精确判重（对 staging / chunk）
  const rr2 = noteStaging(db, { text: '部署必须用 npm：pnpm 被 packageManager 字段挡下。', origin: 'worker', sessionKind: 'worker' });
  assert.equal(rr2.reason, 'duplicate_exact', '与既有 staging 精确重复拒收');
  const chunkId = insertChunk(db, { sourceType: 'memory', sourcePath: 'docs/memory/MEMORY.md', text: '上下文窗口压缩后会丢细节，压缩前要 flush。', origin: 'system' });
  const rr3 = noteStaging(db, { text: '上下文窗口压缩后会丢细节，压缩前要 flush。', origin: 'worker', sessionKind: 'worker' });
  assert.equal(rr3.reason, 'duplicate_exact', '与既有 chunk 精确重复拒收');

  // 高重叠判重（对 chunk；Jaccard ≥ 0.75）
  const rr4 = noteStaging(db, { text: '上下文窗口压缩后会丢细节，压缩前要先 flush 冲刷。', origin: 'worker', sessionKind: 'worker' });
  assert.equal(rr4.reason, 'duplicate_overlap', '与既有 chunk 高重叠拒收');

  // —— 召回回路防护（§5·还原即红）——
  // 构造一个与被注入 chunk 相似度落在 [RECALL_LOOP, DUPLICATE) 带内的候选
  // （实测 Jaccard≈0.71）：无召回记录应入库（对照），有召回记录则拒收——
  // 若删掉 recall_loop 检查（还原），该候选将穿过 duplicate_overlap 门直接入库。
  const recalledText = '嵌套仓容器里 git 会把内层仓当 untracked 处理，必须写主仓 info/exclude 才不恒脏。';
  const recalledChunk = insertChunk(db, { sourceType: 'memory', sourcePath: 'docs/memory/MEMORY.md', text: recalledText, origin: 'system' });
  const bandCandidate = '嵌套容器里 git 把内层仓当 untracked 处理，要写主仓 info/exclude 才不恒脏。';
  // 对照①：无召回记录 → 该带候选正常入库（证明 duplicate_overlap 门不拦这个相似度）
  const ctl = noteStaging(db, { text: bandCandidate, origin: 'worker', sessionKind: 'worker' });
  assert.equal(ctl.ok, true, '对照：同相似带、无召回记录的候选正常入库（还原即红的对照面）');
  // B4 起 staging 落库同步建镜像 chunk——对照清理走正规生命周期迁移（连镜像 chunk
  // 一起退场；原裸 DELETE 会留下镜像 chunk，让后续 recall_loop 用例误中 duplicate_exact）
  transitionStaging(db, ctl.stagingId, 'rejected');
  // 命中：给该 chunk 落召回账（任意 kind——brief_injected/search_hit 均算「注入过」）
  recordRecallStat(db, recalledChunk, 'search_hit', '嵌套仓 恒脏', Date.now());
  const rl = noteStaging(db, { text: bandCandidate, origin: 'worker', sessionKind: 'worker' });
  assert.equal(rl.ok, false, '同候选在 chunk 被注入后拒收（还原即红：删掉 recall_loop 检查即转绿入库）');
  assert.equal(rl.reason, 'recall_loop');
  assert.match(rl.detail, /chunk#\d+.*search_hit/);
  db.close();
  console.log('ok: 5 noteStaging 写入门（判重+召回回路防护）');
}

/* ---------------- 6. MemoryService.noteStaging（运行时入口） ---------------- */
{
  const svc = new MemoryService();
  const r = svc.noteStaging(wsA, { text: '调度简报注入要控制预算在四千字符以内。', origin: 'scheduler', sessionKind: 'scheduler', taskId: 'task-7' });
  assert.equal(r.ok, true);
  const row = svc.db(wsA).handle.prepare('SELECT task_id FROM staging WHERE id = ?').get(r.stagingId);
  assert.equal(row.task_id, 'task-7', '溯源字段透传');
  svc.closeAll();
  console.log('ok: 6 service.noteStaging');
}

/* ---------------- 7. 转录摄入：候选启发 + 污点走查 + 脱敏 ---------------- */
{
  // 候选启发
  assert.equal(isInformativeAssertion('user', '记住：验收前必须跑 e2e 回归。'), true, '明示记住恒候选');
  assert.equal(isInformativeAssertion('user', '跑一下测试'), false, '短指令非断言');
  assert.equal(isInformativeAssertion('user', '为什么这里要这么排？'), false, '纯疑问非断言');
  assert.equal(isInformativeAssertion('assistant', '根因是 Windows junction 穿透删除，修复方案是删除前先 lstat 判型。'), true);
  assert.equal(isInformativeAssertion('assistant', '好的，我继续。'), false, '短应答无信息量');
  assert.equal(
    extractCandidateNote('assistant', '我会先运行测试。\n结论：发布前必须用 npm run typecheck 核对三个配置。\n下面是很长的执行日志。'),
    '结论：发布前必须用 npm run typecheck 核对三个配置。',
    '会话过程不应整段进入暂存池'
  );
  assert.equal(extractCandidateNote('assistant', '我先查文件。\n接下来运行命令。'), null, '只有操作进展时不产出候选');

  const mk = (id, role, parts, source) => ({ id, role, parts, ...(source ? { source } : {}) });
  const msgs = [
    mk('m1', 'user', [{ kind: 'text', text: '帮我看下打包超时的问题' }]),
    mk('m2', 'assistant', [
      { kind: 'tool', toolName: 'web.fetch' },
      { kind: 'text', text: '根因是 winCodeSign 拉取超时，结论是配置镜像源后打包恢复正常，注意要用 hf-mirror。' }
    ]),
    // ↑ 该 assistant 前有网络工具 → tainted（其自身候选 untrusted）
    mk('m3', 'user', [{ kind: 'text', text: '记住：打包镜像统一走内网 mirror。' }], 'scheduler'),
    // ↑ 调度注入（简报）：召回标记剔除，且不清污
    mk('m4', 'assistant', [{ kind: 'text', text: '决定：部署脚本统一用 npm，因为 pnpm 会被 packageManager 字段拦截。' }]),
    // ↑ 仍处污点内（m3 是注入不是用户输入）
    mk('m5', 'user', [{ kind: 'text', text: '好的，另外终端 token=sk-abcdef1234567890 泄漏过要换。' }]),
    // ↑ 用户真输入：清污 + 明示凭证内容（脱敏命中）
    mk('m6', 'assistant', [{ kind: 'text', text: '结论：凭据轮换已完成，行为约束是密钥今后只进环境变量、绝不进代码或文档。' }])
  ];
  const drafts = buildIngestCandidates(msgs);
  assert.equal(drafts.length, 4, 'm2/m4/m5/m6 四条候选（m1 非断言、m3 注入剔除）');
  assert.equal(drafts.some((d) => d.messageId === 'm3'), false, '调度注入不提取（召回回路防护）');
  const m2 = drafts.find((d) => d.messageId === 'm2');
  assert.equal(m2.tainted, true, '网络工具后的 assistant 污点');
  const m4 = drafts.find((d) => d.messageId === 'm4');
  assert.equal(m4.tainted, true, '注入消息不清污（仍污点内）');
  const m5 = drafts.find((d) => d.messageId === 'm5');
  assert.equal(m5.tainted, false, '用户真输入清污');
  assert.ok(!m5.text.includes('sk-abcdef1234567890'), '候选脱敏命中');
  assert.ok(m5.redactionHits.length > 0);
  const m6 = drafts.find((d) => d.messageId === 'm6');
  assert.equal(m6.tainted, false);
  console.log('ok: 7 摄入候选启发 + 污点走查 + 脱敏');
}

/* ---------------- 8. 转录摄入：种类门 + 检查点防重放 ---------------- */
const wsB = path.join(tmp, 'ws-b');
{
  const db = openMemoryDb(wsB);
  const msgs = [
    { id: 'm1', role: 'user', parts: [{ kind: 'text', text: '帮我看下打包超时的问题' }] },
    { id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: '根因是 winCodeSign 拉取超时，结论是配置镜像源后打包恢复正常。' }] }
  ];
  // 种类门：auto（cron 会话）整批拒收且不写检查点
  const g = ingestTranscript(db, { sessionId: 'sess-auto', sessionKind: 'auto', writerSurface: 'worker', messages: msgs });
  assert.equal(g.skipped, 'session_kind_gate');
  assert.equal(g.added, 0);
  // worker 正常摄入
  const r1 = ingestTranscript(db, { sessionId: 'sess-1', sessionKind: 'worker', writerSurface: 'worker', messages: msgs });
  assert.equal(r1.ok, true);
  assert.equal(r1.added, 1, 'm2 一条候选入库（m1 非断言）');
  const origin1 = db.handle.prepare('SELECT origin FROM staging').get();
  assert.equal(origin1.origin, 'worker');
  // 检查点防重放：同消息重放 → 跳过
  const r2 = ingestTranscript(db, { sessionId: 'sess-1', sessionKind: 'worker', writerSurface: 'worker', messages: msgs });
  assert.equal(r2.skipped, 'checkpoint_replay');
  assert.equal(r2.added, 0);
  // 增量：消息变多 → 只看新窗口
  const msgs2 = [
    ...msgs,
    { id: 'm3', role: 'user', parts: [{ kind: 'text', text: '好的，收敛一下结论。' }] },
    { id: 'm4', role: 'assistant', parts: [{ kind: 'text', text: '结论：winCodeSign 超时走镜像源可解，注意公司内网 mirror 域名。' }] }
  ];
  const r3 = ingestTranscript(db, { sessionId: 'sess-1', sessionKind: 'worker', writerSurface: 'worker', messages: msgs2 });
  assert.equal(r3.examined, 2, '增量窗口=检查点之后两条');
  assert.equal(r3.added, 1);
  db.close();
  console.log('ok: 8 摄入种类门 + 检查点防重放');
}

/* ---------------- 9. flush：配置解析 + 对话拷贝 + 输出解析 ---------------- */
{
  const { resolveFlushTarget, normalizeMemoryFlushConfig } = flushCfgMod;
  // 模型配置解析：专用配置优先；缺省跟随调度当前模型
  const sched = { providerId: 'zhipu', modelId: 'glm-5.3' };
  assert.deepEqual(resolveFlushTarget(undefined, sched), sched, '未配置→跟随调度当前模型');
  assert.deepEqual(
    resolveFlushTarget({ providerId: 'openai', modelId: 'gpt-4o-mini' }, sched),
    { providerId: 'openai', modelId: 'gpt-4o-mini' },
    '专用配置优先'
  );
  assert.deepEqual(resolveFlushTarget({ providerId: '  ' }, sched), { providerId: 'zhipu', modelId: 'glm-5.3' }, '空白串视为未配置');
  assert.equal(normalizeMemoryFlushConfig(undefined).enabled, true, '缺省开');
  assert.equal(normalizeMemoryFlushConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeMemoryFlushConfig('garbage').enabled, true, '非法输入回默认');

  // 对话拷贝：脱敏 + 截断保尾
  const conv = buildFlushConversation([
    { role: 'user', text: 'token=sk-abcdefgh12345678 贴给你看' },
    { role: 'assistant', text: '收到。' }
  ]);
  assert.ok(!conv.includes('sk-abcdefgh12345678'), '拷贝发送前脱敏');
  const long = buildFlushConversation(
    Array.from({ length: 500 }, (_, i) => ({ role: 'user', text: `消息 ${i} `.repeat(20) }))
  );
  assert.ok(long.length <= FLUSH_CONSTANTS.MAX_CONVERSATION_CHARS + 50, '超长截断');
  assert.match(long, /前文截断/, '截断标注');

  // 输出解析
  assert.deepEqual(parseFlushNotes('["笔记A","笔记B"]'), ['笔记A', '笔记B']);
  assert.deepEqual(parseFlushNotes('```json\n["围栏笔记"]\n```'), ['围栏笔记']);
  assert.deepEqual(parseFlushNotes('前面有废话 ["只要数组"] 后面也有'), ['只要数组'], '容忍围栏外杂文');
  assert.equal(parseFlushNotes('["A","A"]').length, 1, '输出内去重');
  assert.deepEqual(parseFlushNotes('[]'), [], '空数组合法（runMemoryFlushTurn 按 empty_output 跳过）');
  assert.equal(parseFlushNotes('不是 JSON'), null);
  assert.equal(parseFlushNotes(null), null);
  console.log('ok: 9 flush 配置/拷贝/输出解析');
}

/* ---------------- 10. flush 静默回合：私有拷贝/失败不阻塞/超时 ---------------- */
const wsC = path.join(tmp, 'ws-c');
{
  const svc = new MemoryService();
  const notes = [];
  const mkSink = (arr) => (text) => {
    const r = svc.noteStaging(wsC, { text, origin: 'scheduler', sessionKind: 'scheduler', signals: { source: 'flush' } });
    if (r.ok) arr.push(r.stagingId);
    return r;
  };
  const fourMsgs = [
    { role: 'user', text: '任务一：修打包超时' },
    { role: 'assistant', text: '根因是 winCodeSign 拉取超时。' },
    { role: 'user', text: '继续' },
    { role: 'assistant', text: '决定：配置内网镜像后解决，注意镜像域名要进白名单。' }
  ];
  // 正常路径：模型输出 JSON 数组 → 全走 noteStaging 通道
  const ok1 = await runMemoryFlushTurn({
    messages: fourMsgs,
    callModel: async () => '["打包超时走内网镜像可解","镜像域名要进白名单"]',
    note: mkSink(notes)
  });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.notesAdded, 2);
  assert.equal(notes.length, 2);
  const sig = svc.db(wsC).handle.prepare('SELECT signals_json FROM staging WHERE id = ?').get(notes[0]);
  assert.equal(JSON.parse(sig.signals_json).source, 'flush', 'flush 产物带 source=flush 溯源');

  // 私有拷贝不污染主转录：输入数组冻结（runMemoryFlushTurn 不得改动输入）
  const frozenInput = Object.freeze([...fourMsgs]);
  await runMemoryFlushTurn({ messages: frozenInput, callModel: async () => '[]', note: mkSink(notes) });
  assert.deepEqual(frozenInput, fourMsgs, 'flush 回合不改私有拷贝（主转录不受影响）');

  // 太短对话跳过
  const short = await runMemoryFlushTurn({
    messages: [{ role: 'user', text: 'hi' }],
    callModel: async () => {
      throw new Error('不应调用模型');
    },
    note: mkSink(notes)
  });
  assert.equal(short.skipped, 'too_few_messages');

  // 模型失败 → ok:false 不抛（失败不阻塞压缩）
  const fail = await runMemoryFlushTurn({
    messages: fourMsgs,
    callModel: async () => {
      throw new Error('boom');
    },
    note: mkSink(notes)
  });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /boom/);

  // 超时 → ok:false（内部竞速，压缩继续）
  const slow = await runMemoryFlushTurn({
    messages: fourMsgs,
    callModel: () => new Promise(() => {}),
    note: mkSink(notes),
    timeoutMs: 50
  });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /超时/);

  // 模型输出重复（已被 staging 收录）→ 通道拒收计数不算失败
  const dup = await runMemoryFlushTurn({
    messages: fourMsgs,
    callModel: async () => '["打包超时走内网镜像可解"]',
    note: mkSink(notes)
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.notesAdded, 0);
  assert.equal(
    (dup.notesRejected.duplicate_overlap ?? 0) + (dup.notesRejected.duplicate_exact ?? 0) >= 1,
    true,
    '判重拒收被计数'
  );
  svc.closeAll();

  // 缺省传输层：mock fetch（completions / responses 两协议）
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["传输层笔记"]' } }] }),
      text: async () => ''
    };
  };
  const call = createFetchFlushModelCall({ baseUrl: 'https://llm.example/v1', apiKey: 'k', modelId: 'glm-5.3', fetchImpl: mockFetch });
  assert.equal(await call({ system: 'sys', user: 'usr' }), '["传输层笔记"]');
  assert.match(calls[0].url, /chat\/completions$/);
  assert.equal(calls[0].body.messages[0].role, 'system');
  const callResp = createFetchFlushModelCall({ baseUrl: 'https://llm.example', apiKey: 'k', modelId: 'm', api: 'openai-responses', fetchImpl: mockFetch });
  await callResp({ system: 's', user: 'u' });
  assert.match(calls[1].url, /\/responses$/);
  console.log('ok: 10 flush 静默回合');
}

/* ---------------- 11. 回合作用域证据面（直写门退役后仅存作用域原语守卫） ----------------
 * （原 11/12 节直写门与 noteTools handler 级用例随 F-01 退役删除：
 *  runMemoryRemember/runMemoryNote 生产面已由 knowledgeTools.note/rememberKnowledge
 *  （类型化知识库候选）取代，守卫见 test/knowledge-tools.mjs；明示/污点/无头拒绝、
 *  remember 可达注入/召回见 test/scheduler-memory-reach.mjs。） */
{
  runAsNonUserTurn(() => {
    assert.equal(currentTurnUserText(), undefined, '非用户回合无用户证据面（≠空串）');
    markTurnNetworkTaint();
    assert.equal(isCurrentTurnNetworkTainted(), true, '非用户回合污点跟踪保留');
  });
  console.log('ok: 11 回合作用域证据面');
}

/* ---------------- 13. catalog 注册与参数（还原即红：删注册即转红） ---------------- */
{
  const noteDef = catalog.getToolDef('memory.note');
  const rememberDef = catalog.getToolDef('memory.remember');
  assert.ok(noteDef, 'memory.note 已注册');
  assert.ok(rememberDef, 'memory.remember 已注册');
  assert.equal(noteDef.dangerous, false, 'note 免审（落候选，非破坏性）');
  assert.equal(rememberDef.dangerous, false, 'remember 不走 dangerous 门（宿主明示守卫已把关口）');
  assert.deepEqual(noteDef.parameters.required, ['text','searchKeys']);
  assert.deepEqual(rememberDef.parameters.required, ['text','searchKeys']);
  // 版本随新工具 bump（≥1.39）
  const [maj, min] = catalog.CATALOG_VERSION.split('.').map(Number);
  assert.ok(maj > 1 || min >= 39, `catalog 版本随 B3 新工具 bump（≥1.39，当前 ${catalog.CATALOG_VERSION}）`);
  // B8/F-01 退役：memory.append/memory.remove/scheduler.memory.write 下线
  for (const name of ['memory.search', 'memory.list', 'memory.note', 'memory.remember']) {
    assert.ok(catalog.getToolDef(name), `${name} 仍在册`);
  }
  assert.equal(catalog.getToolDef('scheduler.memory.write'), undefined, 'scheduler.memory.write 已退役');
  // PTY Worker 可提交候选；明确保存仅 GUI 开放，并受上方真实用户原话守卫约束。
  assert.equal(catalog.WORKER_TOOL_ALLOWLIST.includes('memory.note'), true);
  assert.equal(catalog.WORKER_TOOL_ALLOWLIST.includes('memory.remember'), false);
  console.log('ok: 13 catalog 注册');
}

console.log(`memory-write-path(B3): ok (tmp=${tmp})`);
