/**
 * Agent 管线与危险操作确认门端到端。
 * 收编自 test/e2e.mjs（原脚本需手动起 app + 9222 + mock-llm）。
 * 覆盖：配置指向 mock LLM、claude-code 终端会话/pty、流式 tool-call 管线、
 * 危险操作确认门（取消 → 无副作用；确认 → 注册主进程内部调度任务）。
 */
import { test, expect } from './fixtures/electron';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const SERVICE_NAME = 'e2e日报';
let sessionId = '';
let serviceId = '';

interface ChatMessage {
  role: string;
  content: string;
  error?: unknown;
  toolCalls?: Array<{ name: string; status: string; result: string }>;
}

async function lastAssistant(win: Page): Promise<ChatMessage | null> {
  return win.evaluate(async () => {
    const api = (window as any).api;
    const hist: any[] = (await api.chat.historyRange()).messages;
    const assistants = hist.filter((m) => m.role === 'assistant');
    return assistants[assistants.length - 1] ?? null;
  });
}

async function sessionStatus(win: Page, id: string): Promise<string | undefined> {
  return win.evaluate(async (sid) => {
    const r = await (window as any).api.sessions.list();
    return r.sessions.find((x: { id: string }) => x.id === sid)?.status;
  }, id);
}

/** 发送并轮询到回合结束（工具全部落定 + 有正文或报错），返回最后的 assistant 消息 */
async function sendAndWaitDone(win: Page, text: string, timeout = 25_000): Promise<ChatMessage> {
  await win.evaluate(async (t) => {
    await (window as any).api.chat.send(t);
  }, text);
  await expect
    .poll(
      async () => {
        const m = await lastAssistant(win);
        if (!m) return null;
        const toolsSettled = (m.toolCalls ?? []).every((t) => t.status !== 'running');
        const finished = (m.content && m.content.length > 0) || m.error;
        return toolsSettled && finished ? m : null;
      },
      { timeout, message: `Agent 回合结束 (${text.slice(0, 40)})` }
    )
    .toBeTruthy();
  const m = await lastAssistant(win);
  expect(m).not.toBeNull();
  return m as ChatMessage;
}

async function clickConfirm(win: Page, danger: boolean): Promise<void> {
  const modal = win.locator('.confirm-modal');
  await modal.waitFor({ state: 'visible', timeout: 20_000 });
  // 演示用：PW_CONFIRM_PAUSE_MS 在点击前驻留（看清确认门内容）
  const pauseMs = Number(process.env.PW_CONFIRM_PAUSE_MS || 0);
  if (pauseMs > 0) await win.waitForTimeout(pauseMs);
  const selector = danger ? '.btn.danger' : '.modal-actions .btn:not(.danger)';
  await modal.locator(selector).first().click();
}

/**
 * 从 toolCall.result 深挖 task.id：result 是 {content:[{type:'text',text:'<内层JSON>'}]}
 * 信封，内层是 {ok, created, task:{id,...}}（Pi provider 两层序列化，别按字面层级取）。
 */
function deepFindTaskId(v: unknown): string | undefined {
  if (typeof v === 'string') {
    try {
      return deepFindTaskId(JSON.parse(v));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = deepFindTaskId(x);
      if (r) return r;
    }
    return undefined;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const task = o.task;
    if (task && typeof task === 'object' && typeof (task as { id?: unknown }).id === 'string') {
      return (task as { id: string }).id;
    }
    for (const x of Object.values(o)) {
      const r = deepFindTaskId(x);
      if (r) return r;
    }
  }
  return undefined;
}

test('配置指向 mock LLM 并清空聊天历史', async ({ appCtx, mockLlm }) => {
  const cfg = await appCtx.win.evaluate(async (baseUrl) => {
    return (window as any).api.config.update({
      openai: { baseUrl, apiKey: 'mock-key', model: 'mock' },
      llm: {
        activeProviderId: 'chat-guard', activeModelId: 'mock',
        providers: [{ id: 'chat-guard', name: 'Chat guard fixture', enabled: true,
          api: 'openai-completions', baseUrl, apiKey: 'mock-key', models: [{ id: 'mock', name: 'Mock' }] }]
      }
    });
  }, `http://127.0.0.1:${mockLlm.port}/v1`);
  expect(cfg.openai.baseUrl).toBe(`http://127.0.0.1:${mockLlm.port}/v1`);

  await appCtx.win.evaluate(async () => {
    await (window as any).api.chat.clear();
  });
});

test('创建 claude-code 终端会话（异步预分配 externalSessionId）并进入 running', async ({
  appCtx
}) => {
  const s = await appCtx.win.evaluate(async () => {
    return (window as any).api.sessions.create({ runtime: 'claude-code', name: 'e2e 终端' });
  });
  expect(s?.id, `session=${JSON.stringify(s)}`).toBeTruthy();
  expect(s.runtime).toBe('claude-code');
  sessionId = s.id;

  // createTerminal 立即返回，allocate 在后台 launchTerminal 里异步完成
  await expect
    .poll(
      async () => {
        const meta = await appCtx.win.evaluate(async (sid) => {
          const r = await (window as any).api.sessions.list();
          return r.sessions.find((x: { id: string }) => x.id === sid) ?? null;
        }, sessionId);
        return meta?.externalSessionId ?? '';
      },
      { timeout: 20_000, message: 'externalSessionId 预分配' }
    )
    .toBeTruthy();

  await expect
    .poll(() => sessionStatus(appCtx.win, sessionId), { timeout: 20_000 })
    .toBe('running');
});

