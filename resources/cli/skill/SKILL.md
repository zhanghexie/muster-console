---
name: muster-console-cli
description: Submit a task to the local Muster Console scheduler, follow GUI or terminal workers, answer task questions and retrieve final results. Use when asked to delegate work through Muster Console or inspect a Muster CLI task.
---

Use the installed `muster` CLI. Start with `muster --help`; inspect a
subcommand with `--help` or `muster schema "run submit" --json`. Help and
schema are authoritative for the installed version.

1. Run `muster status` and `muster workspace list`. Choose the intended
   workspace explicitly. If discovery fails, run `muster doctor`. Multiple
   instances require `--instance ID` on subsequent calls.
2. Write the task, constraints and deliverables into a UTF-8 file. Submit with
   `muster run submit --workspace <id> --file <path> --idempotency-key <key>`.
   Keep the returned runId. Reuse the same key and content if submission status
   is uncertain; do not create duplicate work.
3. Use `run wait <runId> --timeout 120`. Timeout ends waiting, not execution.
   For progress use `run get`, and `run logs --after <nextCursor>` for incremental
   source-labelled events. Worker transcript entries are labelled tail snapshots.
4. When waiting for input, read the question and answer with `run reply <runId>
   --question-id <id> --file <path> --idempotency-key <reply-key>`. Task replies
   cannot approve human-only actions; report the required user action instead.
5. Fetch `run result <runId>`. Only `state=delivered` is a successful delivery;
   report its summary, artifacts and verification limits. A scheduler reply,
   idle terminal or successful submission is not task completion.

Use `open <runId>` to show the scheduler conversation when the user needs to
take over. Use `run cancel` only when cancellation is intended; it affects the
run's dedicated workers and does not stop the shared scheduler conversation.
Cancellation can report per-worker errors; terminal Ctrl+C is an interruption
request rather than proof of process exit. A restarted workbench marks unfinished
runs interrupted and never automatically resubmits them.

Default output is JSON. Exit codes and error recovery hints are available in
help/schema. The workbench must already be running as the same OS user. An Agent
app started before installation may need restarting to inherit the updated PATH.
