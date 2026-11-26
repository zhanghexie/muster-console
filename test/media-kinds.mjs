import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = [
  path.join(root, 'src', 'shared', 'protocolSchemes.ts'),
  path.join(root, 'src', 'shared', 'mediaKinds.ts')
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-kinds-'));
const out = path.join(tmp, 'mediaKinds.mjs');
for (const entry of entries) {
  const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  const name = path.basename(entry).replace(/\.ts$/, '.mjs');
  const fixed = outputText.replace(/(from\s+')([./][^']*)(')/g, (_, a, spec, b) => `${a}${spec.endsWith('.mjs') ? spec : `${spec}.mjs`}${b}`);
  fs.writeFileSync(path.join(tmp, name), fixed, 'utf8');
}

const {
  buildWorkspaceMediaUrl,
  buildWorkspaceResourceUrl,
  mediaKindForPath,
  parseWorkspaceMediaUrl,
  MUSTER_ROOT_SCHEME,
  MUSTER_WS_SCHEME
} = await import(pathToFileURL(out).href);
const {
  MUSTER_APP_SCHEME,
  MUSTER_EXT_SCHEME,
  MUSTER_SCHEMES
} = await import(pathToFileURL(path.join(tmp, 'protocolSchemes.mjs')).href);

assert.deepEqual([...MUSTER_SCHEMES], ['muster-app', 'muster-root', 'muster-ws', 'muster-ext', 'muster-export']);
assert.equal(MUSTER_APP_SCHEME, 'muster-app');
assert.equal(MUSTER_ROOT_SCHEME, 'muster-root');
assert.equal(MUSTER_WS_SCHEME, 'muster-ws');
assert.equal(MUSTER_EXT_SCHEME, 'muster-ext');

assert.equal(mediaKindForPath('a/b/photo.PNG'), 'image');
assert.equal(mediaKindForPath('clip.mp4'), 'video');
assert.equal(mediaKindForPath('song.mp3'), 'audio');
assert.equal(mediaKindForPath('doc.PDF'), 'pdf');
assert.equal(mediaKindForPath('readme.md'), null);

const url = buildWorkspaceMediaUrl('ws-1', 'assets/视频 demo.mp4');
assert.match(url, /^muster-ws:\/\/ws-1\//);
const parsed = parseWorkspaceMediaUrl(url);
assert.equal(parsed.workspaceId, 'ws-1');
assert.equal(parsed.relativePath, 'assets/视频 demo.mp4');
const versioned = buildWorkspaceMediaUrl('WS/中文 &', 'src/a #?.png', 'ROOT/?中文&');
assert.deepEqual(parseWorkspaceMediaUrl(versioned), { workspaceId: 'WS/中文 &', rootId: 'ROOT/?中文&', relativePath: 'src/a #?.png' });
assert.throws(() => parseWorkspaceMediaUrl('muster-ws://ws/f.png?v=3&rootId=a'), /unsupported/);
assert.throws(() => parseWorkspaceMediaUrl('muster-ws://workspace/f.png?v=2&workspaceId=ws'), /rootId/);
assert.throws(() => parseWorkspaceMediaUrl('metaagent-ws://ws/f.png'), /unsupported/);
assert.throws(() => parseWorkspaceMediaUrl('metaagent-root://r666f/ws/file'), /unsupported/);
const ref = { workspaceId: 'Mixed/工作区 &', rootId: 'ROOT/?中文&', relativePath: 'docs/index.html' };
const resource = buildWorkspaceResourceUrl(ref);
assert.deepEqual(parseWorkspaceMediaUrl(resource), ref);
assert.deepEqual(parseWorkspaceMediaUrl(new URL('../assets/同名 #?.png?cache=1', resource).href), { ...ref, relativePath: 'assets/同名 ' }); // # 是标准 URL fragment；文件名必须编码。
const nested = new URL('../assets/%E5%90%8C%E5%90%8D%20%23%3F.png?cache=1', resource).href;
assert.deepEqual(parseWorkspaceMediaUrl(nested), { ...ref, relativePath: 'assets/同名 #?.png' });
assert.deepEqual(parseWorkspaceMediaUrl(new URL('../../../../image.png', resource).href), { ...ref, relativePath: 'image.png' });
assert.throws(() => parseWorkspaceMediaUrl('muster-root://rff/file'), /./);
assert.throws(() => parseWorkspaceMediaUrl('muster-root://r5b22222c22225d/file'), /identity/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok: media-kinds');
