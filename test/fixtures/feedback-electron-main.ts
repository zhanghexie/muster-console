/** Isolated real-Electron fixture for the production feedback host, IPC and UI. */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { FeedbackService } from '../../src/main/feedback/service';
import { createDirectFeedbackRemote } from '../../src/main/feedback/directRemote';
import { feedbackHost } from '../../src/main/capabilities/hosts/feedback';
import { bindWorkerToolArgs } from '../../src/main/capabilities/workerBinding';
import { registerFeedbackIpc } from '../../src/main/ipc/feedback';
import type { AppContext } from '../../src/main/context';
import type { RemoteIssue } from '../../src/main/feedback/remote';
import { DEFAULT_FEEDBACK_TARGET, type FeedbackHistoryPage } from '../../src/shared/feedback';

const profile = process.env.MUSTER_FEEDBACK_E2E_PROFILE!;
const html = process.env.MUSTER_FEEDBACK_E2E_HTML!;
const preload = process.env.MUSTER_FEEDBACK_E2E_PRELOAD!;
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
void app.whenReady().then(async () => {
  let win: BrowserWindow;
  const issues: RemoteIssue[] = [];
  const opened: string[] = [];
  let clipboardText = '';
  const ctx = {
    getWindow: () => win,
    sessions: { get: (id: string) => ({ workspaceId: 'ws', name: id === 'worker-a' ? 'Worker A' : 'Worker B' }) },
    workspaces: { list: () => [{ id: 'ws', name: '测试工作区' }] },
    resolveBubbleWorkspaceId: () => 'ws'
  } as unknown as AppContext;
  const target = DEFAULT_FEEDBACK_TARGET;
  const changed = () => { if (win && !win.isDestroyed()) win.webContents.send('feedback:changed', {}); };
  const fetchIssues: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.origin !== 'https://api.github.com' || url.pathname !== '/repos/zhanghexie/muster-console/issues' ||
      url.searchParams.get('state') !== 'all' || init?.credentials !== 'omit' || headers.has('authorization') ||
      (init?.method && init.method !== 'GET')) throw new Error('Expected an anonymous Issues GET');
    return Response.json(issues.map(issue => ({ number: Number(issue.id), title: issue.title, body: issue.body,
      state: issue.state, html_url: issue.url })));
  };
  ctx.feedback = new FeedbackService({ file: path.join(profile, 'feedback.json'), appVersion: 'test',
    remote: createDirectFeedbackRemote(fetchIssues, target),
    issuePage: {
      open: async url => { opened.push(url); },
      copyBody: body => { clipboardText = body; }
    }, changed
  });
  registerFeedbackIpc(ctx);
  ipcMain.handle('fixture:propose', async () => {
    const item = { kind: 'bug', title: '切换工作区后列表滚动位置丢失', area: '会话列表', context: '在两个工作区间切换', actual: '回到顶部', expected: '恢复原位置', steps: '滚动、切换、返回', impact: '需要重新定位', evidence: '一次观察', suggestion: '' };
    const historyA = await feedbackHost['feedback.history'](ctx, bindWorkerToolArgs(ctx, 'feedback.history', {}, 'worker-a')) as FeedbackHistoryPage;
    const a = bindWorkerToolArgs(ctx, 'feedback.propose', { checkId: historyA.checkId, items: [item, { ...item, title: '退出后任务状态没有保存', area: '任务', actual: '重启后状态丢失', expected: '恢复任务状态' }] }, 'worker-a');
    await feedbackHost['feedback.propose'](ctx, a as { items: unknown; checkId: string });
    const historyB = await feedbackHost['feedback.history'](ctx, bindWorkerToolArgs(ctx, 'feedback.history', {}, 'worker-b')) as FeedbackHistoryPage;
    // Simulated AI recognizes the prior draft and does not propose it again.
    return historyB.items.some(entry => entry.source === 'local' && entry.title === item.title);
  });
  ipcMain.handle('fixture:assess', async () => {
    const history = await feedbackHost['feedback.history'](ctx, bindWorkerToolArgs(ctx, 'feedback.history', {}, 'worker-a')) as FeedbackHistoryPage;
    const decisions = history.items.filter(entry => entry.source === 'local' && entry.needsAiCheck).map(entry => ({ id: entry.id, revision: entry.revision }));
    return feedbackHost['feedback.assess'](ctx, bindWorkerToolArgs(ctx, 'feedback.assess', { checkId: history.checkId, decisions }, 'worker-a') as { checkId: string; decisions: unknown });
  });
  ipcMain.handle('fixture:issues', () => issues);
  ipcMain.handle('fixture:opened', () => opened);
  ipcMain.handle('fixture:clipboardText', () => clipboardText);
  ipcMain.handle('fixture:replaceClipboard', (_event, text: string) => { clipboardText = text; });
  ipcMain.handle('fixture:submitOnGitHub', (_event, pastedBody?: string) => {
    const url = new URL(opened.at(-1)!);
    const id = String(issues.length + 1);
    issues.push({ id, title: url.searchParams.get('title')!, body: pastedBody ?? url.searchParams.get('body') ?? '',
      state: 'open', url: `${target.repository}/issues/${id}` });
  });
  win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { preload, contextIsolation: true, sandbox: false, nodeIntegration: false } });
  await win.loadFile(html);
});
