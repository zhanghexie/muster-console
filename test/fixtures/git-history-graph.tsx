import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { GitHistory } from '@workbench/src/renderer/src/panels/GitHistory';
import { GitWorkspaceProvider } from '@workbench/src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { GitGraphCommit } from '@workbench/src/shared/types';

function commit(sha: string, message: string, parents: string[]): GitGraphCommit {
  return {
    sha,
    commit: { message, author: { name: 'Alex Chen', date: '2026-11-27T12:00:00Z' } },
    parents: parents.map(parent => ({ sha: parent }))
  };
}

const commits = [
  commit('abcdef0', 'Merge feature branch', ['abcdef2', 'abcdef1']),
  commit('abcdef1', 'Update the feature', ['abcdef3']),
  commit('abcdef2', 'Update main', ['abcdef3']),
  commit('abcdef3', 'Initial commit', [])
];

Object.assign(window, {
  api: {
    git: {
      async invokeScoped(_scope: unknown, method: string) {
        switch (method) {
          case 'listBranches': return { local: [{ name: 'main' }] };
          case 'log': return { commits, branchHeads: [], hasMore: false };
          case 'commitFiles': return { files: [] };
          default: throw new Error(`Unexpected Git call: ${method}`);
        }
      }
    }
  }
});

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
createRoot(document.getElementById('root')!).render(
  <main style={{ display: 'flex', height: '100vh', padding: 12, background: 'var(--surface-canvas)' }}>
    <GitWorkspaceProvider scope={{ workspaceId: 'fixture', rootsRevision: 0 }}>
      <GitHistory active repoPath="/repo" currentBranch="main" />
    </GitWorkspaceProvider>
  </main>
);
