import type { ToolDef } from './types';

const text = { type: 'string' };
const cursor = { type: 'string', maxLength: 2048 };
const offset = { type: 'integer', minimum: 0 };
const number = { type: 'integer', minimum: 1, maximum: 2_147_483_647 };
const sha = { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$' };
const version = {
  type: 'object', additionalProperties: false,
  properties: { repository: text, number, headSha: sha, baseSha: sha },
  required: ['repository', 'number', 'headSha', 'baseSha']
};

function action(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = [], dangerous = false): ToolDef {
  return {
    name: `github.${name}`, description, dangerous,
    parameters: { type: 'object', additionalProperties: false,
      properties: { repoPath: { type: 'string', description: 'Absolute checkout path in the caller workspace; defaults to the checkout containing the session cwd.' }, ...properties },
      ...(required.length ? { required } : {}) }
  };
}

export const GITHUB_TOOL_DEFS: ToolDef[] = [
  action('repository', 'Resolve the GitHub repository and GitHub App access for a local checkout.'),
  action('list', 'List open PRs you authored or have been asked to review.', {
    filter: { type: 'string', enum: ['authored', 'reviewRequested'] }, cursor, offset
  }, ['filter']),
  action('detail', 'Read a PR overview with its version, or page through the available checks and conversation.', {
    number, section: { type: 'string', enum: ['overview', 'body', 'checks', 'discussion'] }, offset
  }, ['number']),
  action('files', 'List changed files, or read one file patch by offset, for a verified PR version.', {
    version, page: { type: 'integer', minimum: 1, maximum: 150 },
    filename: { type: 'string', description: 'The repository-relative path from the returned files page.' }, offset
  }, ['version']),
  action('threads', 'Read inline review threads and their comment excerpts at a verified PR version.', {
    version, cursor, offset, threadId: { type: 'string', minLength: 1, maxLength: 200 }
  }, ['version']),
  action('create', 'Push the verified worktree branch and open a pull request after the user confirms.', {
    branch: { type: 'string', minLength: 1, maxLength: 255 }, base: { type: 'string', maxLength: 255 },
    title: { type: 'string', minLength: 1, maxLength: 256 }, body: { type: 'string', maxLength: 65_536 }, draft: { type: 'boolean' }
  }, ['branch', 'title'], true),
  action('publish', 'Post a review for the verified PR version after the user confirms.', {
    version, event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] },
    body: { type: 'string', maxLength: 65_536 },
    comments: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, line: number,
        side: { type: 'string', enum: ['LEFT', 'RIGHT'] }, body: { type: 'string', minLength: 1, maxLength: 8192 } },
      required: ['path', 'line', 'side', 'body']
    } }
  }, ['version', 'event'], true)
];
