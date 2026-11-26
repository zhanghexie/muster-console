/**
 * 录屏服务纯逻辑（任务 E）：采集上限决策（帧数/字节/时长三闸）。
 * webmMuxer 结构断言见 test/browser-webm-muxer.mjs；整链（编码→合成→Chromium 播放）
 * 已由一次性真机探针验证（VP8+尺寸元素后 playback ok）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-recording-policy-'));
const compile = createSharedCompiler(root, tmp);

const { shouldStopCapturing, BrowserRecordingService } = await import(pathToFileURL(compile('main/browser/browserRecording.ts')));

// 正常区间：继续
assert.equal(shouldStopCapturing(0, 0, 0), null);
assert.equal(shouldStopCapturing(100, 1024, 10_000), null);
assert.equal(shouldStopCapturing(1499, 199 * 1024 * 1024, 119_999), null);

// 三闸各自触发
assert.equal(shouldStopCapturing(1500, 0, 0), 'frames');
assert.equal(shouldStopCapturing(0, 200 * 1024 * 1024, 0), 'bytes');
assert.equal(shouldStopCapturing(0, 0, 120_000), 'duration');

// 帧数优先（多重满足时按检查顺序）
assert.equal(shouldStopCapturing(1500, 200 * 1024 * 1024, 120_000), 'frames');

// Drive the actual capture -> encoder -> mux lifecycle. CDP timestamps are seconds,
// whereas the renderer encoder, WebM muxer and exported artifact all consume ms.
const commands = [], encodes = [], throttles = [];
const debug = new EventEmitter();
debug.isAttached = () => true;
debug.sendCommand = async (method, params) => { commands.push({ method, params }); };
let visibility = 'visible';
const wc = { debugger: debug, isDestroyed: () => false };
const host = { webContents: { isDestroyed: () => false, executeJavaScript: async script => {
  encodes.push(script);
  return { ok: true, chunks: [0, 250, 1500].map(ts => ({ data: Buffer.from([1, 2, 3]).toString('base64'), ts, key: true })) };
} } };
const recordings = new BrowserRecordingService(() => wc, () => host, path.join(tmp, 'captures'),
  (tabId, busy) => throttles.push({ tabId, busy }), async () => visibility === 'visible');
visibility = 'hidden';
await assert.rejects(recordings.start('tab-a'), /capability_unsupported.*隐藏/);
assert.equal(commands.length, 0, 'hidden recording must fail before starting native capture');
assert.deepEqual(throttles, [], 'hidden recording cannot change throttling or presentation');
visibility = 'visible';
const recording = await recordings.start('tab-a');
const emitFrame = (timestamp, sessionId) => debug.emit('message', {}, 'Page.screencastFrame', {
  data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  metadata: { timestamp, deviceWidth: 64, deviceHeight: 48 }, sessionId
});
emitFrame(100, 1); emitFrame(100.25, 2); emitFrame(101.5, 3);
const completed = await recordings.stop(recording.id);
assert.equal(completed.status, 'completed');
assert.equal(completed.artifact.durationMs, 1500);
assert.equal(completed.artifact.frameCount, 3);
assert.ok(encodes[0].includes('"timestampMs":250'));
assert.ok(encodes[0].includes('"timestampMs":1500'));
assert.ok(fs.existsSync(completed.artifact.path));
assert.equal(commands.filter(command => command.method === 'Page.stopScreencast').length, 1);
assert.equal(commands.filter(command => command.method === 'Page.screencastFrameAck').length, 3);
assert.equal(debug.listenerCount('message'), 0, 'stop removes the capture listener');
assert.deepEqual(throttles, [{ tabId: 'tab-a', busy: true }, { tabId: 'tab-a', busy: false }]);

const cancelled = await recordings.start('tab-a');
emitFrame(200, 4);
assert.equal(recordings.cancel(cancelled.id), true);
assert.equal(recordings.job(cancelled.id).status, 'cancelled');
assert.equal(commands.filter(command => command.method === 'Page.stopScreencast').length, 2,
  'both stop and cancel must send the actual CDP stop command');
assert.ok(!commands.some(command => command.method === 'Page.screencastStopScreencast'));
assert.equal(debug.listenerCount('message'), 0);
assert.equal(encodes.length, 1, 'cancel never encodes discarded frames');

const concurrent = await Promise.allSettled([recordings.start('tab-a'), recordings.start('tab-a')]);
assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1,
  'the asynchronous visibility probe must not permit two captures on one guest');
assert.match(concurrent.find(result => result.status === 'rejected').reason.message, /已有进行中的录制/);
recordings.cancel(concurrent.find(result => result.status === 'fulfilled').value.id);
assert.equal(debug.listenerCount('message'), 0);

console.log('browser-recording-policy: all assertions passed');
