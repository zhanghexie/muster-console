import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'html-thumbnail-'));
try {
  const compile = createSharedCompiler(root, path.join(root, '.tmp', 'html-thumbnail-compile'));
  const { ExtensionHtmlThumbnail } = await import(pathToFileURL(compile('main/extensions/extensionHtmlThumbnail.ts')).href);
  let calls = 0, active = 0, peak = 0;
  const thumbnails = new ExtensionHtmlThumbnail(async ({ html }) => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return { dataUrl: `data:image/png;base64,${Buffer.from(html).toString('base64')}` };
  });
  const [a, b] = await Promise.all([thumbnails.html('owner', '<h1>A</h1>'), thumbnails.html('owner', '<h1>A</h1>')]);
  assert.deepEqual(a, b); assert.equal(calls, 1, 'identical in-flight requests share a capture');
  await thumbnails.html('owner', '<h1>A</h1>'); assert.equal(calls, 1);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    await thumbnails.html('owner', '<h1>A</h1>'); assert.equal(calls, 2, 'local dependencies refresh after the bounded cache TTL');
  } finally { Date.now = realNow; }
  await thumbnails.html('another-owner', '<h1>A</h1>'); assert.equal(calls, 3, 'cache is owner scoped');
  await Promise.all(['B', 'C', 'D'].map(text => thumbnails.html('owner', text)));
  assert.equal(peak, 1, 'hidden windows never run concurrently');
  for (const value of ['', null, 'x'.repeat(8 * 1024 * 1024 + 1)]) await assert.rejects(thumbnails.html('owner', value), /8 MiB/);
  const file = path.join(temp, 'index.html');
  await fs.writeFile(file, '<h1>Before</h1>');
  const before = await thumbnails.file('owner', file);
  await fs.writeFile(file, '<h1>After</h1>');
  assert.notDeepEqual(await thumbnails.file('owner', file), before, 'edits invalidate HTML thumbnails');
  await assert.rejects(thumbnails.file('owner', path.join(temp, 'secret.txt')), /Only HTML/);
  let release;
  const pending = new ExtensionHtmlThumbnail(() => new Promise(resolve => { release = resolve; }));
  const jobs = Array.from({ length: 32 }, (_, i) => pending.html('owner', String(i)));
  await assert.rejects(pending.html('owner', 'overflow'), /queue is full/);
  // One pending renderer suffices to verify bounded admission; release the queue normally.
  for (let i = 0; i < jobs.length; i++) {
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const resolve = release; release = undefined; resolve({ dataUrl: 'data:image/png;base64,AA==' });
    await jobs[i];
  }
  console.log('extensions-html-thumbnail: ok');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
