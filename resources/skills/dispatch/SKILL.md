---
x-muster-version: 0.1.36
name: dispatch
description: Parameter reference for host.dispatch.run — serving external CLI task runs (delegate a dedicated worker, report progress, ask the caller, deliver or fail). Read this before passing params to any host.dispatch.run action.
---

# host.dispatch.run — external CLI task runs

External agents submit tasks through the `muster` CLI; the scheduler serves them through `host.dispatch.run` (the catalog `runs.*` domain). Only an explicit `deliver` counts as success — never a first reply, an idle session, or a silent terminal.

## Actions

Required params are marked `*`.

| Action | params | Purpose |
|---|---|---|
| delegate | runId*, task*, isolation* ('shared'\|'isolated'), isolationGroups?, runtime?, name?, rootId?, cwd?, rootsRevision?, configurePermissions?, guiMode?, nativeConfig?, cliLaunchOptions?, acpPresetId?, model? | Delegate a dedicated Worker (GUI or terminal) for the run, auto-linking task and session without stealing focus — use this instead of `host.sessions.create` for external CLI tasks. `task` is the self-contained worker brief. `isolationGroups`: each item = `{rootId, relativePath, repoSet}` (required for `isolated`; `repoSet: []` = root repo only; not accepted with `shared`). `configurePermissions` defaults to false for automatic permissions. Set it to true for manual configuration. `guiMode` selects a Muster Core mode and `cliLaunchOptions` carries native terminal launch settings. For an external GUI Harness with manual configuration enabled, copy `{identity,selections:[{id,value}]}` from the native settings directory returned by `host.workers.options({mode:"native-settings",harnessId,surface:"gui",rootId})` and use the matching source and optional ACP preset. `model`: `{providerId, modelId}`. Run `get` first to confirm current instructions. |
| get | runId* | Read the task: latest instructions, executor, and waiting items. |
| progress | runId*, text* | Record progress or a pending human-action entry; does NOT mean the task is delivered. |
| ask | runId*, question* | Ask the external calling agent for more information; returns `question.id`, answered by the caller via CLI `run reply`. Not a substitute for user approval or authorization. |
| deliver | runId*, summary*, artifacts*, verification* | Explicitly deliver: `summary` = final answer and deliverables; `artifacts` = absolute paths or `[]`; `verification` = checks actually performed and any unverified limits. Does not integrate, archive, or bypass human confirmation. |
| fail | runId*, error* | Explicitly mark the run failed with the reason and recovery guidance; never fake success or auto-redelegate. |

## Calling pattern

```
host.dispatch.run({ action, params })
```
`params` follows the chosen action's original schema; no zero-arg action exists in this domain.

- Read the task before acting:
  `host.dispatch.run({ action: "get", params: { runId: "run_8f2" } })`
- Delegate an isolated worker:
  `host.dispatch.run({ action: "delegate", params: { runId: "run_8f2", task: "Fix the failing e2e spec in tests/login.spec.ts and report the diff.", isolation: "isolated", isolationGroups: [{ rootId: "root_main", relativePath: "", repoSet: [] }] } })`
- Deliver:
  `host.dispatch.run({ action: "deliver", params: { runId: "run_8f2", summary: "Fixed the login e2e spec; see diff.", artifacts: ["E:\\repo\\test.log"], verification: "Ran the single spec locally; full suite not run." } })`

## Notes

- **Scheduler-side domain**: scheduler only, strictly bound to the current tool workspace — `runs.*` never appears in Worker or extension allowlists.
- For ordinary workspace delegation, use the effective tier summary (the workspace override when present, otherwise the global default) to choose a configured `low`, `medium`, `high`, or `xhigh` tier by task difficulty, or choose a `special` pool by purpose. The tier uses its configured candidate settings. Call `host.sessions.create({task,isolation,target:{tierId}})`. For the user's exact `/harness` reference, use `target:{targetRef}`. See the runtimes skill for `host.workers.options`. For a task linked to an external CLI run, use this skill's `delegate` action so the run retains its executor and cancellation linkage. Worker creation includes its own availability check.
- When `runtime` is omitted, delegate uses the configured GUI runtime or `pi`. CLI Workers are not recommended; specify a CLI runtime ID explicitly to use one. An unavailable GUI fails instead of falling back to CLI.
- `runId` comes from the external CLI task notification; never infer it from current UI state.
- `isolation` must be an explicit `shared` or `isolated` — no auto, no default; `shared` accepts no isolation groups. Dirty state is advisory: independent edits call for `isolated` even on a clean repo.
- Before `deliver`, confirm all linked Workers are accepted or finished and pending questions and appended instructions are handled.
- A scheduler turn that produces no delivery, question, or executor is an explicit failure; if a Worker exists, keep waiting for it to close out.
