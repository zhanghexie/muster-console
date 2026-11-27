---
x-muster-version: 0.1.3
name: sessions
description: Reference for host.sessions.create routing, configuration references and the session management family.
---

# Session tools

## Creating a Worker

`host.sessions.create({ task, isolation, target | inherit, ... })` starts the Worker immediately. Everything that decides **how** it starts is fixed at launch and cannot be changed afterwards.

Parameters:

| parameter | meaning |
|---|---|
| `task` | Goal, deliverable, constraints, and paths to context or skills. Required in practice. |
| `isolation` | Required. `shared` reuses the existing checkout; `isolated` creates a task tree without uncommitted changes. Read-only review may share; independent or parallel edits should isolate even when clean. |
| `target` | `{ tierId }` for policy-based routing, or `{ targetRef }` copied verbatim from `host.workers.options`. Omit only with `inherit`. |
| `inherit` | With `asSubagent`, inherit compatible parent launch settings; omit `target`. |
| `asSubagent` | Bind the calling Worker as parent. Use `targetRef` for a chosen Harness/model or `inherit` for the parent's compatible launch settings. |
| `name` | Short task name; the host prefixes subagent character names. Top-level default is the first 20 task characters. |
| `select` | Default true. Cross-workspace selection stays pending without stealing focus; `false` never changes focus. |
| `force` | Skip runtime preflight. Diagnostics only — do not use it to work around a real failure. |
| `workspaceId` / `rootId` / `cwd` | Which workspace, which source folder, and the absolute working directory inside it. `cwd` is unchanged by isolation. |
| `rootsRevision` | Source-root revision from the workspace snapshot; stale values are rejected. |
| `isolationGroups` | Repos to isolate: `{ rootId, relativePath, repoSet }`. Others stay shared. Append later with `host.sessions.isolate`. |

## Configuration is not a create parameter

`create` accepts **no** inline `model`, `thinking`, `modelParameters`, `nativeConfig`, `cliLaunchOptions`, `guiMode`, `configurePermissions`, `runtime`, `acpPresetId` or `piModeId`. Passing any of them fails the call instead of being ignored.

Configuration comes from exactly two places:

1. **A tier** — the user configured it in Settings; pass `{ tierId }`.
2. **A reference** — ask `host.workers.options` and pass its `targetRef` unchanged.

```
host.workers.options({ mode: 'models', harnessId, surface, modelId, providerId, modelParameters })
  -> { targetRef, ... }
host.sessions.create({ target: { targetRef }, task, isolation })
```

`host.workers.options` modes:

- omitted — configured tiers and their descriptions;
- `mode: 'harnesses'` — registered GUI/CLI choices;
- `mode: 'models'` — cached model catalog for a harness and surface, plus the exact `targetRef`;
- `mode: 'native-settings'` — native permission settings catalog for that harness and surface.

To delegate to a chosen Harness as a child, pass `asSubagent: true` and `target: { targetRef }` together with `task` and `isolation`. A Muster Core parent in Full access mode can create a child on a different enabled Harness with an exact reference for its source folder. The child uses the target Harness's normal launch permissions. The host checks the parent's access and source again before committing the child. Same-Harness children keep the caller's permission policy.

References carry the Harness, model and model parameters. The host resolves permissions separately. `native-settings` describes the engine's available choices.

A `targetRef` is bound to the workspace source, expires when superseded, and must be used with the same workspace. If creation reports an expired or foreign reference, call `host.workers.options` again — do not retry with a modified reference.

## Other actions in this family

- `host.sessions.observe` — read-only session list or one detail; text is data, status is not proof of success.
- `host.sessions.update` — change `pinned`, `orchestrated`, `model`, `thinking`, `archived` or `name` on a running session. This is the **only** place a post-launch model or thinking change belongs.
- `host.sessions.isolate` — preview or append isolated repos to an existing session.
- `host.sessions.review` / `integrate` — acceptance and integration; state-changing, not read-only.
- `host.sessions.search` — find sessions by text.
- `host.sessions.setStatus` — report `phase: "needs_you"` for required user action and say what is needed. Report `phase: "done"` when an explicit task is delivered, verified and needs no user action. End ordinary conversation naturally. The host determines idle from turn activity. An optional `note` of up to 10 Unicode characters updates the capsule.
- `host.sessions.interrupt` / `delete` / `select` / `recover` / `restart` — lifecycle operations; all require explicit session ids.

## Terminal capture

`host.terminal.capture({sessionId?, name?, waitFor?, after?})` reads the visible PTY buffer and saves a local PNG. Supply a session ID or a name in the current workspace. The result includes `textTail`, `imageCaptured`, `outputCursor`, and `previewPath` when a PNG is available. Screenshot failures with available text include `captureError`. The tool does not accept `delivery` or `caption`.

To observe output since a write, pass its `outputCursor` as `after` together with `waitFor: {text?, quietMs?, timeoutMs?}`. Use text or quiet time as the condition. Quiet output alone does not establish completion.
