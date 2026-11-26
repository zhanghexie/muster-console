---
x-muster-version: 0.1.35
name: core-context
description: Use the built-in Core tool core_context to inspect, summarize, expand, or recover evidence from the current conversation branch.
---

# Core conversation history

Use `core_context` when a completed phase can free substantial space. Core may suggest a boundary while the model still has ample room. Keep exact paths, decisions, unresolved failures, changed requirements and the next action in the summary. The current tool group must finish before a change takes effect.

| Action | Arguments and result |
|---|---|
| `status` | Lists usage, recent checkpoint IDs and available prefix boundaries, newest first. Pass the returned `next` unchanged as `offset` for older boundaries. Small mode budgets can shorten previews. |
| `fold` | Pass `keep` from a listed boundary and a `summary` to replace history before that entry. For a bounded range, pass the suggested `start` as well. The start is included and the keep entry stays visible. This can summarize work after a protected image. Alternatively, pass an original tool result `id` and a `summary` to distill only that result. Submit one history change per group. |
| `sources` | Pass a Core checkpoint `id` for its original entries and preceding checkpoint. Continue at `next` if present. |
| `search` | Pass a literal `query` to find original text on this branch. Each hit contains an entry ID, a character offset and a preview. Continue searching at the response's `next`. |
| `read` | Pass an entry `id` and optional UTF-16 `offset`. Use a hit's offset for the exact passage or start at zero. Continue at `next` until null to read all pages. |
| `expand` | Pass the active Core checkpoint `id` to restore its preceding generation or restore one active range in place. For evidence from an older checkpoint use `sources` and `read`. |

For example, after a summary omits a configuration key, search for its literal prefix, then read the original tool result at the returned offset. Quote the original line when its spelling matters.
