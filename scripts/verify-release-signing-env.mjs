import process from 'node:process';

const releaseBuild = (process.env.GITHUB_EVENT_NAME === 'push' || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') && process.env.GITHUB_REF === 'refs/heads/main';
if (!releaseBuild) process.exit(0);

const required = (names) => names.filter(name => !String(process.env[name] ?? '').trim());
const missing = process.env.RUNNER_OS === 'Windows'
  ? required(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'])
  : process.env.RUNNER_OS === 'macOS'
    ? required(['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
    : [];
if (missing.length) throw new Error(`Protected release signing is unavailable. Missing secrets: ${missing.join(', ')}`);

if (process.env.GITHUB_ENV) {
  const fs = await import('node:fs/promises');
  const lines = [];
  if (process.env.RUNNER_OS === 'Windows') {
    lines.push(`CSC_LINK=${process.env.WIN_CSC_LINK}`, `CSC_KEY_PASSWORD=${process.env.WIN_CSC_KEY_PASSWORD}`);
  } else if (process.env.RUNNER_OS === 'macOS') {
    lines.push(`CSC_LINK=${process.env.MAC_CSC_LINK}`, `CSC_KEY_PASSWORD=${process.env.MAC_CSC_KEY_PASSWORD}`);
  }
  if (lines.length) await fs.appendFile(process.env.GITHUB_ENV, `${lines.join('\n')}\n`, 'utf8');
}