test('pty 可写入且写入后仍为 running', async ({ appCtx }) => {
  await appCtx.win.evaluate(async ({ sid, input }) => {
    await (window as any).api.pty.input(sid, input);
  }, { sid: sessionId, input: 'hello-e2e-marker' });
  expect(await sessionStatus(appCtx.win, sessionId)).toBe('running');
});

test('Agent 管线：流式 tool-call sessions_observe 执行成功', async ({ appCtx }) => {
  const m = await sendAndWaitDone(appCtx.win, 'tool:sessions_observe {"includeShell":true}');
  const tc = m.toolCalls?.[0];
  expect(tc, `message=${JSON.stringify(m)}`).toBeTruthy();
  expect(tc!.name).toBe('sessions.observe');
  expect(tc!.status).toBe('ok');
  expect(m.content).toContain('【mock】');
  expect(tc!.result).toContain('e2e 终端');
});

test('普通对话（无工具）流式返回', async ({ appCtx }) => {
  const m = await sendAndWaitDone(appCtx.win, '你好，随便聊聊');
  expect(m.content).toContain('【mock】收到');
});

test('危险操作确认门：取消 → 无副作用', async ({ appCtx }) => {
  const { win } = appCtx;
  const before = await win.evaluate(async () => (window as any).api.services.list());

  // 参数须满足 catalog schema，否则 pi 校验先于确认门拒绝（确认框根本不会出现）
  const sendPromise = win.evaluate(async (t) => {
    await (window as any).api.chat.send(t);
  }, `tool:automations_create {"name":"e2e-cancel-preview","prompt":"取消路径预演","runtime":"cursor","schedule":{"kind":"daily","time":"08:00"}}`);
  await clickConfirm(win, false);
  await sendPromise;

  const m = await lastAssistant(win);
  // Pi provider 语义：toolCall.status 只有 ok|error；用户取消落在结果载荷
  // {ok:false, cancelled:true, error:'已取消'}（executor.ts），行为保证=服务数不变
  const tc = m?.toolCalls?.[0];
  expect(tc?.result ?? '', `result=${tc?.result}`).toContain('用户取消');

  const after = await win.evaluate(async () => (window as any).api.services.list());
  expect(after.services.length, '取消后服务数变了，有副作用').toBe(before.services.length);
});

test('危险操作确认门：确认 → 注册主进程内部调度的定时任务', async ({ appCtx }) => {
  const { win } = appCtx;
  // 新契约：{name, prompt, runtime, schedule:{kind,time}}；仅 terminal（headless 已退役）
  const sendPromise = win.evaluate(async (t) => {
    await (window as any).api.chat.send(t);
  }, `tool:automations_create {"name":"${SERVICE_NAME}","prompt":"e2e 冒烟提示词","runtime":"cursor","schedule":{"kind":"daily","time":"08:00"}}`);
  await clickConfirm(win, true);
  await sendPromise;

  const m = await lastAssistant(win);
  expect(m?.toolCalls?.[0]?.status, `message=${JSON.stringify(m)}`).toBe('ok');
  serviceId = deepFindTaskId(m?.toolCalls?.[0]?.result) ?? '';
  expect(serviceId, `result=${m?.toolCalls?.[0]?.result}`).toBeTruthy();

  const list = await win.evaluate(async () => (window as any).api.services.list());
  const created = list.services.find((s: { id: string }) => s.id === serviceId);
  expect(created, `services=${JSON.stringify(list.services.map((s: { id: string }) => s.id))}`).toBeTruthy();
  expect(created!.name).toContain(SERVICE_NAME);
  expect(created!.enabled).toBe(true);
});

test('服务详情与运行记录可读取', async ({ appCtx }) => {
  const detail = await appCtx.win.evaluate(async (sid) => {
    return (window as any).api.services.get(sid);
  }, serviceId);
  expect(JSON.stringify(detail), `detail=${JSON.stringify(detail)}`).toContain(serviceId);

  const runs = await appCtx.win.evaluate(async (sid) => {
    return (window as any).api.services.runs(sid);
  }, serviceId);
  expect(Array.isArray(runs?.runs)).toBe(true);
});

test.afterAll(async ({ appCtx }) => {
  const { win } = appCtx;
  // 失败/重试路径兜底：按名字清掉所有 e2e 服务（含 Windows 计划任务），再关会话
  try {
    const list = await win.evaluate(async () => (window as any).api.services.list());
    const targets = list.services.filter((s: { name?: string }) => s.name?.includes(SERVICE_NAME));
    for (const s of targets) {
      await win.evaluate(async (sid) => {
        await (window as any).api.services.delete(sid);
      }, s.id);
    }
  } catch {
    /* afterAll 里应用可能已不可用 */
  }
  try {
    if (sessionId) {
      await win.evaluate(async (sid) => {
        await (window as any).api.sessions.close(sid);
      }, sessionId);
    }
  } catch {
    /* 同上 */
  }
});
