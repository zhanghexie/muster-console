/**
 * 会话消息文本搜索纯函数：只扫 text part、忽略大小写、跳过 thinking/工具/host。
 * 运行: node test/chat-search.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-search-'));
const compile = createSharedCompiler(root, tmp);

const {
  searchableChatText,
  findTextMatches,
  searchChatMessages,
  searchChatMessagesWithMeta,
  groupChatSearchHits,
  chatSearchHitId,
  sameChatSearchHitId,
  assembleChatSearchHits,
  assembleChatSearchHitsWithMeta,
  CHAT_SEARCH_MAX_HITS
} = await import(pathToFileURL(compile('shared/chatSearch.ts')).href);

assert.equal(
  searchableChatText({
    id: '1',
    role: 'assistant',
    parts: [
      { kind: 'thinking', text: 'secret' },
      { kind: 'tool', text: 'run' },
      { kind: 'text', text: 'Hello World' }
    ]
  }),
  'Hello World'
);

assert.equal(
  searchableChatText({ id: 'h', role: 'user', content: 'sys', host: true }),
  ''
);
assert.equal(
  searchableChatText({ id: 'l', role: 'assistant', content: 'local', local: true }),
  ''
);
assert.equal(searchableChatText({ id: 'c', role: 'user', content: 'plain' }), 'plain');

const matches = findTextMatches('Foo BAR foo', 'foo');
assert.equal(matches.length, 2);
assert.deepEqual(matches[0], { start: 0, end: 3 });
assert.deepEqual(matches[1], { start: 8, end: 11 });
assert.equal(findTextMatches('abc', '').length, 0);

const hits = searchChatMessages(
  [
    {
      id: 'u1',
      role: 'user',
      parts: [{ kind: 'text', text: '请修 SearchBar' }]
    },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { kind: 'thinking', text: 'SearchBar 内部独白' },
        { kind: 'text', text: '已改 SearchBar 样式' }
      ]
    }
  ],
  'searchbar',
  { id: 'sess-1', name: '会话甲' }
);
assert.equal(hits.length, 2);
assert.equal(hits[0].messageId, 'u1');
assert.equal(hits[1].messageId, 'a1');
assert.equal(hits[0].sessionId, 'sess-1');
assert.equal(hits[1].indexInMessage, 0);

const thinkingOnly = searchChatMessages(
  [{ id: 't', role: 'assistant', parts: [{ kind: 'thinking', text: 'SearchBar' }] }],
  'searchbar',
  { id: 's', name: 'n' }
);
assert.equal(thinkingOnly.length, 0);

const groups = groupChatSearchHits([
  ...hits,
  { ...hits[0], sessionId: 'sess-2', sessionName: '会话乙', messageId: 'u2' }
]);
assert.equal(groups.length, 2);
assert.equal(groups[0].sessionName, '会话甲');
assert.equal(groups[1].hits.length, 1);

// ---------------------------------------------------------------------------
// 回归（2026-09-22 评审）：全部会话查找的规范序纯函数。
// 还原即红：assembleChatSearchHits 若改回「own 在前」的每表面拼法，两个表面
// 输入相同也得不到同一全局序，跨会话导航/计数再次错位（hook 侧另有集成回归）。
{
  const hit = (sessionId, messageId, indexInMessage) => ({
    sessionId,
    sessionName: sessionId,
    messageId,
    role: 'assistant',
    start: 0,
    end: 2,
    indexInMessage,
    snippet: 'kw'
  });
  const own = [hit('sess-a', 'a-m0', 0), hit('sess-a', 'a-m1', 0), hit('sess-a', 'a-m2', 0)];
  const remote = [
    ...[hit('dispatch:ws', 'd-m0', 0)],
    ...[hit('sess-b', 'b-m0', 0), hit('sess-b', 'b-m1', 0)]
  ];
  const bySession = new Map([['sess-a', own]]);
  for (const h of remote) {
    const bucket = bySession.get(h.sessionId);
    if (bucket) bucket.push(h);
    else bySession.set(h.sessionId, [h]);
  }
  const order = ['dispatch:ws', 'sess-a', 'sess-b'];
  const canonical = assembleChatSearchHits(bySession, order);
  assert.deepEqual(
    canonical.map((h) => h.messageId),
    ['d-m0', 'a-m0', 'a-m1', 'a-m2', 'b-m0', 'b-m1'],
    '规范序：调度面最前，会话按给定序，会话内文档序'
  );
  // 身份在任何等价输入下都指同一条命中（跨表面一致性的根基）
  const id = chatSearchHitId(canonical[4]);
  assert.equal(sameChatSearchHitId(canonical[4], id), true);
  assert.equal(sameChatSearchHitId(canonical[3], id), false);
  // 未列进 sessionOrder 的会话不丢命中（防御性尾部追加）
  const orphan = assembleChatSearchHits(new Map([['sess-x', [hit('sess-x', 'x-m0', 0)]]]), []);
  assert.equal(orphan.length, 1);
  console.log('ok: assembleChatSearchHits 规范序 / 命中身份');

  // 回归（P3 chat-find F-02）：截断不再静默。还原本 WithMeta 即红。
  {
    // 单条正文 > 上限：正文级截断可见
    const longText = Array.from({ length: CHAT_SEARCH_MAX_HITS + 5 }, () => 'kw').join(' ');
    const oneMessage = searchChatMessagesWithMeta(
      [{ id: 'm0', role: 'user', content: longText }],
      'kw',
      { id: 's', name: 'n' }
    );
    assert.equal(oneMessage.hits.length, CHAT_SEARCH_MAX_HITS);
    assert.equal(oneMessage.truncated, true);
    // 恰好等于上限且无更多匹配：不算截断
    const exactText = Array.from({ length: CHAT_SEARCH_MAX_HITS }, () => 'kw').join(' ');
    const exact = searchChatMessagesWithMeta(
      [{ id: 'm0', role: 'user', content: exactText }],
      'kw',
      { id: 's', name: 'n' }
    );
    assert.equal(exact.hits.length, CHAT_SEARCH_MAX_HITS);
    assert.equal(exact.truncated, false);
    // 多桶合计超上限：组装级截断可见
    const over = Array.from({ length: CHAT_SEARCH_MAX_HITS + 1 }, (_, i) => hit('s', `m${i}`, 0));
    const assembled = assembleChatSearchHitsWithMeta(new Map([['s', over]]), ['s']);
    assert.equal(assembled.hits.length, CHAT_SEARCH_MAX_HITS);
    assert.equal(assembled.truncated, true);
    const under = assembleChatSearchHitsWithMeta(new Map([['s', over.slice(0, 5)]]), ['s']);
    assert.equal(under.truncated, false);
    console.log('ok: 截断元信息（正文级/组装级）');
  }
}

console.log('chat-search: ok');
fs.rmSync(tmp, { recursive: true, force: true });
