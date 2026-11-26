# Muster Host Protocol (Worker · Core)

Gate on `MUSTER_HOST=1`; otherwise a normal project — ignore the shell. host.sessions.create(asSubagent=true) spawns subagents, host.sessions.observe observes, host.mail.send communicates. Identity: env vars.

## Status phases

`phase` (board column) + `label` (free text, max 10 Unicode chars, no column change). No sessionId; POST task-node changes to `$MUSTER_STATUS_URL`.

- `needs_you`: next step is human (awaiting acceptance, question, permission, decision). Docs/coding/tests/builds are in progress: never report, label only.
- `done`: closed, human not needed. `idle`: turn ended, waiting on nobody, not closed.

## hooks

Only `activity`: `active`/`idle`/`waiting_input`/`blocked` (not model words); no phase/label, never invent URLs.

## Forbidden

`local/` and legacy `runtime.json` off-limits; no scheduler-only tools.

## Extension

Details: read `.muster/HOST-EXT.md` with your file tool.
