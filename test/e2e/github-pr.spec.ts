/** Production Electron, Git, preload, GitHub service and PR UI. GitHub transport and OS cipher are fixtures. */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { PrVersion } from '../../src/shared/githubPr';
import { test, expect, repoRoot } from './fixtures/electron';

test.use({ isolatedSandbox: true });
delete process.env.MUSTER_GITHUB_APP_CLIENT_ID;
delete process.env.MUSTER_GITHUB_APP_SLUG;

test('connects the built-in GitHub App, grants repository access and confirms publication', async ({ appCtx }) => {
  const { app, win } = appCtx;
  const publishedReviews = () => app.evaluate(() => (globalThis as typeof globalThis & { fixtureGitHubReviews: unknown[] }).fixtureGitHubReviews);
  await app.evaluate(({ net, safeStorage, shell }) => {
    const nativeFetch = net.fetch.bind(net);
    const published: unknown[] = [];
    const externalUrls: string[] = [];
    const access = { installed: false };
    Object.assign(globalThis, { fixtureGitHubReviews: published, fixtureGitHubLinks: externalUrls, fixtureGitHubAccess: access });
    Object.assign(shell, { openExternal: async (url: string) => { externalUrls.push(url); } });
    Object.assign(safeStorage, {
      isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (text: string) => Buffer.from(text).reverse(), decryptString: (data: Buffer) => Buffer.from(data).reverse().toString()
    });
    Object.assign(net, {
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.hostname === 'github.com' && url.pathname === '/login/device/code') {
          if ((init?.body as URLSearchParams).get('client_id') !== 'Iv23li38wcr7NdVRUeV3') return new Response(null, { status: 400 });
          return Response.json({ device_code: 'device-only', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device',
            expires_in: 900, interval: 1 });
        }
        if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
          return Response.json(externalUrls.includes('https://github.com/login/device')
            ? { access_token: 'test-token' } : { error: 'authorization_pending' });
        }
        if (url.hostname !== 'api.github.com') return nativeFetch(input, init);
        if (url.pathname === '/user') return Response.json({ login: 'fixture-user' });
        if (url.pathname === '/user/installations') {
          return Response.json({ installations: access.installed ? [{ id: 1, account: { login: 'fixture' },
            repository_selection: 'all', permissions: { pull_requests: 'write', contents: 'read', checks: 'read', statuses: 'read' } }] : [] });
        }
        if (url.pathname === '/repos/fixture/review-repo') return Response.json({ full_name: 'fixture/review-repo', default_branch: 'main' });
        const summary = { number: 7, title: 'Review reconnect behavior', state: 'OPEN', isDraft: false, body: 'Reconnect review.',
          headRefName: 'topic', baseRefName: 'main', author: { login: 'alice' }, updatedAt: '2026-11-24T01:00:00Z',
          reviewDecision: 'REVIEW_REQUIRED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          repository: { nameWithOwner: 'fixture/review-repo' } };
        if (url.pathname === '/graphql') {
          const query = String(init?.body ?? '');
          if (query.includes('query MusterPullRequests(')) {
            return Response.json({ data: { search: { nodes: [summary], pageInfo: {} } } });
          }
          return Response.json({ data: { repository: { pullRequest: { ...summary, headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
            headRepository: { nameWithOwner: 'fixture/review-repo' },
            reviewThreads: { pageInfo: {}, nodes: [] }, discussion: { nodes: [] }, decisions: { nodes: [] } } } } });
        }
        if (url.pathname === '/repos/fixture/review-repo/pulls/7') {
          return Response.json({ state: 'open', head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } });
        }
        if (url.pathname === '/repos/fixture/review-repo/pulls/7/files') {
          const retryTests = ['+it("resumes a session once", () => {', '+  reconnect(connection);',
            '+  expect(connection.retrying).toBe(true);',
            ...Array.from({ length: 28 }, (_, attempt) => `+  expect(retrySchedule[${attempt}]).toBe(${100 * (attempt + 1)});`), '+});'];
          return Response.json([
            { filename: 'src/connection/state.ts', status: 'modified', additions: 3, deletions: 1, patch: [
              '@@ -18,5 +18,7 @@',
              ' export function reconnect(state: ConnectionState) {',
              '-  if (state.closed) return;',
              '+  if (state.closed || state.retrying) return;',
              '+  state.retrying = true;',
              '   transport.resume(state.sessionId);',
              '+  scheduleHealthCheck(state.sessionId);',
              '   markConnected(state);',
              ' }'
            ].join('\n') },
            { filename: 'test/connection/reconnect.spec.ts', status: 'added', additions: retryTests.length, deletions: 0,
              patch: [`@@ -0,0 +1,${retryTests.length} @@`, ...retryTests].join('\n') },
            { filename: 'docs/connection.md', status: 'modified', additions: 1, deletions: 1,
              patch: '@@ -12 +12 @@\n-Reconnect when the transport is closed.\n+Schedule a health check after reconnecting.' },
            { filename: 'assets/topology.png', status: 'modified', additions: 0, deletions: 0 }
          ]);
        }
        if (url.pathname === '/repos/fixture/review-repo/pulls/7/reviews') {
          published.push(JSON.parse(String(init?.body)));
          return Response.json({ id: 101, html_url: 'https://github.com/fixture/review-repo/pull/7#pullrequestreview-101' });
        }
        return new Response(null, { status: 404 });
      }
    });
  });
  expect(await win.evaluate(() => window.api.pr.connection())).toEqual({ ok: true, value: { state: 'signedOut' } });
  expect(await win.evaluate(() => window.api.pr.appSetup())).toMatchObject({ ok: true, value: { source: 'default', active: { slug: 'muster-console' } } });
  const cwd = await app.evaluate(() => process.cwd());
  const repos = await win.evaluate(() => window.api.git.listRepos());
  for (const repo of repos) {
    const relative = path.relative(cwd, repo.path);
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
    const remotes = execFileSync('git', ['-C', repo.path, 'remote'], { encoding: 'utf8' });
    execFileSync('git', ['-C', repo.path, 'remote', remotes.split(/\r?\n/).includes('origin') ? 'set-url' : 'add',
      'origin', 'git@github.com:fixture/review-repo.git']);
  }
  expect(repos.length).toBeGreaterThan(0);
  await win.bringToFront();
  await win.keyboard.press('Escape');
  const gitPage = win.locator('.side-tools-panel.is-active');
  if (!await gitPage.isVisible()) await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
  await gitPage.waitFor({ timeout: 15_000 });
  await gitPage.getByRole('tablist', { name: '资源面板' }).getByRole('tab', { name: 'Git', exact: true }).click();
  await win.locator('.git-repo-tree-leaf').first().click({ timeout: 20_000 });
  await gitPage.getByRole('button', { name: 'PR', exact: true }).click();
  const captureDirectory = process.env.MUSTER_PR_CAPTURE === '1' ? path.join(repoRoot, '.tmp/ui-captures/github-pr') : undefined;
  if (captureDirectory) {
    fs.mkdirSync(captureDirectory, { recursive: true });
    await gitPage.getByRole('separator', { name: '调整资源面板宽度' }).press('End');
    await gitPage.locator('.git-pr-pane').screenshot({ path: path.join(captureDirectory, 'official-connect.png'), animations: 'disabled' });
  }
  await win.getByRole('button', { name: '连接 GitHub', exact: true }).click();
  await expect(win.getByText('ABCD-1234')).toBeVisible();
  await expect(win.getByRole('button', { name: '复制授权码并打开 GitHub' })).toBeFocused();
  await win.getByRole('button', { name: '打开 GitHub 授权' }).click();
  const install = win.getByRole('button', { name: '在 GitHub 授权仓库' });
  await expect(install).toBeVisible();
  if (captureDirectory) {
    for (const theme of ['dark', 'light']) {
      await win.evaluate(value => window.api.themes.activate(value), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await gitPage.locator('.git-pr-pane').screenshot({ path: path.join(captureDirectory, `official-repository-${theme}.png`), animations: 'disabled' });
    }
  }
  await install.click();
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { fixtureGitHubLinks: string[] }).fixtureGitHubLinks)).toEqual([
    'https://github.com/login/device', 'https://github.com/apps/muster-console/installations/new'
  ]);
  await app.evaluate(() => { (globalThis as typeof globalThis & { fixtureGitHubAccess: { installed: boolean } }).fixtureGitHubAccess.installed = true; });
  await gitPage.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(install).toBeHidden();
  await win.getByRole('button', { name: '待我审' }).click();
  await win.getByRole('button', { name: /Review reconnect behavior/ }).click();
  const pane = gitPage.locator('.git-pr-pane');
  const resourcesDivider = gitPage.getByRole('separator', { name: '调整资源面板宽度' });
  await resourcesDivider.press('Home');
  await expect.poll(async () => (await pane.boundingBox())?.width ?? 0).toBeGreaterThan(560);
  const changes = win.getByRole('region', { name: '变更文件' });
  const files = changes.getByRole('list', { name: '变更文件' });
  const divider = changes.getByRole('separator', { name: '拖动调整变更列表与 Diff 宽度' });
  const statePath = 'src/connection/state.ts';
  const testPath = 'test/connection/reconnect.spec.ts';
  const stateFile = files.getByRole('button', { name: statePath });
  const testFile = files.getByRole('button', { name: testPath });
  const stateDiff = changes.getByRole('region', { name: statePath });
  await expect(stateFile).toHaveAttribute('aria-current', 'true');
  await expect(stateDiff).toContainText('scheduleHealthCheck(state.sessionId);');
  expect((await files.boundingBox())!.x).toBeLessThan((await stateDiff.boundingBox())!.x);
  await expect(divider).toBeVisible();
  const defaultRatio = Number(await divider.getAttribute('aria-valuenow'));
  await divider.press('ArrowRight');
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(defaultRatio);
  const handle = (await divider.boundingBox())!;
  const handleX = handle.x + handle.width / 2;
  const handleY = handle.y + handle.height / 2;
  await win.mouse.move(handleX, handleY);
  await win.mouse.down();
  await win.mouse.move(handleX + 40, handleY, { steps: 4 });
  await win.mouse.up();
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(defaultRatio + 3);
  await testFile.press('Enter');
  await expect(testFile).toHaveAttribute('aria-current', 'true');
  const testDiff = changes.getByRole('region', { name: testPath });
  await expect(testDiff).toContainText('expect(connection.retrying).toBe(true);');
  expect(await testDiff.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(stateDiff).toHaveCount(0);
  await stateFile.click();
  if (captureDirectory) {
    await pane.locator('.pr-review-scroll').evaluate(element => { element.scrollTop = 0; });
    for (const theme of ['dark', 'light']) {
      await win.evaluate(value => window.api.themes.activate(value), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await pane.screenshot({ path: path.join(captureDirectory, `review-split-${theme}.png`), animations: 'disabled' });
    }
  }
  await resourcesDivider.press('End');
  await expect.poll(async () => (await pane.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(420);
  await expect(divider).toBeHidden();
  await expect(stateFile).toHaveAttribute('aria-current', 'true');
  expect((await files.boundingBox())!.y).toBeLessThan((await stateDiff.boundingBox())!.y);
  if (captureDirectory) {
    await pane.locator('.pr-review-scroll').evaluate(element => { element.scrollTop = 0; });
    await pane.screenshot({ path: path.join(captureDirectory, 'review-stacked-light.png'), animations: 'disabled' });
  }

  const reviewBody = win.getByLabel('评审正文');
  await expect(reviewBody).toHaveValue('');
  const confirmation = win.getByRole('dialog', { name: '发布 GitHub 评审' });
  const approve = win.getByRole('button', { name: '批准…', exact: true });
  if (captureDirectory) {
    await approve.scrollIntoViewIfNeeded();
    await pane.screenshot({ path: path.join(captureDirectory, 'approve-action-narrow.png'), animations: 'disabled' });
  }
  await approve.click();
  await expect(confirmation).toContainText('「批准」');
  await expect(confirmation).toContainText('fixture/review-repo#7');
  await expect(confirmation.getByRole('button', { name: '取消' })).toBeFocused();
  expect(await publishedReviews()).toEqual([]);
  if (captureDirectory) {
    for (const theme of ['dark', 'light']) {
      await win.evaluate(value => window.api.themes.activate(value), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await win.screenshot({ path: path.join(captureDirectory, `approve-confirm-${theme}.png`), animations: 'disabled' });
    }
  }
  await confirmation.getByRole('button', { name: '发布', exact: true }).click();
  await expect(win.getByText('评审已发布到 GitHub')).toBeVisible();
  const desktopApproval = { commit_id: 'a'.repeat(40), event: 'APPROVE', body: '', comments: [] };
  expect(await publishedReviews()).toEqual([desktopApproval]);

  await expect(confirmation).toBeHidden();
  const lineComment = stateDiff.getByRole('button', { name: '评论第 22 行' });
  await lineComment.hover();
  await expect(lineComment.locator('svg')).toHaveCSS('opacity', '1');
  await lineComment.click();
  const inlineComment = win.getByRole('textbox', { name: `${statePath}:22 · RIGHT`, exact: true });
  await expect(inlineComment).toBeFocused();
  await inlineComment.pressSequentially('Explain when the health check runs.');
  await testFile.click();
  await expect(inlineComment).toHaveValue('Explain when the health check runs.');
  await test.step('切屏保留打开的 PR、选中文件和行内草稿', async () => {
    const switchScreen = async () => {
      await win.locator('.chrome-right-toggle').focus();
      await win.keyboard.press('Control+Shift+\\');
    };
    await inlineComment.evaluate(element => { (element as HTMLElement).dataset.testPrDraft = 'retained'; });
    await switchScreen();
    await expect(win.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
    await expect(win.locator('.git-pr-pane [data-test-pr-draft]')).toHaveValue('Explain when the health check runs.');
    await switchScreen();
    await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
    await expect(inlineComment).toHaveAttribute('data-test-pr-draft', 'retained');
    await expect(inlineComment).toHaveValue('Explain when the health check runs.');
    await expect(testFile).toHaveAttribute('aria-current', 'true');
    if (captureDirectory) {
      await pane.screenshot({ path: path.join(captureDirectory, 'review-resumed.png'), animations: 'disabled' });
    }
  });
  await reviewBody.fill('Check the reconnect path');
  await reviewBody.press('End');
  await reviewBody.press('Period');
  await expect(reviewBody).toHaveValue('Check the reconnect path.');
  await win.getByRole('button', { name: '发布评审…' }).click();
  await expect(confirmation).toContainText('「发表评论」');
  expect(await publishedReviews()).toEqual([desktopApproval]);
  await confirmation.getByRole('button', { name: '发布', exact: true }).click();
  await expect(win.getByText('评审已发布到 GitHub')).toBeVisible();
  const desktopReviews = [desktopApproval, {
    commit_id: 'a'.repeat(40), event: 'COMMENT', body: 'Check the reconnect path.',
    comments: [{ path: statePath, line: 22, side: 'RIGHT', body: 'Explain when the health check runs.' }]
  }];
  expect(await publishedReviews()).toEqual(desktopReviews);

  const worker = await win.evaluate(cwd => window.api.sessions.create({ cwd, runtime: 'pi', force: true,
    name: 'GitHub 工具验收' }), repos[0]!.path);
  expect(worker.statusToken).toBeTruthy();
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const shellBase = JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')).baseUrl as string;
  const invoke = (action: string, params: Record<string, unknown>, token?: string) => fetch(`${shellBase}/v1/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name: 'host.github.run', arguments: { action, params }, resultView: 'model' })
  });
  expect((await invoke('detail', { number: 7 })).status).toBe(401);
  const details = await (await invoke('detail', { number: 7 }, worker.statusToken)).json() as {
    ok: boolean; result: { version: PrVersion; checks: string };
  };
  expect(details).toMatchObject({ ok: true, result: { checks: 'pass', version: {
    repository: 'fixture/review-repo', number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40)
  } } });

  const review = { version: details.result.version, event: 'COMMENT', body: 'Agent review from the same account.' };
  const sendReview = async () => (await invoke('publish', review, worker.statusToken)).json();
  const approval = win.getByRole('dialog', { name: 'GitHub · 发布评审', exact: true });
  const declined = sendReview();
  void declined.catch(() => {});
  await expect(approval).toContainText(review.body);
  await expect(approval).toContainText('fixture-user');
  await approval.getByRole('button', { name: '取消', exact: true }).click();
  expect(await declined).toMatchObject({ ok: false });
  const confirmed = sendReview();
  void confirmed.catch(() => {});
  await expect(approval).toBeVisible();
  expect(await publishedReviews()).toEqual(desktopReviews);
  await approval.getByRole('button', { name: '发布评审', exact: true }).click();
  expect(await confirmed).toMatchObject({ ok: true, result: { url: expect.stringContaining('pullrequestreview-101') } });
  expect(await publishedReviews()).toEqual([
    ...desktopReviews,
    { commit_id: 'a'.repeat(40), event: 'COMMENT', body: review.body, comments: [] }
  ]);
});
