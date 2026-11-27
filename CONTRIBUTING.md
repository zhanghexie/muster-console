# Contributing to Muster Console

Thank you for helping improve Muster Console. Keep changes small and reviewable, with documentation close to the code they affect.

## Before you start

1. Search the existing [feature map](docs/README.md) and [research index](docs/research/README.md) for related work.
2. For a behavior change, open or reference an issue that explains the user problem and the expected result.
3. Keep unrelated local changes out of the patch. This repository is often used as an active workbench.

## Development loop

~~~bash
npm install
npm run dev
npm test
npm run typecheck
~~~

Use the narrowest useful validation for the change. The [testing guide](docs/features/testing.md) explains when to run unit, Electron E2E, integration, visual, or audit checks.

## Change expectations

- A bug fix includes a regression test that fails when the fix is removed, unless the behavior cannot be automated; document the manual check in the change description.
- UI interaction changes include a component test and follow the existing animation and cross-platform rules.
- Changes to a feature's behavior, structure, or data flow update the matching docs/features file.
- New external research belongs in docs/research and must be added to its index.
- System integration changes must describe Windows, macOS, and Linux behavior separately when those paths differ.
- Never include API keys, local user data, .dev-sandbox, .tmp, or generated release output in a commit.

## Branches and merging

- Start each task on a short-lived branch from the latest `origin/main`. Use names such as `feat/...`, `fix/...`, `docs/...`, or `refactor/...`. Codex uses `codex/...`. Muster-managed worktrees use `ao/...`.
- Open one PR per independently verifiable change. Target `main` for changes to the shared repository. Use a draft PR for work in progress. Local worktree integration is useful for local validation. Use the work branch to open the PR for changes that should reach the shared `main`.
- Update the shared `main` through a PR. Wait for `quality / windows`, `quality / macos`, and `quality / linux` to pass for the PR's latest revision before merging. `main` is protected against force pushes and deletion.
- Choose **Merge pull request** by default. Use a merge commit for Muster-managed worktree branches so the original commits remain reachable for safe worktree cleanup.
- Verify the `main` CI run for the merge commit before closing out the change and deleting its remote work branch. If `main` turns red, open a focused fix or revert PR and link the failing run.

## Pull requests

Describe the user-visible problem, the resulting behavior, and the validation you ran. Call out platform-specific limits, unverified release paths, or changes that need a maintainer decision. Keep the title specific enough to find later in the changelog.

Muster Console's own source code is licensed under MIT. [LICENSE](LICENSE)

Report vulnerabilities privately through the process in [SECURITY.md](SECURITY.md).
