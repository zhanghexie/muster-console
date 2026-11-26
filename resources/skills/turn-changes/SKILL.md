---
name: turn-changes
description: Register exact files for the current Muster Console turn's review when edits lack a trusted pre-write hook.
x-muster-version: 0.1.34.5
---

# Turn file review

Supported native file tools are captured automatically in built-in Pi and Claude, and observed in Codex, external Pi, ACP, Muse and ZCode. Observation or an engine-reported patch can be incomplete and does not establish safe undo. Use `host.turnChanges.trackFiles` to supplement coverage whenever the target files are known, especially before shell commands, scripts, or tools that may report paths late. The tool is available only in an active GUI or interactive scheduler turn; plain terminal sessions do not have a turn review tracker.

1. Before any write, await `host.turnChanges.trackFiles({action:"begin", paths:["src/a.ts"]})` and keep the returned `captureId`. Paths are exact, relative to the current execution directory. For another writable workspace root, pass its host-provided `rootId` in `begin`; do not use `..`, absolute paths, or globs.
2. Perform the intended edit or command.
3. Await `host.turnChanges.trackFiles({action:"complete", captureId:"<id>", paths:["src/a.ts"]})`. Pass `captureId` only in `complete` and `rootId` only in `begin`. The completed paths must be a subset of the original batch. Repeat the identical completion only to retry; a batch cannot be transferred to another turn or caller.

Register known output paths even for large files. Full text capture supports UTF-8 files up to and including 1 MiB. If either version exceeds that limit, review can show an addition, modification, or deletion based on file metadata, without a line diff or automatic undo.

This records review evidence only. It does not grant file access or make a shell change safe to undo. Unregistered changes, a failed begin, a missing completion, unsupported files, or events without a reliable pre-write boundary may be absent from review; an empty review is not proof that no files changed. If capture fails, report the gap and continue the user's task where appropriate.
