import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-model-gateway-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WTAQAAAAASUVORK5CYII=';
const imageRequests = [];
const server = http.createServer((req, res) => {
  if (req.url === '/custom/images/generations') {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      const input = JSON.parse(text);
      imageRequests.push({ ...input, authorization: req.headers.authorization });
      const entry = input.model === 'url-demo' ? { url: '/custom/result.png' } : { b64_json: png };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [entry] }));
    });
    return;
  }
  if (req.url === '/custom/result.png') {
    if (req.headers.authorization !== 'Bearer demo-key') return res.writeHead(401).end();
    return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from(png, 'base64'));
  }
  if (req.method === 'GET' && req.url === '/image.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('png')); return; }
  if (req.method === 'GET' && req.url === '/video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(Buffer.from('mp4')); return; }
  if (req.url === '/v1/images/generations') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ url: '/image.png' }] })); return; }
  if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('audio')); return; }
  if (req.url === '/v1/audio/transcriptions') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '识别结果' })); return; }
  if (req.url === '/video/submit') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'task-1' })); return; }
  if (req.url === '/video/poll/task-1') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', url: '/video.mp4' })); return; }
  if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '文本结果' } }] })); return; }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extension-model-gateway-compile'));
  const { ExtensionMediaStore } = await import(pathToFileURL(compile('main/extensions/extensionMediaStore.ts')).href);
  const { ExtensionModelGateway } = await import(pathToFileURL(compile('main/extensions/extensionModelGateway.ts')).href);
  const source = path.join(temp, 'voice.wav'); await fs.writeFile(source, Buffer.from('voice'));
  const media = new ExtensionMediaStore(temp);
  const input = await media.importFile('ws:desk', source);
  const config = { get: () => ({ llm: { activeProviderId: 'local', activeModelId: 'all', providers: [{ id: 'local', name: 'Local', baseUrl, apiKey: 'secret', models: [{ id: 'all', modalities: ['text', 'image', 'video', 'asr', 'tts'] }], media: { video: { submitPath: '/video/submit', pollPath: '/video/poll/{taskId}' } } }] } }) };
  const gateway = new ExtensionModelGateway(config, media);
  assert.deepEqual(gateway.list()[0].modalities, ['text', 'image', 'video', 'asr', 'tts']);
  assert.equal(gateway.list()[0].isDefault, true, 'default selection is exposed without credentials');
  const switched = new ExtensionModelGateway({ get: () => { const value = config.get(); return { llm: { ...value.llm, activeModelId: 'second', providers: [{ ...value.llm.providers[0], models: [{ id: 'first' }, { id: 'second' }] }] } }; } }, media);
  assert.deepEqual(switched.list().map(row => row.isDefault), [false, true]);
  assert.equal((await gateway.invoke('ws:desk', { modality: 'text', prompt: 'hi' })).text, '文本结果');
  const image = (await gateway.invoke('ws:desk', { modality: 'image', prompt: 'cat' })).asset;
  assert.equal(await (await fetch(image.url)).text(), 'png');
  const speech = (await gateway.invoke('ws:desk', { modality: 'tts', prompt: 'hello' })).asset;
  assert.equal(await (await fetch(speech.url)).text(), 'audio');
  assert.equal((await gateway.invoke('ws:desk', { modality: 'asr', assetId: input.assetId })).text, '识别结果');
  const video = (await gateway.invoke('ws:desk', { modality: 'video', prompt: 'clip' })).asset;
  assert.equal(await (await fetch(video.url)).text(), 'mp4');
  const customGateway = new ExtensionModelGateway({ get: () => ({}) }, media, {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString()
  });
  const owner = 'test:desk';
  const connection = { baseUrl: baseUrl + '/custom', model: 'image-demo', apiKey: 'demo-key', size: '1024x1024' };
  const signal = new AbortController().signal;
  const preview = await customGateway.customImage(owner, { ...connection, prompt: 'test cover' }, signal);
  assert.deepEqual(Buffer.from(await (await fetch(preview.asset.url)).arrayBuffer()), Buffer.from(png, 'base64'));
  const sealedKey = customGateway.sealImageKey(owner, connection.baseUrl, connection.apiKey);
  const saved = { baseUrl: connection.baseUrl, model: connection.model, size: connection.size, sealedKey, prompt: 'test cover' };
  await assert.rejects(() => customGateway.customImage(owner, { ...saved, baseUrl: baseUrl + '/other' }, signal), /重新填写/);
  await assert.rejects(() => customGateway.customImage('another-owner', saved, signal), /重新填写/);
  const download = await customGateway.customImage(owner, { ...saved, model: 'url-demo' }, signal);
  assert.deepEqual(Buffer.from(await (await fetch(download.asset.url)).arrayBuffer()), Buffer.from(png, 'base64'));
  assert.equal(imageRequests.length, 2);
  assert.ok(imageRequests.every(req => req.authorization === 'Bearer demo-key' && req.size === connection.size));
  const visionGateway = new ExtensionModelGateway({ get: () => ({ llm: { providers: [{ id: 'chat', name: 'Chat', baseUrl, models: [{ id: 'vision', multimodal: true }] }] } }) }, media);
  assert.deepEqual(visionGateway.list()[0].modalities, ['text']);
  media.stop();
  console.log('extensions-model-gateway: ok');
} finally { server.close(); await fs.rm(temp, { recursive: true, force: true }); }
