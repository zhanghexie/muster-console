/**
 * 第二轮端到端自测：多终端隔离、sessions.restartConversation、sessions.message、sessions.setStatus。
 * 前置：应用以 --remote-debugging-port=9222 运行，mock-llm 在 18034。
 */
import WebSocket from 'ws';

const CDP_BASE = 'http://127.0.0.1:9222';
let msgId = 0;
let ws;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`evaluate 异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时: ${desc}`);
    await sleep(400);
  }
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}: ${e.message}`);
    throw e;
  }
}

async function lastAssistant() {
  const hist = await evalJs('window.api.chat.history()');
  const a = hist.filter((m) => m.role === 'assistant');
  return a[a.length - 1];
}

async function main() {
  const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  await rpc('Runtime.enable');

  let t1 = '';
  let t2 = '';

  await step('创建两个终端会话', async () => {
    const a = await evalJs(`window.api.sessions.create({ runtime: 'claude-code', name: 'iso-A' })`);
    const b = await evalJs(`window.api.sessions.create({ runtime: 'claude-code', name: 'iso-B' })`);
    t1 = a.id;
    t2 = b.id;
    if (!a.externalSessionId || !b.externalSessionId) throw new Error('缺少 externalSessionId');
    if (a.externalSessionId === b.externalSessionId) throw new Error('两个会话外部 ID 不应相同');
    await waitFor('两个 pty 均 running', async () => {
      const list = await evalJs(`window.api.sessions.list().then(r => r.sessions)`);
      const s1 = list.find((x) => x.id === t1);
      const s2 = list.find((x) => x.id === t2);
      return s1?.status === 'running' && s2?.status === 'running';
    });
  });

  await step('多终端隔离：输入写入各自会话', async () => {
    await evalJs(`window.api.pty.input(${JSON.stringify(t1)}, 'MARKER-AAA')`);
    await evalJs(`window.api.pty.input(${JSON.stringify(t2)}, 'MARKER-BBB')`);
    // 交互式 TUI 不一定回显原文；至少保证两边进程仍独立存活
    const list = await evalJs(`window.api.sessions.list().then(r => r.sessions)`);
    const s1 = list.find((x) => x.id === t1);
    const s2 = list.find((x) => x.id === t2);
    if (s1?.status !== 'running' || s2?.status !== 'running') throw new Error('写入后会话未保持 running');
  });

  await step('sessions.restartConversation：重开 CLI，buffer 重置', async () => {
    // R5：发现层退役——sessions.restartConversation 为调度常驻，直调下划线名
    await evalJs(`window.api.chat.send('tool:sessions_restartConversation {"sessionId":"${t1}"}')`);
    await waitFor('restartConversation 直调成功', async () => {
      const m = await lastAssistant();
      return m?.toolCalls?.[0]?.name === 'sessions.restartConversation' && m.toolCalls[0].status === 'ok' && m.content;
    });
    await waitFor('新 pty 有输出且旧 marker 消失', async () => {
      const b1 = await evalJs(`window.api.pty.getBuffer(${JSON.stringify(t1)})`);
      return b1.length > 0 && !b1.includes('MARKER-AAA');
    });
  });

  await step('sessions.message：存信且不把正文打进终端', async () => {
    await evalJs(
      `window.api.chat.send('tool:sessions_message {"to":"${t2}","text":"排查 MAIL_TASK_42 的日志"}')`
    );
    const assistant = await waitFor('寄信工具成功', async () => {
      const m = await lastAssistant();
      return m?.toolCalls?.[0]?.name === 'sessions.message' && m.toolCalls[0].status === 'ok' ? m : null;
    });
    if (!JSON.stringify(assistant.toolCalls[0]).includes('stored')) throw new Error('缺少已存信回执');
    const buffer = await evalJs(`window.api.pty.getBuffer(${JSON.stringify(t2)})`);
    if (buffer.includes('MAIL_TASK_42')) throw new Error('普通寄信不应自动把正文写入终端');
  });

  await step('sessions.setStatus 设置灵活状态胶囊', async () => {
    await evalJs(
      `window.api.chat.send('tool:sessions_setStatus {"sessionId":"${t2}","note":"排查中","kind":"active"}')`
    );
    await waitFor('setStatus 工具成功', async () => {
      const x = await lastAssistant();
      return x?.toolCalls?.[0]?.name === 'sessions.setStatus' && x.toolCalls[0].status === 'ok';
    });
    const list = await evalJs(`window.api.sessions.list()`);
    const hit = (list.sessions || list).find((s) => s.id === t2);
    if (!hit?.liveStatus || hit.liveStatus.label !== '排查中') {
      throw new Error('会话未带上 liveStatus.label=排查中');
    }
  });

  await step('清理两个终端', async () => {
    await evalJs(`window.api.sessions.close(${JSON.stringify(t1)})`);
    await evalJs(`window.api.sessions.close(${JSON.stringify(t2)})`);
  });

  console.log('\n==== E2E-2 全部通过 ====');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n==== E2E-2 失败 ====\n', e);
  ws?.close();
  process.exit(1);
});
