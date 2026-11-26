import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PR_REVIEW_EVIDENCE_LIMIT, PR_REVIEW_SYSTEM_PROMPT } from '../src/shared/prReviewPrompt.ts';

export async function reviewPullRequest({ repository, number, targetCommit, githubToken, modelUrl, model, modelKey },
  request = globalThis.fetch) {
  if (!/^[\w-]+\/[\w.-]+$/.test(repository ?? '') || !/^[1-9]\d{0,9}$/.test(number ?? '') || !githubToken) {
    throw new Error('Missing GitHub repository, pull request number or workflow token.');
  }
  const endpoint = new URL(modelUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !model?.trim() || !modelKey?.trim()) throw new Error('Configure an HTTPS OpenAI-compatible endpoint, model and API key.');
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/chat/completions`;
  const base = `https://api.github.com/repos/${repository}/pulls/${number}`;
  const headers = { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'Muster-review-action', 'X-GitHub-Api-Version': '2026-03-10' };
  async function github(url) {
    const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}.`);
    return { value: await response.json(), more: /rel="next"/.test(response.headers.get('link') ?? '') };
  }

  const { value: pr } = await github(base);
  const head = pr.head?.sha;
  const baseSha = pr.base?.sha;
  const validate = value => {
    if (value?.state !== 'open' || value.draft || value.head?.sha !== head || value.base?.sha !== baseSha ||
        (targetCommit && head !== targetCommit) || !/^[\da-f]{40}$/i.test(head) || !/^[\da-f]{40}$/i.test(baseSha)) {
      throw new Error('The pull request is no longer ready at the requested revision. Review the current version.');
    }
  };
  validate(pr);
  const { value: files, more } = await github(`${base}/files?per_page=20`);
  validate((await github(base)).value);
  if (!files.some(file => !!file.patch)) throw new Error('GitHub did not return a text diff to review.');
  const evidence = JSON.stringify(files.map(file => ({ path: file.filename, status: file.status, patch: file.patch })));
  const partial = more || files.some(file => !file.patch) || evidence.length > PR_REVIEW_EVIDENCE_LIMIT;
  const response = await request(endpoint.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
    headers: { Authorization: `Bearer ${modelKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [
      { role: 'system', content: PR_REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: `PR ${repository}#${number} at ${head}. Partial: ${partial}.\n${evidence.slice(0, PR_REVIEW_EVIDENCE_LIMIT)}` }
    ] })
  });
  if (!response.ok) throw new Error(`Configured model API HTTP ${response.status}.`);
  const text = (await response.json()).choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('The configured model returned an empty review draft.');
  validate((await github(base)).value);
  return [`# Review draft for ${repository}#${number}`, '', `Head: ${head}`, `Base: ${baseSha}`, '',
    ...(partial ? ['Reviewed a partial diff.', ''] : []), text.trim().slice(0, 24_000), ''].join('\n');
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await reviewPullRequest({
    repository: process.env.GITHUB_REPOSITORY,
    number: String(event.pull_request?.number ?? event.inputs?.pr_number ?? ''),
    targetCommit: event.pull_request?.head?.sha,
    githubToken: process.env.GITHUB_TOKEN,
    modelUrl: process.env.MUSTER_REVIEW_MODEL_URL,
    model: process.env.MUSTER_REVIEW_MODEL,
    modelKey: process.env.MUSTER_REVIEW_MODEL_API_KEY
  });
  await writeFile(process.env.MUSTER_REVIEW_OUTPUT, result, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Review draft generation failed.'); process.exitCode = 1; });
}
