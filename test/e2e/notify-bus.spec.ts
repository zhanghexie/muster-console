/**
 * T1.1 通知总线端到端：mock-llm 驱动调度调 sessions_setStatus 上报 needs_you →
 * 推导翻转 → 决策通过 → 桌面 toast 层收到 + 通知历史同键条目；同类重入不重弹。
 * 桌面 toast 在主进程 Electron Notification 上，用 app.evaluate 打桩 show() 记录。
 */
import { test, expect, type ElectronApplication, type Page } from './fixtures/electron';

test.describe.configure({ mode: 'serial' });

const SESSION_NAME = 'e2e推送总线';
let sessionId = '';

/** 主进程打桩 Electron Notification.prototype.show：记录 title/body 到 globalThis.__e2eToastLog */
async function patchToast(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as any;
    g.__e2eToastLog ??= [];
    // evaluate 上下文无模块作用域的 require：经主入口（CJS）拿 electron 模块对象。
    // Electron 43 上直接替换导出属性 electron.Notification 会静默失效（属性不可写），
    // 打原型 show：uiBridge 的 n.show() 命中问谍方法，同时不再真的弹系统 toast。
    const electron = (process as any).mainModule.require('electron');
    const proto = electron.Notification.prototype;
    if (!proto.show.__e2ePatched) {
      const spy = function (this: any) {
        g.__e2eToastLog.push({ title: this.title, body: this.body });
      };
      spy.__e2ePatched = true;
      proto.show = spy;
    }
  });
}

async function toastLog(app: ElectronApplication): Promise<Array<{ title: string; body: string }>> {
  return app.evaluate(() => (globalThis as any).__e2eToastLog ?? []);
}

interface ChatMessage {
  role: string;
  content: string;
  error?: unknown;
  toolCalls?: Array<{ name: string; status: string; result: string }>;
}

async function assistantAfter(win: Page, fromIndex: number): Promise<ChatMessage | null> {
  return win.evaluate(async (from) => {
    const api = (window as any).api;
    const hist: any[] = (await api.chat.historyRange()).messages;
    return hist.find((m, i) => i >= from && m.role === 'assistant') ?? null;
  }, fromIndex);
}

/** 发送前记录历史长度，轮询到「本回合」的 assistant 落定——
 *  调度订阅（facts.subscribe）会在 phase 翻转后向同一会话注入新一轮消息，
 *  断言必须锚定发送位置，不能看「最后一条 assistant」（会被注入轮顶掉） */
async function sendAndWaitDone(win: Page, text: string, timeout = 25_000): Promise<ChatMessage> {
  const from = await win.evaluate(async () => (await (window as any).api.chat.historyRange().then((page: { messages: unknown[] }) => page.messages)).length);
  await win.evaluate(async (t) => {
    await (window as any).api.chat.send(t);
  }, text);
  await expect
    .poll(
      async () => {
        const m = await assistantAfter(win, from);
        if (!m) return null;
        const toolsSettled = (m.toolCalls ?? []).every((t) => t.status !== 'running');
        const finished = (m.content && m.content.length > 0) || m.error;
        return toolsSettled && finished ? m : null;
      },
      { timeout, message: `Agent 回合结束 (${text.slice(0, 40)})` }
    )
    .toBeTruthy();
  const m = await assistantAfter(win, from);
  expect(m).not.toBeNull();
  return m as ChatMessage;
}

test('配置 mock LLM 并打桩桌面 toast', async ({ appCtx, mockLlm }) => {
  await patchToast(appCtx.app);
  const cfg = await appCtx.win.evaluate(async (baseUrl) => {
    return (window as any).api.config.update({
      openai: { baseUrl, apiKey: 'mock-key', model: 'mock' }
    });
  }, `http://127.0.0.1:${mockLlm.port}/v1`);
  expect(cfg.openai.baseUrl).toBe(`http://127.0.0.1:${mockLlm.port}/v1`);
  await appCtx.win.evaluate(async () => {
    await (window as any).api.chat.clear();
  });
});

test('创建会话并经调度上报 needs_you → 桌面 toast + 通知历史同键条目', async ({ appCtx }) => {
  const s = await appCtx.win.evaluate(async (name) => {
    return (window as any).api.sessions.create({ runtime: 'claude-code', name });
  }, SESSION_NAME);
  expect(s?.id, `session=${JSON.stringify(s)}`).toBeTruthy();
  sessionId = s.id;

  const m = await sendAndWaitDone(
    appCtx.win,
    `tool:sessions_setStatus {"phase":"needs_you","sessionId":"${sessionId}","note":"等验收"}`
  );
  const tc = m.toolCalls?.[0];
  expect(tc?.status, `message=${JSON.stringify(m)}`).toBe('ok');

  // 决策通过 → 桌面 toast 层收到（title/body 由 NotifyStore 组装，见 resolveDesktopNotifyPayload）
  await expect
    .poll(async () => (await toastLog(appCtx.app)).filter((x) => x.body?.includes(SESSION_NAME)).length, {
      timeout: 10_000,
      message: '桌面 toast 层收到 needs_you 推送'
    })
    .toBeGreaterThanOrEqual(1);
  const entry = (await toastLog(appCtx.app)).find((x) => x.body?.includes(SESSION_NAME))!;
  expect(entry.body).toContain('需要你');

  // 通知历史（panel:false 条目仍在 store 内，供 toast 去重/原地更新）有同键条目
  const items = await appCtx.win.evaluate(
    async (wsId) => (window as any).api.notify.list(wsId),
    s.workspaceId
  );
  const item = (items as Array<{ sessionId?: string; updateKey?: string; label?: string }>).find(
    (x) => x.updateKey === `phase:${sessionId}`
  );
  expect(item, `notify items=${JSON.stringify(items)}`).toBeTruthy();
  expect(item!.label).toBe('需要你');
});

test('同类重入（再次上报同 phase）不重弹 toast', async ({ appCtx }) => {
  const before = (await toastLog(appCtx.app)).filter((x) => x.body?.includes(SESSION_NAME)).length;
  await sendAndWaitDone(
    appCtx.win,
    `tool:sessions_setStatus {"phase":"needs_you","sessionId":"${sessionId}","note":"还在等"}`
  );
  await appCtx.win.waitForTimeout(1_500);
  const after = (await toastLog(appCtx.app)).filter((x) => x.body?.includes(SESSION_NAME)).length;
  expect(after, `同类重入应 no-flip 不重弹（before=${before}）`).toBe(before);
});

test.afterAll(async ({ appCtx }) => {
  try {
    if (sessionId) {
      // 未归档会话不能直接删：先归档再删，保持沙箱干净
      await appCtx.win.evaluate(async (sid) => {
        await (window as any).api.sessions.setArchived(sid, true);
        await (window as any).api.sessions.close(sid);
      }, sessionId);
    }
  } catch {
    /* afterAll 里应用可能已不可用 */
  }
});
