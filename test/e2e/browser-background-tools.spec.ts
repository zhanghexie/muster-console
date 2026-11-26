import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test as base, expect, type ElectronApplication } from './fixtures/electron';

const html = `<!doctype html><title>Background browser tools</title>
  <style>
    html,body{margin:0} section{height:1000px}
    #top{background:#f00000} #middle{background:#00f000} #bottom{background:#0000f0}
    #canvas{display:block;width:120px;height:80px;background:white}
    #canvas:hover{background:black}
    #overflow{width:240px;height:100px;overflow:auto;scroll-behavior:smooth}
  </style>
  <script>
    // Capture the dialog methods before dom-ready, as an application script can.
    const confirmAtLoad = window.confirm, promptAtLoad = window.prompt;
    window.dialogResults = [];
    window.pointerEvents = [];
  </script>
  <section id="top">
    <button id="confirm">Confirm</button><button id="prompt">Prompt</button>
    <canvas id="canvas" width="120" height="80"></canvas>
    <div id="overflow" aria-label="Independent scroller" role="region"><div style="height:1200px">Scroll me</div></div>
  </section>
  <section id="middle"></section><section id="bottom"></section>
  <script>
    function report(value) { dialogResults.push(value); navigator.sendBeacon('/dialog-result', JSON.stringify(value)); }
    document.querySelector('#confirm').onclick = () => report(confirmAtLoad.call(window, 'Proceed?'));
    document.querySelector('#prompt').onclick = () => {
      try { report(promptAtLoad.call(window, 'Your answer', 'prefilled')); }
      catch (error) { report(error.message); }
    };
    for (const type of ['pointermove','pointerdown','pointerup','click']) {
      document.querySelector('#canvas').addEventListener(type, e => pointerEvents.push({
        type, x:e.clientX, y:e.clientY, trusted:e.isTrusted, activation:navigator.userActivation.isActive
      }));
    }
  </script>`;

interface BrowserFixture {
  frontId: string;
  tabId: string;
  url: string;
  dialogResults: unknown[];
  run<T = Record<string, unknown>>(action: string, params?: Record<string, unknown>, expectedSuccess?: boolean): Promise<T>;
  read<T>(expression: string): Promise<T>;
}

