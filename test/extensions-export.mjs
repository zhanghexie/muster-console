import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-export-'));
try {
  const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extension-export-compile'));
  const { ExtensionMediaStore } = await import(pathToFileURL(compile('main/extensions/extensionMediaStore.ts')).href);
  const { ExtensionExportService } = await import(pathToFileURL(compile('main/extensions/extensionExportService.ts')).href);
  const media = new ExtensionMediaStore(temp);
  const source = path.join(temp, 'cover.png'); await fs.writeFile(source, Buffer.from('png-data'));
  const asset = await media.importFile('ws:desk', source);
  const service = new ExtensionExportService(media, temp);
  const result = await service.create('ws:desk', [{ name: 'script.md', text: '# Draft' }, { name: 'cover.png', assetId: asset.assetId }], 'Draft');
  assert.equal(await fs.readFile(path.join(result.directory, 'script.md'), 'utf8'), '# Draft');
  assert.equal(await fs.readFile(path.join(result.directory, 'cover.png'), 'utf8'), 'png-data');
  assert.deepEqual(await service.reveal('ws:desk', result.exportId), { ok: true });
  await assert.rejects(() => service.reveal('ws:other', result.exportId), /不属于当前扩展实例/);
  const preview = await service.create('ws:desk', [{ name: 'deck.html', text: '<h1>Deck</h1>' }], 'Deck');
  const url = await service.previewUrl('ws:desk', preview.exportId, 'deck.html');
  assert.equal(url, `muster-export://${preview.exportId}/deck.html`);
  assert.equal(await (await service.servePreview(new Request(url))).text(), '<h1>Deck</h1>');
  assert.equal((await service.servePreview(new Request(url, { method: 'POST' }))).status, 405);
  const head = await service.servePreview(new Request(url, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  await fs.writeFile(path.join(preview.directory, 'secret.html'), 'unregistered');
  assert.equal((await service.servePreview(new Request(new URL('secret.html', url)))).status, 404);
  assert.equal((await service.servePreview(new Request(new URL('..%2Fdeck.html', url)))).status, 404);
  assert.equal((await service.servePreview(new Request(url.replace(preview.exportId, 'unknown')))).status, 404);
  for (const [owner, name] of [['ws:other', 'deck.html'], ['ws:desk', '../deck.html'], ['ws:desk', 'other.html']]) {
    await assert.rejects(() => service.previewUrl(owner, preview.exportId, name));
  }
  await assert.rejects(() => service.previewUrl('ws:desk', result.exportId, 'script.md'));
  const project = path.join(temp, 'project');
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  await fs.mkdir(path.join(project, '.muster'), { recursive: true });
  for (const [name, text] of Object.entries({ 'index.html': '<link rel="stylesheet" href="assets/main.css"><script src="assets/main.js"></script>',
    'assets/main.css': 'body{color:red}', 'assets/main.js': 'window.ready=true;', 'assets/cover.svg': '<svg/>',
    'other.html': 'not an authorized entry', '.env': 'SECRET=1', '.muster/private.js': 'private',
    'package.json': '{}', 'config.js': 'secret configuration', 'notes.txt': 'private notes' })) {
    await fs.writeFile(path.join(project, name), text);
  }
  const projectUrl = await service.projectPreviewUrl(path.join(project, 'index.html'));
  const secondUrl = await service.projectPreviewUrl(path.join(project, 'index.html'));
  assert.notEqual(new URL(projectUrl).hostname, new URL(secondUrl).hostname, 'each authorized preview gets an isolated origin');
  for (const [name, text] of [['index.html', '<link'], ['assets/main.css', 'body'], ['assets/main.js', 'window'], ['assets/cover.svg', '<svg']]) {
    const response = await service.servePreview(new Request(new URL(name, projectUrl)));
    assert.equal(response.status, 200, name);
    assert.ok((await response.text()).startsWith(text));
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  const projectHead = await service.servePreview(new Request(new URL('assets/main.css', projectUrl), { method: 'HEAD' }));
  assert.equal(projectHead.status, 200); assert.equal(await projectHead.text(), '');
  for (const name of ['other.html', '.env', '.muster/private.js', 'package.json', 'config.js', 'notes.txt', '..%2Fcover.png', 'assets%5Cmain.js']) {
    assert.equal((await service.servePreview(new Request(new URL(name, projectUrl)))).status, 404, name);
  }
  const outside = path.join(temp, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'escape.css'), 'outside');
  await fs.symlink(outside, path.join(project, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await service.servePreview(new Request(new URL('assets/linked/escape.css', projectUrl)))).status, 404, 'symlink directory cannot escape the work directory');
  await fs.writeFile(path.join(project, 'assets', 'main.css'), 'body{color:blue}');
  assert.equal(await (await service.servePreview(new Request(new URL('assets/main.css', projectUrl)))).text(), 'body{color:blue}', 'local resources reflect edits');
  await assert.rejects(service.projectPreviewUrl(path.join(project, 'notes.txt')));
  await assert.rejects(service.projectPreviewUrl('relative.html'));
  media.stop();
  console.log('extensions-export: ok');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
