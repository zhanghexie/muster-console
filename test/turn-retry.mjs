/**
 * 调度回合级自动重试判定（turnRetry.ts）回归测试。
 * 背景：本机跑重测试链时 LLM SSE 流整窗被掐（实测报错
 * 「OpenAI Responses stream ended before a terminal response event」usage=0），
 * 回合失败后需按瞬态判定延时重发；确定性错误（401/402 等）不得重试。
 * 运行: node test/turn-retry.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-retry-compile-'));
const compile = createSharedCompiler(root, compileTmp);
const entry = compile('main/agent/turnRetry.ts');
const {
  isTransientProviderError,
  isNetworkTurnError,
  isStickySessionError,
  locateRetryableTurn,
  planOrchestratorTurnClose,
  planGuiTurnRetry,
  guiTurnHasProgress,
  guiTurnRetryDelayMs,
  normalizeGuiTurnRetryConfig,
  GUI_TURN_RETRY_DEFAULTS,
  TURN_AUTO_RETRY_MAX,
  turnAutoRetryDelayMs
} = await import(pathToFileURL(entry).href);

try {
  // ---------------------------------------------- 瞬态判定：实测发生过的报错必须命中
  const transient = [
    'OpenAI Responses stream ended before a terminal response event',
    'OpenAI Responses stream ended without a stop reason',
    'Request timed out.',
    'fetch failed',
    'socket hang up',
    'other side closed',
    'upstream connect error or disconnect/reset before headers',
    'Network Error',
    'WebSocket closed with code 1006',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'connect ETIMEDOUT 1.2.3.4:443',
    '[unknown] [aborted] read ECONNRESET'
  ];
  for (const msg of transient) {
    assert.equal(isTransientProviderError(msg), true, `应判定瞬态: ${msg}`);
  }

  // ---------------------------------------------- 确定性错误：不得重试
  const deterministic = [
    'HTTP 402: Insufficient Balance',
    'Error Code 401: invalid api key',
    'invalid_request_error: context length exceeded',
    'incomplete: max_output_tokens',
    ''
  ];
  for (const msg of deterministic) {
    assert.equal(isTransientProviderError(msg), false, `应判定非瞬态: ${msg}`);
  }
  assert.equal(isTransientProviderError(undefined), false);
  assert.equal(isTransientProviderError(null), false);

  // ---------------------------------------------- 重试节奏：30s 翻倍封顶 2 分钟
  assert.equal(turnAutoRetryDelayMs(1), 30_000);
  assert.equal(turnAutoRetryDelayMs(2), 60_000);
  assert.equal(turnAutoRetryDelayMs(3), 120_000);
  assert.equal(turnAutoRetryDelayMs(4), 120_000, '超出上限也应封顶');
  assert.equal(turnAutoRetryDelayMs(0), 30_000, '非法档位钳到首档');

  // ---------------------------------------------- 上限常量在位
  assert.equal(TURN_AUTO_RETRY_MAX, 3);

  // ---------------------------------------------- 粘会话断流：切同一模型即愈的那类
  assert.equal(
    isStickySessionError('OpenAI Responses stream ended before a terminal response event'),
    true
  );
  assert.equal(isStickySessionError('OpenAI Responses stream ended without a stop reason'), true);
  assert.equal(isStickySessionError('Request timed out.'), false, '超时仍可能是真抖动，不当粘会话');
  assert.equal(isStickySessionError('HTTP 401'), false);

  // ---------------------------------------------- 收口决策：失败看 assistant，不看 display 末条
  // 旧 bug：busy 时编排事件把用户消息垫在 display 末尾，failed=!!末条.error → 假成功并立刻 drain
  const queuedAfterFail = planOrchestratorTurnClose({
    assistantError: 'OpenAI Responses stream ended before a terminal response event',
    queueLength: 3,
    nextRetryAttempt: 1
  });
  assert.equal(queuedAfterFail.failed, true);
  assert.equal(queuedAfterFail.invalidateSession, true, '必须丢掉活会话，对齐切模型');
  assert.equal(queuedAfterFail.drainQueue, false, '失败不得立刻把排队事件打到坏会话上');
  assert.equal(queuedAfterFail.retryDelayMs, 0, '粘会话断流立即重建重试，不必再等 30s');

  const timeoutFail = planOrchestratorTurnClose({
    assistantError: 'Request timed out.',
    queueLength: 1,
    nextRetryAttempt: 1
  });
  assert.equal(timeoutFail.invalidateSession, true);
  assert.equal(timeoutFail.drainQueue, false);
  assert.equal(timeoutFail.retryDelayMs, 30_000, '非粘会话仍走 30s 退避');

  const authFail = planOrchestratorTurnClose({
    assistantError: 'Error Code 401: invalid api key',
    queueLength: 2,
    nextRetryAttempt: 1
  });
  assert.equal(authFail.failed, true);
  assert.equal(authFail.invalidateSession, true);
  assert.equal(authFail.drainQueue, false);
  assert.equal(authFail.retryDelayMs, null, '确定性错误不自动重试');

  const okWithQueue = planOrchestratorTurnClose({
    assistantError: undefined,
    queueLength: 2,
    nextRetryAttempt: 1
  });
  assert.equal(okWithQueue.failed, false);
  assert.equal(okWithQueue.invalidateSession, false);
  assert.equal(okWithQueue.drainQueue, true);
  assert.equal(okWithQueue.retryDelayMs, null);

  const exhausted = planOrchestratorTurnClose({
    assistantError: 'OpenAI Responses stream ended before a terminal response event',
    queueLength: 0,
    nextRetryAttempt: TURN_AUTO_RETRY_MAX + 1
  });
  assert.equal(exhausted.retryDelayMs, null);

  // ---------------------------------------------- 副作用闸：本回合已跑过工具不得自动重试
  // 自动重发会把已执行的写操作（提交/写文件/发消息）重放一遍，模型对已跑过的部分
  // 记忆不完整——有工具调用的瞬态失败只报错等人工。
  const withTools = planOrchestratorTurnClose({
    assistantError: 'OpenAI Responses stream ended before a terminal response event',
    queueLength: 0,
    nextRetryAttempt: 1,
    toolCallCount: 2
  });
  assert.equal(withTools.failed, true);
  assert.equal(withTools.invalidateSession, true, '会话仍要丢（粘会话断流），但不自动重试');
  assert.equal(withTools.retryDelayMs, null, '有工具副作用时禁止自动重试');

  const withEmptyTools = planOrchestratorTurnClose({
    assistantError: 'Request timed out.',
    queueLength: 0,
    nextRetryAttempt: 1,
    toolCallCount: 0
  });
  assert.equal(withEmptyTools.retryDelayMs, 30_000, '没有工具副作用照常退避重试');

  // ---------------------------------------------- retry 定位：跳过垫在失败回合后的排队消息
  // P0 回归：失败回合不 drain，busy 期间排队的消息以 queued 标记垫在 display 末尾，
  // 旧实现只认「末条是带错 assistant」→ 定时器到点必被拒，重试静默失效、队列搁浅。
  assert.equal(
    locateRetryableTurn([
      { role: 'user' },
      { role: 'assistant', error: 'stream ended' },
      { role: 'user', queued: true },
      { role: 'user', queued: true }
    ]),
    1,
    '排队消息垫尾时必须定位到失败 assistant'
  );
  assert.equal(
    locateRetryableTurn([{ role: 'user' }, { role: 'assistant', error: 'boom' }]),
    1,
    '经典末尾失败照常定位'
  );
  assert.equal(
    locateRetryableTurn([{ role: 'user' }, { role: 'assistant' }, { role: 'user', queued: true }]),
    -1,
    '失败之后已有成功回合（尾部 assistant 无错）不得重试旧失败'
  );
  assert.equal(locateRetryableTurn([{ role: 'user' }, { role: 'user', queued: true }]), -1);
  assert.equal(locateRetryableTurn([]), -1);

  // 接线守卫：Orchestrator 必须消费该决策，否则 display 末条误判会再发一次
  // （拆分后回合执行在 src/main/agent/orchestrator/turnExecution.ts，读门面+子模块拼接源）
  const orchDir = path.join(root, 'src/main/agent/orchestrator');
  const orchSrc = [
    fs.readFileSync(path.join(root, 'src/main/agent/orchestrator.ts'), 'utf8'),
    ...fs
      .readdirSync(orchDir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => fs.readFileSync(path.join(orchDir, f), 'utf8'))
  ].join('\n');
  assert.match(orchSrc, /planOrchestratorTurnClose/, 'runTurn 必须走 planOrchestratorTurnClose');
  assert.match(orchSrc, /plan\.invalidateSession/, '失败必须按计划丢掉活会话');
  assert.match(orchSrc, /plan\.drainQueue/, '出队必须按计划，禁止用 display 末条.error');
  assert.doesNotMatch(
    orchSrc,
    /const failed = !!doneMsg\.error/,
    '禁止用 display 末条判定回合成败（排队消息会垫在后面）'
  );
  assert.match(
    orchSrc,
    /locateRetryableTurn\(display\)/,
    'retry() 必须用扫描定位（跳过垫尾的排队消息），禁止只认 display 末条'
  );
  assert.doesNotMatch(
    orchSrc,
    /const failed = display\[display\.length - 1\]/,
    '禁止只认 display 末条定位失败回合'
  );
  assert.match(
    orchSrc,
    /toolCallCount:\s*finalAssistant\.toolCalls/,
    '收口必须把本回合工具调用数传给决策（副作用闸；终态读 finalAssistant——插话切分后 error/aborted/工具数都落切分后的新占位）'
  );
  assert.match(
    orchSrc,
    /bucket\.streamingAssistant = assistant;/,
    'startTurn/retry 必须置 bucket.streamingAssistant（插话切分的流式落点引用；漏置则 sendNow steer 静默退化为不切分）'
  );
  assert.match(
    orchSrc,
    /getAssistant: \(\) => bucket\.streamingAssistant \?\? assistant/,
    'runTurn 必须把 streamingAssistant 间接层传给 provider（steer 切分后 delta/终态章落新占位）'
  );
  assert.match(
    orchSrc,
    /!res\.accepted/,
    '自动重试定时器必须检查 retry 受理结果，拒绝时落日志'
  );

  // ---------------------------------------------- 网络/传输中止：GUI 续作分类（不特判 Cursor）
  const network = [
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'connect ETIMEDOUT 20.1.2.3:443',
    '[unknown] [aborted] read ECONNRESET',
    'AbortError: The operation was aborted',
    'socket hang up',
    'fetch failed'
  ];
  for (const msg of network) {
    assert.equal(isNetworkTurnError(msg), true, `应判定网络中止: ${msg}`);
  }
  assert.equal(isNetworkTurnError('Turn prefix summarization aborted'), false, '压缩中止不是传输死亡');
  assert.equal(isNetworkTurnError('HTTP 401: invalid api key'), false);
  assert.equal(isNetworkTurnError('引擎崩了'), false);
  assert.equal(isNetworkTurnError(''), false);

  const retryCfg = normalizeGuiTurnRetryConfig(undefined);
  assert.equal(retryCfg.enabled, true);
  assert.equal(retryCfg.maxRetries, 3);
  assert.equal(retryCfg.baseDelayMs, 2_000);
  assert.equal(retryCfg.maxDelayMs, 30_000);
  assert.equal(guiTurnRetryDelayMs(1), 2_000);
  assert.equal(guiTurnRetryDelayMs(2), 4_000);
  assert.equal(guiTurnRetryDelayMs(3), 8_000);
  assert.equal(guiTurnRetryDelayMs(5), 30_000, '退避封顶 maxDelayMs');
  const custom = normalizeGuiTurnRetryConfig({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 400 });
  assert.equal(custom.maxRetries, 2);
  assert.equal(custom.baseDelayMs, 100);
  assert.equal(guiTurnRetryDelayMs(1, custom), 100);
  assert.equal(guiTurnRetryDelayMs(2, custom), 200);
  assert.equal(guiTurnRetryDelayMs(3, custom), 400);
  assert.equal(normalizeGuiTurnRetryConfig({ baseDelayMs: 20 }).baseDelayMs, 100, '低于下限钳到 100ms');
  assert.equal(normalizeGuiTurnRetryConfig({ enabled: false }).enabled, false);
  assert.equal(GUI_TURN_RETRY_DEFAULTS.maxRetries, 3);

  const userStop = planGuiTurnRetry({
    errorMessage: '[unknown] [aborted] read ECONNRESET',
    userAborted: true,
    nextAttempt: 1,
    hasProgress: false,
    config: retryCfg
  });
  assert.deepEqual(userStop, { action: 'fail', report: 'none' }, '用户点停止不续作、不上报');

  const auth = planGuiTurnRetry({
    errorMessage: 'HTTP 401: invalid api key',
    userAborted: false,
    nextAttempt: 1,
    hasProgress: false,
    config: retryCfg
  });
  assert.deepEqual(auth, { action: 'fail', report: 'none' }, '确定性错误不续作也不当网络死亡报');

  const first = planGuiTurnRetry({
    errorMessage: '[unknown] [aborted] read ECONNRESET',
    userAborted: false,
    nextAttempt: 1,
    hasProgress: false,
    config: retryCfg
  });
  assert.equal(first.action, 'retry');
  assert.equal(first.mode, 'resend', '尚无进度则重发原用户消息');
  assert.equal(first.delayMs, 2_000);
  assert.equal(first.attempt, 1);

  const mid = planGuiTurnRetry({
    errorMessage: 'read ECONNRESET',
    userAborted: false,
    nextAttempt: 2,
    hasProgress: true,
    config: retryCfg
  });
  assert.equal(mid.action, 'retry');
  assert.equal(mid.mode, 'continue', '已有思考/工具则续作，不重放');
  assert.equal(mid.delayMs, 4_000);

  const guiExhausted = planGuiTurnRetry({
    errorMessage: 'read ECONNRESET',
    userAborted: false,
    nextAttempt: retryCfg.maxRetries + 1,
    hasProgress: true,
    config: retryCfg
  });
  assert.deepEqual(guiExhausted, { action: 'fail', report: 'network_error' }, '用尽才上报调度');

  const disabled = planGuiTurnRetry({
    errorMessage: 'ETIMEDOUT',
    userAborted: false,
    nextAttempt: 1,
    hasProgress: false,
    config: { ...retryCfg, enabled: false }
  });
  assert.deepEqual(disabled, { action: 'fail', report: 'network_error' });

  assert.equal(guiTurnHasProgress({ parts: [] }), false);
  assert.equal(guiTurnHasProgress({ parts: [{ kind: 'text', text: '  ' }] }), false);
  assert.equal(guiTurnHasProgress({ parts: [{ kind: 'text', text: '已写了' }] }), true);
  assert.equal(guiTurnHasProgress({ parts: [{ kind: 'tool' }] }), true);

  // 2026-09-26 host 拆分：回合失败/续作实现在 host/turn.ts，Host.retry 在 host/messaging.ts
  const turnSrc = fs.readFileSync(path.join(root, 'src/main/agentSession/host/turn.ts'), 'utf8');
  assert.match(turnSrc, /planGuiTurnRetry/, 'Host 失败路径必须走 planGuiTurnRetry');
  assert.match(turnSrc, /outcome:\s*'network_error'/, '用尽后续作必须带 network_error 收口');
  assert.match(turnSrc, /handleTurnFailure/, 'error 事件与 send reject 必须汇到同一入口');
  const retrySrc = fs.readFileSync(path.join(root, 'src/main/agentSession/host/messaging.ts'), 'utf8');
  assert.match(
    retrySrc,
    /locateRetryableTurn\(entry\.messages\)/,
    'GUI Host.retry 必须扫描定位失败回合，禁止再走 send(原文) 追加用户副本'
  );
  const surfaceSrc = fs.readFileSync(
    path.join(root, 'src/renderer/src/chatSurface/agentSessionSurface.tsx'),
    'utf8'
  );
  assert.match(surfaceSrc, /agentSession\.retry/, '渲染层 retry 必须调 Host IPC，不得 send(原文)');
  assert.doesNotMatch(
    surfaceSrc,
    /void this\.send\(guiMessageText/,
    '禁止渲染层 retry 再走 send(原文)——会追加用户消息副本污染转写'
  );
  const indexSrc = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(indexSrc, /onTurnFailed/, 'busy:false + network_error 必须上报调度');
  assert.match(indexSrc, /outcome === 'network_error'/, '禁止网络死亡再走普通 turn_end');
  const piSrc = fs.readFileSync(path.join(root, 'src/main/agent/providers/piProvider.ts'), 'utf8');
  assert.match(piSrc, /isStickySessionError/, '请求级重试须识别粘会话断流');
  assert.match(piSrc, /abortRetry/, '粘会话断流须取消 pi 同会话余下重试');

  console.log('turn-retry.mjs 全部通过');
} finally {
  fs.rmSync(compileTmp, { recursive: true, force: true });
}