const test = base.extend<{ browserTools: BrowserFixture }>({
  browserTools: async ({ appCtx: { app, win } }, use) => {
    const dialogResults: unknown[] = [];
    const server = createServer(async (req, res) => {
      if (req.url === '/dialog-result') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        dialogResults.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let tabId: string | undefined, frontId: string | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      const url = `http://127.0.0.1:${address.port}`;
      const userData = await app.evaluate(({ app }) => app.getPath('userData'));
      const discovery = path.join(userData, 'shell-api.json');
      await expect.poll(() => fs.existsSync(discovery)).toBe(true);
      const { toolUrl } = JSON.parse(fs.readFileSync(discovery, 'utf8')) as { toolUrl: string };
      async function run<T>(action: string, params: Record<string, unknown> = {}, expectedSuccess = true): Promise<T> {
        const response = await fetch(toolUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ name: 'host.browser.run', arguments: { action, params: { ...(tabId ? { tabId } : {}), ...params } } })
        });
        expect(response.ok).toBe(true);
        const reply = await response.json() as { ok: boolean; result: T; error: T };
        expect(reply.ok, `${action}: ${JSON.stringify(reply)}`).toBe(expectedSuccess);
        return reply.ok ? reply.result : reply.error;
      }
      const front = await win.evaluate(url => window.api.browser.open({ url }), `${url}/front`);
      frontId = front.id;
      await win.evaluate(id => window.api.browser.activate({ id }), frontId);
      await win.locator(`webview[data-tab-id="${frontId}"][data-browser-presentation="foreground"]`).waitFor();
      const addressBar = win.locator('.browser-addr');
      await addressBar.fill('Unsubmitted foreground text');
      await addressBar.focus();
      tabId = (await run<{ id: string }>('open', { url })).id;
      await run('snapshot');
      const view = win.locator(`webview[data-tab-id="${tabId}"]`);
      const guestId = await view.evaluate(node => (node as Electron.WebviewTag).getWebContentsId());
      async function read<T>(expression: string): Promise<T> {
        return await app.evaluate(({ webContents }, { guestId, expression }) => {
          const guest = webContents.fromId(guestId);
          if (!guest || guest.isDestroyed()) throw new Error('Fixture guest was detached');
          return guest.executeJavaScript(expression);
        }, { guestId, expression }) as T;
      }
      await use({ frontId, tabId, url, dialogResults, run, read });
    } finally {
      await win.evaluate(async ids => {
        for (const id of ids) if (id) await window.api.browser.close({ id });
      }, [tabId, frontId]);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
test.use({ isolatedSandbox: true });

type SerializedDialog = { id: string; type: string; message: string; defaultValue: string };

test('manual confirm blocks the page and delivers the selected response', async ({ appCtx: { win }, browserTools }) => {
  const { run, read, dialogResults } = browserTools;
  await run('dialog', { action: 'policy', policy: 'manual' });
  for (const accept of [true, false]) {
    const count = dialogResults.length;
    const { pendingDialogs } = await run<{ pendingDialogs: SerializedDialog[] }>('click', { target: '#confirm' });
    expect(pendingDialogs).toMatchObject([{ type: 'confirm', message: 'Proceed?' }]);
    const { dialogs } = await run<{ dialogs: SerializedDialog[] }>('dialog', { action: 'list' });
    expect(dialogs).toEqual(pendingDialogs);
    expect(dialogResults).toHaveLength(count);
    const { id } = dialogs[0];
    expect(await run('dialog', { action: accept ? 'accept' : 'dismiss', dialogId: id })).toMatchObject({ ok: true, accepted: accept });
    expect(await read('dialogResults.at(-1)')).toBe(accept);
    await expect.poll(() => dialogResults.length).toBe(count + 1);
    expect(await run('dialog', { action: 'list' })).toMatchObject({ dialogs: [] });
    expect(await run('dialog', { action: 'accept', dialogId: id })).toMatchObject({ ok: false });
  }
  await run('evaluate', { expression: `new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.onload = () => resolve(true);
    frame.srcdoc = '<!doctype html><p>Same-origin child document</p>';
    document.body.append(frame);
  })` });
  const observeDialog = (): void => {};
  const context = win.context();
  // The fixture's second CDP client must leave the native reply to Muster.
  context.on('dialog', observeDialog);
  try {
    const native = await run<{ pendingDialogs: SerializedDialog[] }>('evaluate', {
      expression: "window.childAnswer = window.frames[0].confirm('Child confirm?')"
    });
    expect(native.pendingDialogs).toMatchObject([{ type: 'confirm', message: 'Child confirm?' }]);
    expect(await run('dialog', { action: 'accept', dialogId: native.pendingDialogs[0].id })).toMatchObject({ ok: true });
    expect(await read('window.childAnswer')).toBe(true);
  } finally {
    context.off('dialog', observeDialog);
  }
});

test('prompt registered before dom-ready receives Unicode, empty, default and cancel results', async ({ browserTools }) => {
  const { run, read, url } = browserTools;
  for (const [params, result] of [
    [{ action: 'accept', promptText: '你好 🌏' }, '你好 🌏'],
    [{ action: 'accept', promptText: '' }, ''],
    [{ action: 'accept' }, 'prefilled'],
    [{ action: 'dismiss' }, null]
  ] as const) {
    const { pendingDialogs } = await run<{ pendingDialogs: SerializedDialog[] }>('click', { target: '#prompt' });
    expect(pendingDialogs).toMatchObject([{ type: 'prompt', message: 'Your answer', defaultValue: 'prefilled' }]);
    expect(await run('dialog', { ...params, dialogId: pendingDialogs[0].id })).toMatchObject({ ok: true });
    expect(await read('dialogResults.at(-1)')).toBe(result);
  }
  await run('navigate', { input: `${url}/reload` });
  await run('dialog', { action: 'policy', policy: 'auto-accept' });
  await run('click', { target: '#prompt' });
  expect(await read('dialogResults')).toEqual(['prefilled']);
  await run('dialog', { action: 'policy', policy: 'auto-dismiss' });
  await run('click', { target: '#confirm' });
  expect(await read('dialogResults')).toEqual(['prefilled', false]);
});

async function screenshotColors(app: ElectronApplication, imagePath: string, rows: number[], column = .6) {
  return app.evaluate(({ nativeImage }, { imagePath, rows, column }) => {
    const image = nativeImage.createFromPath(imagePath), { width, height } = image.getSize();
    if (image.isEmpty()) throw new Error('Screenshot is empty');
    const bitmap = image.toBitmap();
    const colors = rows.map(row => {
      const offset = (Math.floor(height * row) * width + Math.floor(width * column)) * 4;
      return { r: bitmap[offset + 2], g: bitmap[offset + 1], b: bitmap[offset] };
    });
    return { width, height, colors: colors.map(({ r, g, b }) => r > g + 100 && r > b + 100 ? 'red'
      : g > r + 100 && g > b + 100 ? 'green' : b > r + 100 && b > g + 100 ? 'blue' : 'other') };
  }, { imagePath, rows, column });
}

test('full-page screenshot contains separate bands through the bottom and keeps scroll and focus', async ({ appCtx: { app, win }, browserTools }) => {
  const { run, read, frontId, tabId } = browserTools;
  await run('scroll', { amount: 175 });
  const before = await read<{ scroll: number; height: number; dpr: number }>('({ scroll:scrollY, height:innerHeight, dpr:devicePixelRatio })');
  expect(before.scroll).toBe(175);
  for (let index = 0; index < 2; index++) {
    const shot = await run<{ path: string }>('screenshot', { fullPage: true });
    const image = await screenshotColors(app, shot.path, [.15, .5, .92]);
    expect.soft(image.height).toBe(Math.round(3000 * before.dpr));
    expect.soft(image.colors).toEqual(['red', 'green', 'blue']);
    expect.soft(await read('scrollY')).toBe(before.scroll);
  }
  const view = win.locator(`webview[data-tab-id="${tabId}"]`);
  await expect(view).toHaveAttribute('data-browser-presentation', 'background');
  await expect(view).toHaveCSS('visibility', 'hidden');
  expect(await run('tabs', { tabId: undefined })).toMatchObject({ activeId: frontId });
  await expect(win.locator('.browser-addr')).toBeFocused();
  await expect(win.locator('.browser-addr')).toHaveValue('Unsubmitted foreground text');
  await run('scroll', { amount: 4000 });
  const viewportShot = await run<{ path: string }>('screenshot');
  expect((await screenshotColors(app, viewportShot.path, [.9])).colors).toEqual(['blue']);
  const wide = await run<{ value: { x: number; y: number; dpr: number } }>('evaluate', { expression: `
    document.body.style.minWidth = '2200px';
    document.querySelector('#bottom').style.background = 'linear-gradient(to right, #0000f0 70%, #f00000 70%)';
    window.scrollTo({ left: 120, top: 175, behavior: 'instant' });
    ({ x:scrollX, y:scrollY, dpr:devicePixelRatio })
  ` });
  const wideShot = await run<{ path: string }>('screenshot', { fullPage: true });
  const wideImage = await screenshotColors(app, wideShot.path, [.92], .9);
  expect(wideImage.width).toBe(Math.round(2200 * wide.value.dpr));
  expect(wideImage.colors).toEqual(['red']);
  expect(await read('[scrollX, scrollY]')).toEqual([wide.value.x, wide.value.y]);
});

test('scroll targets an independent container and viewport coordinates work on a canvas', async ({ appCtx: { win }, browserTools }) => {
  const { run, read, frontId } = browserTools;
  await run('scroll', { direction: 'up', amount: 4000 });
  await run('scroll', { target: '#overflow', amount: 250 });
  expect(await read('[scrollY, document.querySelector("#overflow").scrollTop]')).toEqual([0, 250]);
  const { snapshot } = await run<{ snapshot: string }>('snapshot', { selector: '#overflow' });
  const ref = snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  expect(ref).toBeTruthy();
  await run('scroll', { target: ref, direction: 'up', amount: 100 });
  expect(await read('[scrollY, document.querySelector("#overflow").scrollTop]')).toEqual([0, 150]);
  const point = await read<string>(`(() => { const r = document.querySelector('#canvas').getBoundingClientRect(); return (r.x + 31.5) + ',' + (r.y + 25); })()`);
  await run('movePointer', { target: point });
  expect(await read(`document.querySelector('#canvas').matches(':hover')`)).toBe(true);
  expect(await read(`getComputedStyle(document.querySelector('#canvas')).backgroundColor`)).toBe('rgb(0, 0, 0)');
  const [x, y] = point.split(',').map(Number);
  expect(await read('pointerEvents')).toContainEqual({ type: 'pointermove', x, y, trusted: true, activation: false });
  await run('click', { target: point });
  expect(await read('pointerEvents.slice(-3)')).toEqual(['pointerdown', 'pointerup', 'click'].map(type => ({
    type, x: type === 'click' ? Math.floor(x) : x, y: type === 'click' ? Math.floor(y) : y,
    trusted: false, activation: false
  })));
  await run('movePointer', { target: '300,50' });
  expect(await read(`document.querySelector('#canvas').matches(':hover')`)).toBe(false);
  expect(await run('movePointer', { target: '99999,50' }, false)).toContain('outside');
  expect(await run('click', { target: '-10,20' }, false)).toContain('semantic_action_failed');
  expect(await run('tabs', { tabId: undefined })).toMatchObject({ activeId: frontId });
  await expect(win.locator('.browser-addr')).toBeFocused();
});
