import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildWorkspaceFileUrl } from '../../src/shared/mediaKinds';

const { writePreviewFixtures } = require('./helpers/preview-fixtures.cjs');

test('两根同名文件的全格式预览与返回切换保持身份', async () => {
  test.setTimeout(150_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'preview-matrix-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'), initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const roots = { A: path.join(fixture, 'A'), B: path.join(fixture, 'B') };
  for (const label of ['A', 'B'] as const) writePreviewFixtures(roots[label], label);
  const originals = Object.fromEntries(Object.entries(roots).map(([label, root]) => [label,
    Object.fromEntries(fs.readdirSync(root).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]))]));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `preview-matrix-${process.pid}`, MUSTER_WEB_PORT: '0',
    APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    // Chromium generates actual playable bytes; both canvas and tracks are owned
    // and released even on recorder failure.
    for (const label of ['A', 'B'] as const) {
      const bytes = await win.evaluate(async label => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24; document.body.append(canvas);
        const stream = canvas.captureStream(0), chunks: Blob[] = [], track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        recorder.ondataavailable = event => chunks.push(event.data);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const stopped = new Promise<void>((resolve, reject) => { recorder.onstop = () => resolve(); recorder.onerror = () => reject(Error('recorder failed')); });
          recorder.start();
          for (let i = 0; i < 4; i++) {
            const context = canvas.getContext('2d')!; context.fillStyle = label === 'A' ? 'red' : 'blue'; context.fillRect(0, 0, 32, 24);
            track.requestFrame(); await new Promise<void>(resolve => { timer = setTimeout(resolve, 60); });
          }
          recorder.stop(); await stopped; return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
        } finally { clearTimeout(timer); if (recorder.state !== 'inactive') recorder.stop(); stream.getTracks().forEach(track => track.stop()); canvas.remove(); }
      }, label);
      expect(bytes.length).toBeGreaterThan(200); fs.writeFileSync(path.join(roots[label], 'same.webm'), Buffer.from(bytes));
      originals[label]['same.webm'] = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }
    const opened = await win.evaluate(async roots => (window as any).api.workspaces.open({ name: '全格式多根',
      roots: [{ id: 'A', label: 'Root A', path: roots.A }, { id: 'B', label: 'Root B', path: roots.B }], defaultRootId: 'A', controlRootId: 'A' }), roots);
    expect(opened.ok, opened.message).toBe(true);
    for (let i = 0; i < 5 && !await win.locator('.side-tools-panel.is-active').isVisible().catch(() => false); i++) {
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()); await win.keyboard.press('Control+Backslash');
      await win.waitForTimeout(300);
    }
    const side = win.locator('.side-tools-panel.is-active'); await side.waitFor();
    await side.getByRole('tab', { name: '文件', exact: true }).first().click();
    const files = win.locator('.files-panel.is-active'), editor = files.locator('.file-editor');
    const shots = path.join(project, '.tmp/ui-captures/workspace-preview-matrix'); fs.mkdirSync(shots, { recursive: true });
    const formats = ['txt', 'md', 'html', 'png', 'svg', 'wav', 'webm', 'pdf', 'docx', 'xlsx', 'xls', 'csv', 'pptx', 'zip', 'tar', 'tgz', 'gz', 'exe', 'unknown'];
    for (const ext of formats) for (const label of ['A', 'B', 'A'] as const) {
      const name = `same.${ext}`, ref = { workspaceId: opened.activeWorkspaceId, rootId: label, relativePath: name };
      await files.getByRole('tree', { name: `Root ${label}`, exact: true }).getByText(name, { exact: true }).click();
      if (['png', 'svg', 'wav', 'webm', 'pdf'].includes(ext)) {
        const tag = ext === 'pdf' ? 'iframe.file-media-pdf' : ext === 'wav' ? 'audio' : ext === 'webm' ? 'video' : 'img.file-media-img';
        await expect(editor.locator(tag)).toHaveAttribute('src', buildWorkspaceFileUrl(ref));
      }
      if (ext === 'txt') await expect(editor.locator('.cm-content')).toContainText(`${label} text`);
      else if (ext === 'md') await expect(editor.locator('.md-body')).toContainText(`${label} markdown`);
      else if (ext === 'html') await expect(win.frameLocator('iframe.file-editor-preview-html').locator('h1')).toHaveText(`${label} HTML`);
      else if (ext === 'docx') {
        const word = editor.locator('.file-doc > .file-doc-word');
        await expect(word).toContainText(`${label} DOCX`);
        // Fixed-width pages must start inside the scrollable viewport even when
        // the pane is narrower than the paper; the original centered page fails.
        expect(await word.evaluate(el => {
          const page = el.querySelector('section.docx')!, pane = el.closest('.file-doc')!;
          return page.getBoundingClientRect().left >= pane.getBoundingClientRect().left;
        })).toBe(true);
      }
      else if (['xlsx', 'xls', 'csv'].includes(ext)) await expect(editor.locator('.file-doc > .file-doc-sheet table')).toContainText(label);
      else if (ext === 'pptx') await expect(editor.locator('.file-doc-slide-title').first()).toHaveText(`${label} PPTX`);
      else if (['zip', 'tar', 'tgz'].includes(ext)) await expect(editor.locator('table.file-doc-archive')).toContainText(`${label}-member`);
      else if (ext === 'gz') await expect(editor.locator('table.file-doc-archive')).toContainText('same');
      else if (['png', 'svg'].includes(ext)) {
        await expect.poll(() => editor.locator('img.file-media-img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(ext === 'png' ? 64 : 32);
      } else if (['wav', 'webm'].includes(ext)) {
        const media = editor.locator(ext === 'wav' ? 'audio' : 'video');
        await expect.poll(() => media.evaluate(el => (el as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1);
        if (ext === 'wav') expect(await media.evaluate(el => (el as HTMLMediaElement).duration)).toBe(1);
        else {
          expect(await media.evaluate(el => [(el as HTMLVideoElement).videoWidth, (el as HTMLVideoElement).videoHeight])).toEqual([32, 24]);
          await media.evaluate(async el => { const video = el as HTMLVideoElement; video.muted = true; await video.play(); });
          await expect.poll(() => media.evaluate(el => (el as HTMLMediaElement).currentTime)).toBeGreaterThan(0);
        }
      } else if (ext === 'pdf') {
        await expect(editor.locator('iframe.file-media-pdf')).toBeVisible();
        // Visibility/bytes alone miss an unpainted PDF plugin. Wait for the
        // actual Chromium viewer to load this root's URL before capturing.
        await expect.poll(async () => {
          const viewer = win.frames().find(frame => frame.url().startsWith('chrome-extension:'));
          return viewer?.evaluate(() => { const v = document.querySelector('pdf-viewer') as any;
            return { state: v?.loadState_, url: v?.originalUrl }; }).catch(() => undefined);
        }).toEqual({ state: 'success', url: buildWorkspaceFileUrl(ref) });
      }
      else await expect(editor).toContainText(ext === 'exe' ? '暂不支持预览此格式' : '无法预览此文件');
      if (['png', 'svg', 'wav', 'webm', 'pdf'].includes(ext)) {
        const tag = ext === 'pdf' ? 'iframe.file-media-pdf' : ext === 'wav' ? 'audio' : ext === 'webm' ? 'video' : 'img.file-media-img';
        const url = await editor.locator(tag).getAttribute('src'); expect(url).toBe(buildWorkspaceFileUrl(ref));
        const bytes = await win.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), url!);
        expect(Buffer.from(bytes)).toEqual(fs.readFileSync(path.join(roots[label], name)));
      }
      if (label === 'B' && ['docx', 'xlsx', 'png', 'pdf', 'zip'].includes(ext)) await files.screenshot({ path: path.join(shots, `B-${ext}-dark.png`) });
    }
    // Markdown's relative link must retain B, despite A's identical filename.
    await files.getByRole('tree', { name: 'Root B', exact: true }).getByText('same.md', { exact: true }).click();
    await editor.getByRole('link', { name: /relative/ }).click(); await expect(editor.locator('.cm-content')).toContainText('B text');
    await win.evaluate(() => (window as any).api.themes.activate('light'));
    for (const ext of ['docx', 'xlsx', 'png', 'zip']) {
      await files.getByRole('tree', { name: 'Root B', exact: true }).getByText(`same.${ext}`, { exact: true }).click();
      if (ext === 'docx') await expect(editor.locator('.file-doc > .file-doc-word')).toContainText('B DOCX');
      else if (ext === 'xlsx') await expect(editor.locator('.file-doc > .file-doc-sheet table')).toContainText('B');
      else if (ext === 'zip') await expect(editor.locator('table.file-doc-archive')).toContainText('B-member');
      else await expect.poll(() => editor.locator('img.file-media-img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(64);
      await files.screenshot({ path: path.join(shots, `B-${ext}-light.png`) });
    }
    for (const [label, root] of Object.entries(roots)) for (const [name, hash] of Object.entries(originals[label])) {
      expect(createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), `${label}/${name}`).toBe(hash);
    }
  } finally { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(() => {}); }
});
