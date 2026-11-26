import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(root, '.tmp-llm-attachments-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { llmHost } = await import(pathToFileURL(compile('main/capabilities/hosts/llm.ts')));
  const { LLM_GIT_WEB_TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/llmGitWeb.ts')));
    let cfg = { attachmentProcessing: { autoPages: 2 }, llm: { activeProviderId: 'p', activeModelId: 'm', providers: [
      { id: 'p', name: 'p', baseUrl: 'https://example.test', apiKey: 'secret', models: [
        { id: 'm', multimodal: false, attachments: { nativeFiles: true, nativeAudio: true } }
      ] }
    ] } };
    let updates = 0;
    const update = patch => { updates++; cfg = { ...cfg, ...patch }; return cfg; };
    const ctx = { config: { get: () => cfg, update } };
    llmHost['llm.upsertProvider'](ctx, { id: 'p', models: [{ id: 'm', attachments: { nativeAudio: false, nativeVideo: true, videoTransport: 'data-url', mimeTypes: ['video/*'] } }] });
    const read = llmHost['llm.listProviders'](ctx).providers[0];
    assert.deepEqual(read.models[0].attachments, { nativeFiles: true, nativeAudio: false, nativeVideo: true, videoTransport: 'data-url', mimeTypes: ['video/*'] });
    assert.equal(read.models[0].multimodal, false);
    assert.notEqual(read.apiKey, 'secret');
    assert.deepEqual(cfg.attachmentProcessing, { autoPages: 2 });
    updates = 0;
    for (const attachments of [{ autoPages: 8 }, { ffmpegPath: 'x' }, { nativeAudio: 'true' }]) {
      assert.throws(() => llmHost['llm.upsertProvider'](ctx, { id: 'p', models: [{ id: 'm', attachments }] }));
    }
    assert.equal(updates, 0);
    const schema = JSON.stringify(LLM_GIT_WEB_TOOL_DEFS.find(x => x.name === 'llm.upsertProvider')?.parameters);
    assert.match(schema, /nativeAudio/);
    assert.doesNotMatch(schema, /autoPages|ffmpegPath|maxFileMB|videoFrames/);
  console.log('AI attachment configuration: schema, capability merge and strict validation passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
