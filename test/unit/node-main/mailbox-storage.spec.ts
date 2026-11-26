import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentMessagesFilePath,
  agentMessageBodyPath,
  appendAgentMessageToStore,
  readAgentMessageBody,
  readAgentMessageLedger,
  resetMessageStoreChainsForTest,
  setAgentMessagesUserDataDir
} from '../../../src/main/metaAgent/messageStore';

const roots: string[] = [];
afterEach(() => { resetMessageStoreChainsForTest(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-mailbox-sqlite-')); roots.push(root); setAgentMessagesUserDataDir(root); return root;
}

describe('SQLite mailbox storage v1', () => {
  it('stores headers transactionally in SQLite and full bodies in immutable files', async () => {
    fixture();
    const entry = await appendAgentMessageToStore('', 'ws', { id: 'mail-11111111-1111-4111-8111-111111111111', from: 'a', to: 'b', text: 'full body', ts: 1, receipt: 'stored' });
    const file = agentMessagesFilePath('ws');
    expect(file.endsWith('.sqlite')).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(agentMessageBodyPath('ws', entry.id), 'utf8')).toBe('full body');
    expect(readAgentMessageLedger('', 'ws').messages[0]?.text).toBe('full body');
    expect(readAgentMessageBody('', 'ws', entry)).toBe('full body');
    const db = new DatabaseSync(file);
    expect((db.prepare("SELECT value FROM mailbox_meta WHERE key='schema'").get() as { value: string }).value).toBe('1');
    expect((db.prepare('SELECT COUNT(*) AS count FROM mailbox_message').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT body_path FROM mailbox_message WHERE id=?').get(entry.id) as { body_path: string }).body_path).toMatch(/^[a-f0-9]{64}\.txt$/);
    db.close();
  });

  it('keeps colliding workspace identities in separate SQLite files', async () => {
    fixture();
    await appendAgentMessageToStore('', 'a/b', { id: 'mail-22222222-2222-4222-8222-222222222222', from: 'a', to: 'b', text: 'slash', ts: 1, receipt: 'stored' });
    await appendAgentMessageToStore('', 'a?b', { id: 'mail-33333333-3333-4333-8333-333333333333', from: 'a', to: 'b', text: 'question', ts: 2, receipt: 'stored' });
    const slashFile = agentMessagesFilePath('a/b');
    expect(slashFile).toMatch(/[\\/]a-b~[a-f0-9]{16}\.sqlite$/);
    expect(slashFile).not.toBe(agentMessagesFilePath('a?b'));
    expect(readAgentMessageLedger('', 'a/b').messages[0]?.text).toBe('slash');
    expect(readAgentMessageLedger('', 'a?b').messages[0]?.text).toBe('question');
  });

  it('fails closed on the pre-release embedded-body schema', () => {
    fixture();
    const file = agentMessagesFilePath('legacy-schema');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE mailbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE mailbox_message (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, entry_json TEXT NOT NULL, body TEXT);");
    db.close();
    expect(() => readAgentMessageLedger('', 'legacy-schema')).toThrow(/发布前 reset/);
  });

  it('appends ten thousand messages without rebuilding the full ledger per write', async () => {
    fixture();
    for (let i = 0; i < 10_000; i += 1) {
      await appendAgentMessageToStore('', 'bulk', {
        id: `mail-44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
        from: 'a', to: 'b', text: `body-${i}`, ts: i, receipt: 'delivered'
      });
    }
    const ledger = readAgentMessageLedger('', 'bulk');
    expect(ledger.messages).toHaveLength(10_000);
    expect(ledger.seq).toBe(10_000);
    expect(ledger.messages.at(-1)?.text).toBe('body-9999');
  }, 60_000);
});
