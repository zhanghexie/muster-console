---
x-muster-version: 0.1.35
name: automations
description: Parameter reference for host.automations.run — creating and managing scheduled prompt tasks (time schedules, execution policy, enable/disable). Read this before passing params to any host.automations.run action.
---

# host.automations.run — scheduled prompt tasks

A prompt task launches a visible Worker to execute a prompt at the due time. `host.automations.run` manages them end to end. For a time-based reminder that should wake the current scheduler (including reminding the user), use the phone reminders app via `host.apps.run` instead, unless the user explicitly asks for a Worker automation.

## Actions

Required params are marked `*`.

| Action | params | Purpose |
|---|---|---|
| create | name*, prompt*, runtime*, schedule? \| delayMinutes?, workspaceId?, rootId?, rootsRevision?, maxRuns?, missedPolicy? (skip\|catch-up\|confirm), configurePermissions?, guiMode?, nativeConfig?, cliLaunchOptions?, piModeId?, thinking?, model? | Register a task (enabled at creation). `runtime` is required — run `host.runtimes.run {action:"list"}` first. `schedule.kind`: once (`at` ISO date-time) / daily (`time` HH:mm local) / weekly (+ `weekdays` 0=Sunday) / interval (`intervalMinutes` 1-43200). `delayMinutes` 1-43200 is the relative form, mutually exclusive with `schedule`. `model` = `{providerId, modelId}` override; `configurePermissions` defaults to false for automatic permissions. Set it to true for manual configuration. `guiMode` is for Muster Core and `cliLaunchOptions` uses native terminal startup settings; `nativeConfig` stores external GUI settings from `host.workers.options({mode:"native-settings",harnessId,surface:"gui",rootId})` as `{identity,selections:[{id,value}]}`; `thinking` off/low/medium/high/max. |
| update | automationId*, name?, runtime?, prompt?, schedule? \| delayMinutes?, rootId?, rootsRevision?, maxRuns?, missedPolicy?, configurePermissions?, guiMode?, nativeConfig?, cliLaunchOptions?, piModeId?, thinking?, model? | Modify a task. The schedule rules match create. Pass `nativeConfig: null` or `cliLaunchOptions: null` to clear saved choices. Only `configurePermissions: true` applies explicit permission settings. |
| delete | automationId* | Delete the task. |
| list | {} | List time-scheduled tasks with runtime, execution policy, and status. |
| runNow | automationId* | Fire once immediately (launches a visible Worker) without affecting later schedules. |
| setEnabled | automationId*, enabled* | Enable (`true`) or disable (`false`); content unchanged. |

## Calling pattern

```
host.automations.run({ action, params })
```
`params` follows the chosen action's original schema; pass `{}` for no-arg actions.

- One-shot Worker launch: "in 8 minutes launch a Worker to check the build"
  `host.automations.run({ action: "create", params: { name: "in 8 minutes launch a Worker to check the build", prompt: "Check the build and report the result.", runtime: "pi", delayMinutes: 8 } })`
- Recurring: `host.automations.run({ action: "create", params: { name: "daily build digest", prompt: "Summarize today's CI runs.", runtime: "pi", schedule: { kind: "daily", time: "09:00" } } })`
- Pause without deleting: `host.automations.run({ action: "setEnabled", params: { automationId: "svc_12", enabled: false } })`

## Notes

- **Scheduler-side domain.**
- `host.automations.run` manages only time schedules. Use `host.events.subscribe` for event notifications.
- Creating a task and materially changing its prompt, schedule, runtime, model or execution settings pass low-frequency business approval before taking effect. A rename or ordinary enable/disable, delete, list and run-now operation does not automatically invoke this approval agent. `dangerous` metadata is not a per-action confirmation requirement; reviewer failures provide a human-handling path.
- **Schedule phrasing** (the classic trap):
  - "do X in N minutes/hours" must use `delayMinutes` — never encode it as interval/daily; the host converts it to a one-shot (`once`) from the real clock.
  - "run once at a given time" uses `schedule {kind:"once", at}` or `delayMinutes`; `once` auto-disables after one successful firing.
  - Only explicit recurrence uses daily/weekly/interval; `maxRuns` caps successful firings and auto-disables on reach.
  - `delayMinutes` and `schedule` are mutually exclusive.
- Keep `name` as the user's verbatim phrase — do not generalize it into titles like "daily task".
- Tasks launch a visible Worker (headless mode is retired and rejected). `missedPolicy` applies to time triggers only; `catch-up` runs just the latest missed slot.
- `rootId` omitted = default root fixed at creation (later default changes do not redirect); a stale `rootsRevision` rejects create/update.
