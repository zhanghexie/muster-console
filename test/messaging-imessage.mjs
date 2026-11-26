import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MacOSMessagesApi, normalizeIMessage } from '../src/main/messaging/dsh-im/src/channels/imessage/imessage-api.mjs';

test('iMessage sends the Muster marker and ignores both generations of self-chat echoes', async () => {
  const chatGuid = 'iMessage;-;fixture';
  const message = { guid: 'fixture-message', chatGuid, sender: 'fixture-sender', isFromMe: 0 };
  const scripts = [];
  const api = new MacOSMessagesApi({
    execFileImpl: async () => { throw new Error('The fixture cannot access Messages'); },
    osascriptImpl: async script => { scripts.push(script); },
  });

  await api.sendText({ chatGuid, text: 'fixture reply' });
  assert.match(scripts[0], /🤖 Muster/);
  assert.doesNotMatch(scripts[0], /🤖 DSH/);
  await api.sendText({ chatGuid, text: '🤖 DSH\nolder reply' });
  assert.match(scripts[1], /🤖 Muster/);
  assert.doesNotMatch(scripts[1], /🤖 DSH/);
  assert.ok(normalizeIMessage({ ...message, text: 'fixture input' }));
  assert.equal(normalizeIMessage({ ...message, text: '🤖 Muster\nfixture reply' }), null);
  assert.equal(normalizeIMessage({ ...message, text: '🤖 DSH\nolder reply' }), null);
});
