---
x-muster-version: 0.1.2
name: panel
description: Reference for host.panel.run actions, kinds, layout ids and workspace targeting.
---

# Panel tools

Call `host.panel.run({ action, params })`. Actions: `list`, `open`, `split`, `focus`, `close`. `params` must be an object; pass `{}` when the action takes no arguments. Every unsupported placement or unknown field is rejected — this document is the only parameter reference, the resident schema does not repeat it.

`workspaceId` selects whose layout to read or change; omit it for the caller's workspace. Panels are the workbench's own tabs, splits, and editors. Use `host.desktop.run` for operating-system windows.

## action: list

`params: {}`. Returns the caller workspace's tabs, center and right layouts, current selection, and editor state. `snapshot.right.split` is `null` in single view. In split view, it contains `layoutId`, `tabIds` in physical slot order, and `ratio` (two panes) or `ratios` (three panes). Empty slots are `null`. `snapshot.right.selectedTabId` identifies the focused tab. Use `snapshot.right.tabs[].id` for panel actions, including browser tabs.

## action: open

`params` requires `kind`. Optional for every kind: `workspaceId`, `focus` (boolean, default false — opening does not take focus) and `placement` (`right` default, or `center`).

Each kind accepts only its own fields; any other field is rejected.

| kind | required | optional |
|---|---|---|
| `file` | `path` or `fileRef` (exactly one) | `line` (integer ≥ 1) |
| `diff` | `repoPath`, `filePath`, `staged` (boolean) | `untracked` |
| `git` | `repoPath` | |
| `review` | `owner` as `{ kind: "gui" \| "dispatch", id }` | `messageId`, `repoPath`, `filePath` |
| `browser` | `browserId` | |
| `session` | `sessionId` | |
| `utility` | `sel` | |
| `extension` | `nodeId` | |
| `settings` | | |

`fileRef` is `{ workspaceId, rootId, relativePath }` and must resolve inside the workspace. Browser views support the right panel only; `placement: "center"` is rejected rather than silently downgraded. Opening an already-open view focuses or reuses it instead of duplicating it. Opening does not start or resume a session.

For `kind: "browser"`, `focus: true` can present an existing HTTP(S) tab owned by the current calling session even when that session is hidden (for example an extension sidebar). This promotes that one tab to workspace-shared presentation and preserves its page and original session identity. Another session’s hidden tab cannot be promoted. With `focus` omitted or false, only already projected tabs are queried. Local `file:` and `muster-ext:` tabs remain redacted. No browser tab is created or navigated by this action.

## action: split

**Center**. Omit `placement` or pass `"center"`. Provide `layoutId` and `panes` in slot order. A pane is exactly one of `{ kind: "session", sessionId }` or `{ kind: "utility", sel }`. Center presets are `halves`, `wide`, `stack`, `focus`, `focus-mirror`, and `thirds`.

**Right**. Pass `placement: "right"`, `layoutId`, and `tabIds` in physical slot order. Use two distinct existing right-tab IDs for `halves` (left to right) or `stack` (top to bottom). Use three for `thirds` (left to right), `focus` (left, top right, bottom right), or `focus-mirror` (top left, bottom left, right). Call `list` to obtain IDs within the caller's read scope. Open missing views before arranging them. A deferred docked view must be explicitly activated first.

For two right panes, optional `ratio` is the first pane's fraction of the width or height. For three, optional `ratios: [a, b]` gives the two divider positions. In `thirds` both positions are measured from the left, with at least 0.2 between them. In `focus` and `focus-mirror`, `a` is measured from the left and `b` from the top. Every value is between 0.2 and 0.8. Omit the ratios to use the preset proportions. To resize, send the same IDs and preset with new ratios.

```js
host.panel.run({ action: "split", params: {
  placement: "right", layoutId: "halves", tabIds: ["right-2", "right-5"], ratio: 0.6
}})
```

A right split reveals the right workbench and keeps its current selection if included, otherwise selects the first slot. Tabs outside the requested layout remain open. The host checks current tab identity, the caller's read scope, and unsaved edits before applying changes. If the outcome is `unknown`, call `list` before retrying.

## action: focus

`params` requires exactly one of:

- `tabId` — focus one right-panel tab, including a tab already visible in a split slot;
- `page` — `terminal` or `git`;
- `target` — a pane object as above, to focus that center slot.

Optional `workspaceId` selects the workspace; a target in another workspace starts in the background and does not steal focus. Unknown or closed ids fail explicitly — focusing never opens a new view to satisfy the request.

## action: close

`params` requires exactly one of:

- `tabId` — close that right-panel tab;
- `target` — close that center pane by pane object;
- `placement: "center"` together with `slot` (integer 0–2) — close the center slot by index.
- `placement: "right"` with `slot` (integer 0–2) — remove that right split slot and keep its tab open. Omit `slot` to collapse the right split to the currently selected tab. Read slot order with `list`.

Closing a view leaves its session running. Right split changes preserve the tab list and may be refused while an affected editor has unsaved changes.
