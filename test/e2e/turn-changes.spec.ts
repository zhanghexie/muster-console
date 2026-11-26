/** Production turn snapshot + IPC handlers + preload + React card in an isolated Electron window.
 * A deterministic writer replaces the model; no network, user profile or project files are changed.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = path.resolve(__dirname, '..', '..');
const requireNode = createRequire(__filename);
const { buildSync } = requireNode('esbuild') as typeof import('esbuild');
const electronPath = requireNode('electron') as string;

test('轮末 Diff 经真实 IPC 展示，并发冲突只在回退时提示', async () => {
  test.setTimeout(60_000);
  const dir = path.join(root, '.tmp', `turn-changes-e2e-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const source = (rel: string) => JSON.stringify(path.join(root, rel).replace(/\\/g, '/'));
  const main = path.join(dir, 'main.ts');
  fs.writeFileSync(main, `
    import { app, BrowserWindow } from 'electron';
    import fs from 'node:fs'; import path from 'node:path';
    import { beginFileChanges, finishFileChanges } from ${source('src/main/agentSession/host/fileChanges.ts')};
    import { registerTurnChangesIpc } from ${source('src/main/turnChanges/ipc.ts')};
    import { turnChanges } from ${source('src/main/turnChanges/runtime.ts')};
    import { sourcePathKey } from ${source('src/main/workspacePaths.ts')};
    fs.mkdirSync(path.join(__dirname, 'profile'), { recursive: true });
    app.setPath('userData', path.join(__dirname, 'profile'));
    app.whenReady().then(async () => {
      const work = path.join(__dirname, 'work'); fs.mkdirSync(work);
      fs.writeFileSync(path.join(work, 'safe.txt'), 'personal edit\\nold\\n');
      fs.writeFileSync(path.join(work, 'later.txt'), 'old\\n');
      fs.writeFileSync(path.join(work, 'observed.txt'), 'old\\n');
      fs.writeFileSync(path.join(work, 'reported.txt'), 'new\\n');
      const coldMessage: any = { id: 'cold-message', role: 'assistant', parts: [], ts: Date.now() };
      const entry: any = { sessionId: 'fixture-session', cwd: work, messages: [coldMessage], closed: false, injections: [], compactions: [] };
      let win: BrowserWindow;
      const notices: any[] = [];
      const ctx: any = { getWindow: () => win,
        config: { get: () => ({ activeWorkspaceId: 'fixture-workspace', workspaces: [{ id: 'fixture-workspace', path: work }] }) },
        sessions: { get: (id: string) => ({ name: id === 'collision-a' ? '会话 A' : '会话 B', workspaceId: 'fixture-workspace' }) },
        notify: { push: (notice: any) => notices.push(notice) } };
      const host: any = { ctx, entries: new Map([['fixture-session', entry]]), pushSubs: new Set(),
        store: { save() {} }, getWorkspaceContext: () => ({ cwd: work, writableDirectories: [{ path: work, physicalPath: sourcePathKey(fs.realpathSync(work)) }] }) };
      ctx.agentSessions = host;
      // A cold turn publishes its real identity without reading the workspace.
      beginFileChanges(host, entry, coldMessage);
      if (!coldMessage.turnChanges?.id || coldMessage.turnChanges.state !== 'collecting') throw new Error('live snapshot identity must publish before capture');
      (globalThis as any).__preparationObserved = coldMessage.turnChanges;
      const coldTracker = [...turnChanges().active].find(tracker=>tracker.summary.id===coldMessage.turnChanges.id)!;
      await coldTracker.toolStart('observed', 'file_change', {changes:[{path:'safe.txt'}]}); await coldTracker.toolEnd('observed', true);
      finishFileChanges(host, entry);
      for (let i = 0; i < 200 && coldMessage.turnChanges.state === 'collecting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      if (coldMessage.turnChanges.state !== 'ready' || coldMessage.turnChanges.files.length || !coldMessage.turnChanges.warnings.length) throw new Error('an observed event must not invent a saved snapshot');
      const message: any = { id: 'fixture-message', role: 'assistant', parts: [], ts: Date.now() };
      entry.messages.push(message);beginFileChanges(host, entry, message);
      const tracker = [...turnChanges().active].find(tracker=>tracker.summary.id===message.turnChanges.id)!;
      for (const name of ['safe.txt', 'later.txt']) {
        await tracker.toolStart(name, 'edit', { path: name, oldText: 'old', newText: 'new' }, undefined, true);
        const file = path.join(work, name); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('old', 'new'));
        await tracker.toolEnd(name, true, undefined, true);
      }
      await tracker.toolStart('observed-change', 'file_change', {changes:[{path:'observed.txt'}]});
      fs.writeFileSync(path.join(work, 'observed.txt'), 'new\\n');
      await tracker.toolEnd('observed-change', true);
      await tracker.toolEnd('reported-change', true, undefined, false, [{path:'reported.txt',kind:'update',diff:'@@ -1 +1 @@\\n-old\\n+new\\n'}]);
      finishFileChanges(host, entry);
      (globalThis as any).__finalizingObserved = message.turnChanges;
      while (message.turnChanges.state === 'collecting') await new Promise(resolve => setTimeout(resolve, 10));
      const summary = message.turnChanges;
      fs.writeFileSync(path.join(work, 'later.txt'), 'new\\nmy later edit\\n');
      registerTurnChangesIpc(ctx);
      (globalThis as any).__simulateFileCollision = async () => {
        fs.writeFileSync(path.join(work, 'concurrent.txt'), 'old');
        const entries = ['a', 'b'].map(id => ({ sessionId: 'collision-' + id, cwd: work, messages: [{ id: 'collision-message-' + id, role: 'assistant', parts: [], ts: Date.now() }], closed: false, injections: [], compactions: [] }));
        for (const entry of entries) { host.entries.set(entry.sessionId, entry); beginFileChanges(host, entry as any, entry.messages[0] as any); }
        const [a,b] = entries.map(entry => [...turnChanges().active].find(tracker=>tracker.summary.id===(entry as any).messages[0].turnChanges.id)!);
        await a.toolStart('a', 'write', { path: 'concurrent.txt', content: 'A' }, undefined, true); fs.writeFileSync(path.join(work, 'concurrent.txt'), 'A'); await a.toolEnd('a', true, undefined, true);
        await b.toolStart('b', 'write', { path: 'concurrent.txt', content: 'B' }, undefined, true); fs.writeFileSync(path.join(work, 'concurrent.txt'), 'B'); await b.toolEnd('b', true, undefined, true);
        await b.toolStart('b2', 'write', { path: 'concurrent.txt', content: 'B2' }, undefined, true); fs.writeFileSync(path.join(work, 'concurrent.txt'), 'B2'); await b.toolEnd('b2', true, undefined, true);
        (globalThis as any).__finishCollisions = async () => {
          for (const entry of entries) finishFileChanges(host, entry as any);
          while (entries.some((e: any) => e.messages[0].turnChanges.state === 'collecting')) await new Promise(resolve => setTimeout(resolve, 10));
        };
        return notices;
      };
      fs.writeFileSync(path.join(__dirname, 'index.html'), '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script>window.__turnSummary=' + JSON.stringify(summary) + ';window.__preparationSummary=' + JSON.stringify((globalThis as any).__preparationObserved) + ';window.__finalizingSummary=' + JSON.stringify((globalThis as any).__finalizingObserved) + '</script><script src="renderer.js"></script></body></html>');
      win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
      (globalThis as any).__captureBaseline = async (file: string) => {
        for (let attempt = 0; ; attempt++) {
          try { fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); return; }
          catch (error) {
            if (attempt >= 4 || !String(error).includes('UnknownVizError')) throw error;
            console.warn('Hidden Electron compositor was not ready for capture; retrying', attempt + 1);
            await new Promise(resolve => setTimeout(resolve, 150));
          }
        }
      };
      await win.loadFile(path.join(__dirname, 'index.html'));
    }).catch(error => { console.error(error); app.exit(1); });
    app.on('window-all-closed', () => app.quit());
  `);
  const renderer = path.join(dir, 'renderer.tsx');
  fs.writeFileSync(renderer, `
    import React, { useEffect, useReducer, useState } from 'react'; import { createRoot } from 'react-dom/client';
    import ${source('src/renderer/src/i18n.ts')};
    import ${source('src/renderer/src/styles/base.css')};
    import ${source('src/renderer/src/styles/git.css')};
    import ${source('src/renderer/src/styles/turn-changes.css')};
    import { TurnChangesCard } from ${source('src/renderer/src/chatSurface/TurnChangesCard.tsx')};
    import { TurnReviewPanel } from ${source('src/renderer/src/panels/TurnReviewPanel.tsx')};
    import { TURN_REVIEW_EVENT } from ${source('src/renderer/src/chatSurface/turnReviewNavigation.ts')};
    import { RightWorkspaceContext } from ${source('src/renderer/src/rightWorkspace.tsx')};
    import { initialRightWorkspace, reduceRightWorkspace, activeRightTab } from ${source('src/shared/rightWorkspace.ts')};
    import { applyTheme } from ${source('src/renderer/src/theme.ts')};
    import { builtinTheme } from ${source('src/shared/theme.ts')};
    (window as any).__setFixtureTheme = (name: 'dark' | 'light') => applyTheme(builtinTheme(name)!);
    function Fixture() {
      const [liveSummary, setLiveSummary] = useState((window as any).__preparationSummary);
      const [peek, setPeek] = useState(false);
      useEffect(() => {
        const switchPage = () => setPeek(value => !value);
        window.addEventListener('fixture-switch-page', switchPage);
        return () => window.removeEventListener('fixture-switch-page', switchPage);
      }, []);
      useEffect(() => { const ready = (event: Event) => setLiveSummary((event as CustomEvent).detail ?? (window as any).__turnSummary); window.addEventListener('fixture-ready', ready); return () => window.removeEventListener('fixture-ready', ready); }, []);
      const [collisions, setCollisions] = useState<any[]>([]);
      useEffect(() => window.api.on('agentSession:event', (payload: any) => {
        if (payload.kind === 'sync' && payload.sessionId.startsWith('collision-')) setCollisions(prev => [...prev.filter(p => p.sessionId !== payload.sessionId), payload]);
      }), []);
      const [model, dispatch] = useReducer(reduceRightWorkspace, initialRightWorkspace('fixture-workspace','fixture-session'));
      useEffect(() => { const review = (event: any) => dispatch({type:'open',content:{kind:'review',owner:{kind:'gui',id:event.detail.target.id},messageId:event.detail.target.messageId,filePath:event.detail.filePath}}); window.addEventListener(TURN_REVIEW_EVENT,review); return () => window.removeEventListener(TURN_REVIEW_EVENT,review); }, []);
      const current=activeRightTab(model);
      const bridge:any={model,current,dispatch,toolbar:null,location:null,resourceHosts:{files:null,git:null,browser:null},registerFile(){},open(content:any){dispatch({type:'open',content});}};
      return <RightWorkspaceContext.Provider value={bridge}>
        <div className="h-strip vs-axis" style={{transform: peek ? 'translateX(-380px)' : 'translateX(0)'}}>
          <main data-h-page="terminal" data-h-peek={peek ? '' : undefined} style={{padding:16,width:'100%'}}>
            {collisions.map(p => <div key={p.sessionId} data-collision-owner={p.sessionId}><TurnChangesCard summary={p.messages[0].turnChanges} target={{kind:'gui',id:p.sessionId,messageId:p.messages[0].id}}/></div>)}
            <TurnChangesCard summary={liveSummary} target={{kind:'gui',id:'fixture-session',messageId:'fixture-message'}} />
            {current?.content.kind === 'review' ? <div style={{height:550}}><TurnReviewPanel content={current.content} active/></div> : null}
          </main>
        </div>
      </RightWorkspaceContext.Provider>;
    }
    createRoot(document.getElementById('root')!).render(<Fixture/>);
  `);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    buildSync({ entryPoints: [main], outfile: path.join(dir, 'main.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'] });
    buildSync({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(dir, 'preload.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'] });
    buildSync({ entryPoints: [renderer], outfile: path.join(dir, 'renderer.js'), platform: 'browser', format: 'iife', bundle: true, jsx: 'automatic', loader: { '.woff2': 'file', '.woff': 'file' }, define: { 'process.env.NODE_ENV': '"production"' } });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[key];
    app = await electron.launch({ executablePath: electronPath, args: [path.join(dir, 'main.cjs')], env });
    const win = await app.firstWindow();
    expect(await app.evaluate(() => !!(globalThis as any).__preparationObserved.id)).toBe(true);
    // Collection is silent: the card stays hidden until real content exists.
    await expect(win.getByRole('status')).toHaveCount(0);
    await expect(win.locator('.turn-changes-card')).toHaveCount(0);
    await app.evaluate(async (_electron, file) => (globalThis as any).__captureBaseline(file), path.join(root, '.tmp', 'turn-baseline-preparing.png'));
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-ready', {detail:(window as any).__finalizingSummary})));
    await expect(win.getByRole('status')).toHaveCount(0);
    await expect(win.locator('.turn-changes-card')).toHaveCount(0);
    await app.evaluate(async (_electron, file) => (globalThis as any).__captureBaseline(file), path.join(root, '.tmp', 'turn-baseline-finalizing.png'));
    await win.evaluate(() => window.dispatchEvent(new Event('fixture-ready')));
    await expect(win.locator('.turn-changes-card')).toBeVisible();
    const listed = await win.evaluate(() => window.api.turnChanges.list({ kind: 'gui', id: 'fixture-session' }));
    expect(listed.ok).toBe(true); expect(listed.entries).toHaveLength(2);
    expect(listed.entries.find(entry=>entry.target.messageId==='cold-message')?.summary.warnings).not.toHaveLength(0);
    const card = win.locator('.turn-changes-card');
    await card.getByRole('button', { name: /safe.txt/ }).hover();
    await expect(win.locator('.turn-diff-preview .diff-code').filter({ hasText: 'new' })).toBeVisible();
    const preview = win.locator('.h-strip > .turn-diff-preview');
    await expect(preview).toHaveCSS('position', 'absolute');
    const previewBox = await preview.boundingBox();
    const triggerBox = await card.getByRole('button', { name: /safe.txt/ }).boundingBox();
    expect(previewBox!.y >= triggerBox!.y + triggerBox!.height || previewBox!.y + previewBox!.height <= triggerBox!.y).toBe(true);
    await win.evaluate(() => window.dispatchEvent(new Event('fixture-switch-page')));
    await expect(preview).toHaveCount(0);
    await win.evaluate(() => window.dispatchEvent(new Event('fixture-switch-page')));
    await expect(card.locator('xpath=..')).not.toHaveAttribute('data-h-peek', '');
    await card.getByRole('button', { name: /safe.txt/ }).click();
    await expect(win.locator('.turn-review-panel .diff-code').filter({ hasText: 'new' })).toBeVisible();
    await expect(win.locator('.turn-diff-preview')).toHaveCount(0);
    await win.locator('.turn-review-panel').getByRole('button', { name: /observed.txt/ }).click();
    await expect(win.locator('.turn-review-panel')).toContainText('事件观察');
    await expect(win.locator('.turn-review-panel')).toContainText('工具事件的写前时机无法确认，仅供审阅');
    await expect(win.locator('.turn-review-panel .diff-code').filter({ hasText: 'new' })).toBeVisible();
    // A resize forces a fresh compositor frame for the hidden Electron window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(780, 600));
    await win.waitForTimeout(300);
    await app.evaluate(async (_electron, file) => (globalThis as any).__captureBaseline(file), path.join(root, '.tmp', 'turn-review-dark.png'));
    await win.evaluate(() => (window as any).__setFixtureTheme('light'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(390, 900));
    await expect(win.locator('.turn-review-panel .diff-code').filter({ hasText: 'new' })).toBeVisible();
    await win.waitForTimeout(300);
    await app.evaluate(async (_electron, file) => (globalThis as any).__captureBaseline(file), path.join(root, '.tmp', 'turn-review-light-narrow.png'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
    await win.locator('.turn-review-panel').getByRole('button', { name: /reported.txt/ }).click();
    await expect(win.locator('.turn-review-panel')).toContainText('引擎报告');
    await expect(win.locator('.turn-review-panel .diff-code').filter({ hasText: 'new' })).toBeVisible();
    const invalid = await win.evaluate(() => window.api.turnChanges.revert({ kind: 'gui', id: 'other-session', messageId: 'fixture-message' }));
    expect(invalid.ok).toBe(false);
    await win.locator('.turn-review-panel').getByRole('button', { name: /^(回退本轮|Undo this turn)$/ }).click();
    await expect(win.getByRole('alert')).toContainText(/已保留当前内容|current contents were kept/);
    expect(fs.readFileSync(path.join(dir, 'work/safe.txt'), 'utf8')).toBe('personal edit\nold\n');
    expect(fs.readFileSync(path.join(dir, 'work/later.txt'), 'utf8')).toBe('new\nmy later edit\n');
    const second = await win.evaluate(() => window.api.turnChanges.revert({ kind: 'gui', id: 'fixture-session', messageId: 'fixture-message' }));
    expect(second.restored).toEqual([]);
    expect(second.conflicts.map(f => f.path).sort()).toEqual(['later.txt', 'observed.txt', 'reported.txt']);
    const notices = await app.evaluate(async () => (globalThis as any).__simulateFileCollision());
    const collisionCards = win.locator('[data-collision-owner]');
    await expect(collisionCards).toHaveCount(2);
    await expect(collisionCards.locator('.turn-changes-card')).toHaveCount(0);
    await expect(collisionCards.getByRole('alert')).toHaveCount(0);
    expect(notices).toHaveLength(0);
    await app.evaluate(async () => (globalThis as any).__finishCollisions());
    const conflicts = await win.evaluate(() => window.api.turnChanges.list({kind:'gui',id:'collision-a'}));
    expect(conflicts.entries[0].summary.concurrentEdits?.[0].otherLabel).toBe('会话 B');
    expect(conflicts.entries[0].summary.files[0].revertible).toBe(false);
    const collisionCard = win.locator('[data-collision-owner="collision-a"]');
    await expect(collisionCard.getByRole('button', { name: /concurrent.txt/ })).toBeVisible();
    await expect(collisionCards.getByRole('alert')).toHaveCount(0);
    await collisionCard.getByRole('button', { name: /concurrent.txt/ }).click();
    const review = win.locator('.turn-review-panel');
    await expect(review.locator('.turn-review-file-title')).toContainText('concurrent.txt');
    await expect(review).not.toContainText('会话 B');
    await expect(review).not.toContainText('其他会话同时修改了该文件');
    await expect(review).not.toContainText('文件在工具完成后发生变化');
    await collisionCard.scrollIntoViewIfNeeded();
    await app.evaluate(async (_electron, file) => (globalThis as any).__captureBaseline(file), path.join(root, '.tmp', 'turn-collision-before-revert.png'));
    await collisionCard.getByRole('button', { name: '回退本轮' }).click();
    await expect(collisionCard.getByRole('alert')).toContainText('concurrent.txt：其他会话同时修改了该文件，已保留当前内容：会话 B');
    await app.evaluate(async (_electron, file) => (globalThis as any).__captureBaseline(file), path.join(root, '.tmp', 'turn-collision-after-revert.png'));
    expect(fs.readFileSync(path.join(dir, 'work/concurrent.txt'), 'utf8')).toBe('B2');
  } finally {
    await app?.close();
    expect(dir.startsWith(path.join(root, '.tmp') + path.sep)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
