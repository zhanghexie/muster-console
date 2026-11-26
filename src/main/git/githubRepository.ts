const REPOSITORY_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;

export function githubRepositoryName(value: string): string | null {
  if (!REPOSITORY_NAME.test(value) || /\/(?:\.|\.\.)$/.test(value)) return null;
  return value;
}

export function repositoryFromGitRemote(remote: string): string | null {
  const scp = /^(?:[^@\s]+@)?github\.com:(.+)$/i.exec(remote);
  if (scp) return githubRepositoryName(scp[1]!.replace(/\.git\/?$/i, '').replace(/\/$/, ''));
  try {
    const url = new URL(remote);
    const gitHubHost = url.hostname === 'github.com' || (url.protocol === 'ssh:' && url.hostname === 'ssh.github.com');
    if (!gitHubHost || !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.search || url.hash) return null;
    return githubRepositoryName(url.pathname.replace(/^\//, '').replace(/\.git\/?$/i, '').replace(/\/$/, ''));
  } catch { return null; }
}

export function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
