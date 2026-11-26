import assert from 'node:assert/strict';
import { DESKTOP_IMAGE_EVENT_SUMMARY, MAX_APP_SERVER_FRAME_BYTES, MAX_APP_SERVER_IMAGE_FRAME_BYTES,
  projectAppServerOutput } from '../src/main/agentSession/drivers/codex/worker/appServerOutput.mjs';

const data = 'iVBORw0KGgo' + 'A'.repeat(1_400_000 - 12) + '=';
const event = { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
  id: 'fixture', type: 'mcpToolCall', server: 'muster', tool: 'host_desktop_look', status: 'completed',
  result: { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', mimeType: 'image/png', data }] }
} } };
const bytes = Buffer.byteLength(JSON.stringify(event));
assert.ok(bytes > MAX_APP_SERVER_FRAME_BYTES);
const projected = projectAppServerOutput(event, bytes);
assert.equal(projected.params.item.result.content[1].text, DESKTOP_IMAGE_EVENT_SUMMARY);
assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 1000, 'the host event must not retain screenshot bytes');
assert.equal(event.params.item.result.content[1].data, data, 'projecting an event must not mutate the native message');
// A real Codex 0.166 event collapses a large result into a truncated text
// preview. Its enclosing JSON-RPC frame can itself exceed the 1 MiB limit.
const previewText = '{"content":[{"type":"text","text":"{\\"ok\\":true}"},{"type":"image","data":"iVBORw0KGgo' +
  'A'.repeat(MAX_APP_SERVER_FRAME_BYTES - 200) + '…100355 chars truncated…"}]}' ;
const preview = structuredClone(event);
preview.params.item.result.content = [{ type: 'text', text: previewText }];
const previewBytes = Buffer.byteLength(JSON.stringify(preview));
assert.ok(previewBytes > MAX_APP_SERVER_FRAME_BYTES);
assert.deepEqual(projectAppServerOutput(preview, previewBytes).params.item.result.content,
  [{ type: 'text', text: DESKTOP_IMAGE_EVENT_SUMMARY }]);
for (const invalidate of [
  value => { value.params.item.status = 'failed'; },
  value => { value.params.item.error = { message: 'error' }; },
  value => { value.params.item.result.isError = true; },
  value => { value.params.item.tool = 'host_other'; },
  value => { value.params.item.result.content[0].text = previewText.replace(' chars truncated', ' characters omitted'); },
  value => { value.params.item.result.content[0].text = previewText.replace('"type":"image"', '"type":"text"'); }
]) {
  const invalid = structuredClone(preview);
  invalidate(invalid);
  assert.throws(() => projectAppServerOutput(invalid, Buffer.byteLength(JSON.stringify(invalid))), /超限/,
    'unrelated or failed large events must not be hidden');
}
const unrelated = { ...event, params: { ...event.params, item: { ...event.params.item, tool: 'host_other' } } };
assert.throws(() => projectAppServerOutput(unrelated, bytes), /超限/, 'large unrelated events retain the original limit');
const wrongType = structuredClone(event);
wrongType.params.item.result.content[1].mimeType = 'image/jpeg';
assert.throws(() => projectAppServerOutput(wrongType, bytes), /invalid/);
assert.throws(() => projectAppServerOutput(event, MAX_APP_SERVER_IMAGE_FRAME_BYTES + 1), /超限/);
const ordinary = { method: 'turn/started', params: { threadId: 'thread' } };
assert.equal(projectAppServerOutput(ordinary, Buffer.byteLength(JSON.stringify(ordinary))), ordinary);
console.log('Codex screenshot event: large image projection and unrelated frame bounds passed');
