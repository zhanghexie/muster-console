import assert from 'node:assert/strict';
import { reviewPullRequest } from '../scripts/github-review-action.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const config = { repository: 'team/repo', number: '7', targetCommit: head,
  githubToken: 'fixture-gh', modelUrl: 'https://model.example/v1', model: 'fixture', modelKey: 'fixture-model' };
const calls = [];
let moved = false;
const transport = async (url, init) => {
  calls.push({ url, init });
  if (url.endsWith('/chat/completions')) {
    assert.equal(init.headers.Authorization, 'Bearer fixture-model');
    return Response.json({ choices: [{ message: { content: 'Check the reconnect branch.' } }] });
  }
  assert.equal(init.method, undefined);
  assert.equal(init.headers.Authorization, 'Bearer fixture-gh');
  if (url.includes('/files?')) return Response.json([{ filename: 'state.ts', patch: '@@ -1 +1 @@\n-x\n+y' }]);
  return Response.json({ state: 'open', draft: false, head: { sha: moved ? 'c'.repeat(40) : head }, base: { sha: base } });
};

const draft = await reviewPullRequest(config, transport);
assert.match(draft, /Check the reconnect branch\./);
assert.match(draft, new RegExp(head));
assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
assert.equal(calls.at(-1).url, 'https://api.github.com/repos/team/repo/pulls/7');
moved = true;
await assert.rejects(reviewPullRequest(config, transport), /no longer ready/);
assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
console.log('github-review-action: pinned revisions and read-only GitHub transport passed');
