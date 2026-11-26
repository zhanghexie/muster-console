import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const project = path.resolve(__dirname, '../..');

test('调度并排对话居中、横向滚动、独立调整尺寸，并通过真实 IPC 分区发送', async ({}, info) => {
  test.setTimeout(95_000);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-scheduler-overview-'));
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', uiFont: 'system', activeWorkspaceId: 'demo-playground', workspaces: [],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');

  const prompts = ['核对工作区默认配置', '检查前端窄屏行为'];
  const replies = ['默认配置已核对，工作区可以正常打开。', '窄屏检查完毕，可以横向切换工作区对话。'];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const last = JSON.stringify(JSON.parse(body).messages?.at(-1) ?? {});
      const reply = replies[prompts.findIndex(prompt => last.includes(prompt))] ?? '检查完成。';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({
        id: 'scheduler-overview', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      response.end(chunk({ content: reply }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd) } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT',
    'MUSTER_NO_SANDBOX', 'MUSTER_DEV_MOBILE_WS']) delete env[key];

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [project], cwd, env });
    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    const resize = (width: number) => app!.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMaximized()) window.unmaximize();
      window.setMinimumSize(640, 600);
      window.setSize(width, 760);
    }, width);
    await resize(1160);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(1160);
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    await win.locator('.app-shell').waitFor();
    await win.evaluate(async baseUrl => {
      await window.api.config.update({ llm: {
        activeProviderId: 'overview-local', activeModelId: 'mock',
        providers: [{ id: 'overview-local', name: 'Local', enabled: true, api: 'openai-completions',
          baseUrl, apiKey: 'fixture', models: [{ id: 'mock', name: 'Mock' }] }]
      } });
    }, `http://127.0.0.1:${port}/v1`);

    const { workspaces, activeWorkspaceId } = await win.evaluate(() => window.api.workspaces.list());
    expect(workspaces).toHaveLength(3);
    const trigger = win.getByRole('button', { name: '展开并排对话' });
    const stackTitle = win.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-ws-stack-label');
    const expand = async () => {
      await stackTitle.hover();
      await trigger.click();
    };
    await expect(trigger).toBeVisible();
    await win.mouse.move(700, 250);
    await expect(trigger).toHaveCSS('opacity', '0');
    await expect(trigger).toHaveCSS('width', '24px');
    await expect(async () => {
      await stackTitle.hover();
      await expect(trigger).toHaveCSS('opacity', '1', { timeout: 500 });
    }).toPass({ timeout: 5_000 });
    await win.screenshot({ path: info.outputPath('workspace-entry.png') });
    await win.mouse.move(700, 250);
    await expect(trigger).toHaveCSS('opacity', '0');
    await win.keyboard.press('Tab');
    await trigger.focus();
    await expect(trigger).toHaveCSS('opacity', '1');
    const single = win.locator('.agent-float-anchor > .agent-float-panel');
    const singleBackdrop = win.locator('.agent-float-backdrop');
    const workArea = win.locator('.workspace-page > .terminal-page');
    await win.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
    await expect(single).toHaveCSS('opacity', '1');
    const singleMaterial = await singleBackdrop.evaluate(element => {
      const { backgroundColor, backdropFilter } = getComputedStyle(element);
      return { backgroundColor, backdropFilter };
    });
    const singleWorkAreaFilter = await workArea.evaluate(element => getComputedStyle(element).filter);
    const singleCardBackground = await single.evaluate(element => getComputedStyle(element).backgroundColor);
    await win.screenshot({ path: info.outputPath('single-chat-backdrop.png') });
    await single.getByRole('button', { name: '收起', exact: true }).click();
    await expect(single).toHaveCount(0);

    await win.evaluate(() => {
      document.addEventListener('transitionrun', event => {
        if (event.propertyName === 'opacity' && event.target instanceof HTMLElement
          && event.target.matches('.scheduler-overview-card')) {
          const column = event.target;
          const stage = column.dataset.mpStage;
          const workspaceId = column.parentElement?.dataset.schedulerWorkspace;
          if (!workspaceId) return;
          const sample = () => {
            if (!column.isConnected || column.dataset.mpStage !== stage) return;
            const { opacity, transform } = getComputedStyle(column);
            const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
            if (Number(opacity) > 0 && Number(opacity) < 1 && matrix.m41 < 0 && matrix.m42 > 0 && matrix.m11 < 1) {
              const attr = `data-overview-motion-${stage}`;
              const seen = document.documentElement.getAttribute(attr)?.split(' ') ?? [];
              if (!seen.includes(workspaceId)) document.documentElement.setAttribute(attr, [...seen, workspaceId].join(' '));
            } else if (column.getAnimations().some(animation => animation.playState === 'running')) {
              requestAnimationFrame(sample);
            }
          };
          requestAnimationFrame(sample);
        }
      });
    });
    await expand();
    await win.screenshot({ path: info.outputPath('overview-entering.png'), animations: 'allow' });
    const overview = win.getByRole('dialog', { name: '工作区对话' });
    const track = overview.locator('.scheduler-overview-track');
    const scroller = overview.getByRole('region', { name: '工作区对话列表' });
    const card = (id: string) => track.locator(`[data-scheduler-workspace="${id}"]`);
    const panels = track.locator('.scheduler-overview-card');
    const background = win.locator('.scheduler-overview-backdrop');
    const body = win.locator('body');
    const nativeMaterial = await win.locator('html').getAttribute('data-native-material');
    await expect(panels).toHaveCount(3);
    await expect(background).toHaveCSS('background-color', singleMaterial.backgroundColor);
    await expect(background).toHaveCSS('backdrop-filter', singleMaterial.backdropFilter);
    await expect(body).toHaveCSS('will-change', nativeMaterial === 'vibrancy' ? 'opacity' : 'auto');
    await expect(workArea).toHaveCSS('filter', singleWorkAreaFilter);
    await expect(panels.first()).toHaveCSS('background-color', singleCardBackground);
    await expect.poll(async () => {
      const ids = await win.locator('html').getAttribute('data-overview-motion-in');
      return ids?.split(' ').sort();
    }).toEqual(workspaces.map(workspace => workspace.id).sort());
    expect(await overview.evaluate(element => element.getAnimations().length)).toBe(0);
    const delays = await panels.evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).transitionDelay)));
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    await expect(win.locator('.main-view')).toHaveAttribute('inert', '');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);

    // Removing a workspace from the isolated fixture exercises live membership and makes both cards fit.
    const first = workspaces.find(workspace => workspace.id === activeWorkspaceId)!;
    const others = workspaces.filter(workspace => workspace.id !== activeWorkspaceId);
    expect((await win.evaluate(id => window.api.workspaces.close(id), others[1].id)).ok).toBe(true);
    await expect(track.locator('.scheduler-overview-card')).toHaveCount(2);
    await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect.poll(() => track.evaluate(element => {
      const viewport = element.parentElement!.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return Math.abs((row.left - viewport.left) - (viewport.right - row.right));
    })).toBeLessThan(2);

    const cards = [card(first.id), card(others[0].id)];
    for (const [index, column] of cards.entries()) {
      const editor = column.locator('.composer-editable');
      await editor.fill(prompts[index]);
      await editor.press('Enter');
    }
    for (const [index, column] of cards.entries()) {
      await expect(column.getByText(replies[index], { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(column.getByText(replies[1 - index], { exact: true })).toHaveCount(0);
    }
    const ids = [first.id, others[0].id];
    const histories = await win.evaluate(ids => Promise.all(ids.map(async id => {
      const page = await window.api.chat.historyRange(id);
      return page.messages.filter(message => message.role === 'user' && !message.host).map(message => message.content);
    })), ids);
    expect(histories).toEqual(prompts.map(prompt => [prompt]));
    expect((await win.evaluate(() => window.api.workspaces.list())).activeWorkspaceId).toBe(activeWorkspaceId);
    await expect(win.getByText('正在保存文件并关闭工作区…', { exact: true })).toBeHidden();

    const arrange = overview.getByRole('button', { name: '整理' });
    const handle = cards[0].getByRole('button', { name: `调整 ${first.name} 面板大小` });
    await expect(arrange).toBeDisabled();
    await expect(overview.getByRole('button', { name: '打开单独对话' })).toHaveCount(0);
    const defaultLeft = (await cards[0].boundingBox())!;
    const defaultRight = (await cards[1].boundingBox())!;
    expect(defaultLeft.width).toBeGreaterThan(420);
    expect(defaultLeft.width).toBe(defaultRight.width);
    const grip = (await handle.boundingBox())!;
    const gripX = grip.x + grip.width / 2;
    const gripY = grip.y + grip.height / 2;
    await win.mouse.move(gripX, gripY);
    await win.mouse.down();
    await win.mouse.move(gripX + 60, gripY + 95, { steps: 6 });
    await expect(cards[0]).toHaveAttribute('data-resizing', '');
    await expect.poll(async () => (await cards[0].boundingBox())!.height).toBeLessThan(defaultLeft.height - 90);
    await win.mouse.up();
    await expect(cards[0]).not.toHaveAttribute('data-resizing');
    const resized = (await cards[0].boundingBox())!;
    expect(resized.width).toBeGreaterThan(defaultLeft.width + 100);
    expect(Math.abs(resized.x + resized.width - (defaultLeft.x + defaultLeft.width + 60))).toBeLessThan(3);
    expect(Math.abs(resized.y + resized.height - (defaultLeft.y + defaultLeft.height))).toBeLessThan(2);
    const unchanged = (await cards[1].boundingBox())!;
    expect(unchanged.width).toBe(defaultRight.width);
    expect(unchanged.height).toBe(defaultRight.height);
    await win.mouse.move(20, 50);
    await win.screenshot({ path: info.outputPath('overview-resized.png') });
    await arrange.evaluate((button, { firstId, secondId, from, to, rightFrom, rightTo }) => {
      const track = button.closest('.scheduler-overview-sheet')!.querySelector<HTMLElement>('.scheduler-overview-track')!;
      const slots = Array.from(track.children) as HTMLElement[];
      const leftSlot = slots.find(slot => slot.dataset.schedulerWorkspace === firstId)!;
      const rightSlot = slots.find(slot => slot.dataset.schedulerWorkspace === secondId)!;
      const between = (value: number, a: number, b: number) => value > Math.min(a, b) + 1 && value < Math.max(a, b) - 1;
      button.addEventListener('click', () => {
        let remainingFrames = 20;
        const sample = () => {
          const left = leftSlot.getBoundingClientRect();
          const right = rightSlot.getBoundingClientRect();
          if (between(left.x, from.x, to.x) && between(left.y, from.y, to.y)
            && between(left.width, from.width, to.width) && between(left.height, from.height, to.height)
            && between(right.x, rightFrom, rightTo)) {
            track.dataset.sampledArrange = 'true';
            // Capture a real intermediate frame for visual review, then resume the transitions.
            for (const slot of slots) for (const motion of slot.getAnimations()) motion.pause();
          } else if (--remainingFrames) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true });
    }, { firstId: first.id, secondId: others[0].id, from: resized, to: defaultLeft, rightFrom: unchanged.x, rightTo: defaultRight.x });
    await arrange.click();
    await expect(track).toHaveAttribute('data-sampled-arrange', 'true');
    await win.screenshot({ path: info.outputPath('overview-arranging.png'), animations: 'allow' });
    await track.evaluate(element => {
      for (const slot of element.children) for (const motion of slot.getAnimations()) motion.play();
    });
    await expect.poll(() => cards[0].boundingBox()).toEqual(defaultLeft);
    await expect.poll(() => cards[1].boundingBox()).toEqual(defaultRight);
    await expect(track).not.toHaveAttribute('data-arranging');
    await expect(arrange).toBeDisabled();

    const wideGrip = (await handle.boundingBox())!;
    const wideGripX = wideGrip.x + wideGrip.width / 2;
    const wideGripY = wideGrip.y + wideGrip.height / 2;
    await win.mouse.move(wideGripX, wideGripY);
    await win.mouse.down();
    await win.mouse.move(wideGripX + 145, wideGripY, { steps: 6 });
    await win.mouse.up();
    await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(20);
    await track.evaluate((element: HTMLElement) => {
      function sample(event: TransitionEvent): void {
        if (event.propertyName !== 'transform' || !(event.target instanceof HTMLElement)
          || event.target.parentElement !== element) return;
        const scroller = element.parentElement!;
        const scrollbarHeight = scroller.getBoundingClientRect().height - scroller.clientHeight;
        element.dataset.arrangeOverflow = `${getComputedStyle(scroller).overflowX}:${scrollbarHeight}`;
        element.removeEventListener('transitionrun', sample);
      }
      element.addEventListener('transitionrun', sample);
    });
    await arrange.click();
    await expect(track).toHaveAttribute('data-arrange-overflow', 'clip:0');
    await expect.poll(() => cards[0].boundingBox()).toEqual(defaultLeft);

    const currentStatus = cards[0].getByRole('button', { name: '更改面板状态（未标记）' });
    await expect(currentStatus.locator('.filter-color-dot')).toHaveCSS('corner-top-left-shape', 'round');
    await currentStatus.hover();
    const palette = cards[0].getByRole('group', { name: '选择面板状态' });
    const working = palette.getByRole('button', { name: '进行中' });
    await working.hover();
    await expect(win.getByRole('tooltip').getByText('进行中', { exact: true })).toBeVisible();
    await win.screenshot({ path: info.outputPath('overview-status-strip.png') });
    await working.click();
    const workingStatus = cards[0].getByRole('button', { name: '更改面板状态（进行中）' });
    await expect(workingStatus).toBeVisible();
    await expect(palette).toHaveCount(0);
    await win.keyboard.press('Tab');
    await workingStatus.focus();
    await expect(palette).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(overview).toBeVisible();

    const filter = overview.getByRole('button', { name: '按状态筛选' });
    const statusMenu = overview.getByRole('group', { name: '按状态筛选' });
    await filter.click();
    await statusMenu.getByRole('checkbox', { name: '未标记' }).uncheck();
    await expect(cards[0]).toBeVisible();
    await expect(cards[1]).toBeHidden();
    await expect(filter).toHaveAttribute('data-filtered', 'true');
    await statusMenu.getByRole('button', { name: '新增状态' }).click();
    await statusMenu.getByRole('textbox', { name: '状态名称' }).fill('等待评审');
    await statusMenu.getByRole('radio', { name: '紫色' }).check();
    await win.screenshot({ path: info.outputPath('overview-status-edit.png') });
    await statusMenu.getByRole('button', { name: '保存' }).click();
    await expect(statusMenu.getByRole('checkbox', { name: '等待评审' })).toBeChecked();
    await win.mouse.move(20, 100);
    await win.screenshot({ path: info.outputPath('overview-status-filter.png') });
    await win.mouse.click(20, 100);
    await expect(statusMenu).toHaveCount(0);
    await expect(overview).toBeVisible();
    await filter.click();
    await statusMenu.getByRole('checkbox', { name: '显示全部状态' }).check();
    await expect(cards[1].getByText(replies[1], { exact: true })).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(statusMenu).toHaveCount(0);
    await expect(filter).toBeFocused();

    await win.mouse.move(20, 50);
    await overview.getByRole('button', { name: '收起并排对话' }).focus();
    await win.screenshot({ path: info.outputPath('overview-dark-centered.png') });

    const leftBox = (await cards[0].boundingBox())!;
    const rightBox = (await cards[1].boundingBox())!;
    const insideY = leftBox.y + leftBox.height / 2;
    const insideX = leftBox.x + leftBox.width / 2;
    const gapX = (leftBox.x + leftBox.width + rightBox.x) / 2;
    await win.mouse.click(insideX, insideY);
    await win.mouse.move(gapX, insideY);
    await win.mouse.down();
    await win.mouse.move(insideX, insideY);
    await win.mouse.up();
    await expect(overview).toBeVisible();
    await win.mouse.click(gapX, insideY);
    await win.screenshot({ path: info.outputPath('overview-exiting.png'), animations: 'allow' });
    await expect.poll(async () => {
      const exitingIds = await win.locator('html').getAttribute('data-overview-motion-out');
      return exitingIds?.split(' ').sort();
    }).toEqual(ids.slice().sort());
    await expect(win.locator('.scheduler-overview')).toHaveCount(0);
    await expect(body).toHaveCSS('will-change', 'auto');
    await expect(workArea).toHaveCSS('filter', 'none');
    await expect(trigger).toHaveCSS('opacity', '0');
    await resize(680);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(680);
    await win.evaluate(() => window.api.themes.activate('light'));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await expand();
    await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(120);
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBe(0);
    await expect(panels.last()).toHaveCSS('opacity', '1');
    const topInset = await cards[0].evaluate(slot => {
      const scroller = slot.closest('.scheduler-overview-scroller')!;
      return slot.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
    expect(topInset).toBeGreaterThanOrEqual(4);
    const bounds = (await scroller.boundingBox())!;
    await win.mouse.move(bounds.x + 120, bounds.y + 180);
    await win.screenshot({ path: info.outputPath('overview-light-overflow.png') });
    await win.mouse.wheel(800, 0);
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
    await expect(cards[1].getByText(replies[1])).toBeInViewport();
    await win.screenshot({ path: info.outputPath('overview-light-scrolled.png') });
    await win.mouse.wheel(-800, 0);
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBe(0);

    await expect(cards[0].getByRole('button', { name: '更改面板状态（进行中）' })).toBeVisible();
    await filter.click();
    await expect(statusMenu.getByRole('checkbox', { name: '等待评审' })).toBeChecked();
    const menuBox = (await statusMenu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(680);
    await win.mouse.move(20, 100);
    await expect(statusMenu).toHaveCSS('opacity', '1');
    const coveredGrip = (await handle.boundingBox())!;
    expect(await statusMenu.evaluate((menu, grip) => {
      const hit = document.elementFromPoint(grip.x + grip.width / 2, grip.y + grip.height / 2);
      return menu.contains(hit);
    }, coveredGrip)).toBe(true);
    await win.screenshot({ path: info.outputPath('overview-status-filter-light.png') });
    await win.keyboard.press('Escape');
    await expect(statusMenu).toHaveCount(0);

    await win.keyboard.press('Escape');
    await expect(overview).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(win.locator('.main-view')).not.toHaveAttribute('inert');

    await win.emulateMedia({ reducedMotion: 'reduce' });
    await expand();
    await expect(overview).toHaveAttribute('data-mp-stage', 'in');
    expect(await panels.evaluateAll(elements => elements.every(element => element.getAnimations().length === 0))).toBe(true);
    const defaultWidth = (await cards[0].boundingBox())!.width;
    await handle.focus();
    await expect(handle).toBeFocused();
    await win.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await cards[0].boundingBox())!.width).toBeLessThan(defaultWidth);
    await arrange.focus();
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await cards[0].boundingBox())!.width).toBe(defaultWidth);
    await expect(track).not.toHaveAttribute('data-arranging');
    await overview.getByRole('button', { name: '收起并排对话' }).click();
    await expect(win.locator('.scheduler-overview')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
