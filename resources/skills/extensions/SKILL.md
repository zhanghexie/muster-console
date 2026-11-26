---
x-muster-version: 0.2.9
name: extensions
description: Runtime guide for inspecting, authoring, reviewing, publishing, and invoking current workbench extensions.
---

# Extension Runtime Operations

Use `host.extensions.run({ action, params })` for extension operations. The host binds the current workspace, project, source root, and draft owner; never spoof these identities or reuse one project's binding, data, or credentials for another project.

For project tasks, skill chips, interactive previews and reopening saved works after restart, follow “Building a project artifact workflow” in `~/.muster/skills/muster-extensions/SKILL.md`.

For panel product design, follow the “Product and UI reasoning” section in `~/.muster/skills/muster-extensions/SKILL.md` before choosing a layout. The runtime contract does not determine the information hierarchy or interaction model.

## Actions

| action | params | purpose |
|---|---|---|
| `inspect` | `{}` | Inspect the current workspace, project, source root, management root, and project binding |
| `list` | `{}` | List extensions, scopes, enabled state, review state, and fingerprints |
| `bindProject` | `{mappingKey, expectedRootId?}` | Bind a local mapping key to the selected source root |
| `create` | `{id, scope, mappingKey?, expectedFingerprint?}` | Create a draft owned by the current caller; `scope` is `global` or `project` |
| `write` | `{draftId, path, text}` or `{draftId, path, base64}` | Write one file into a draft |
| `removeFile` | `{draftId, path}` | Remove one draft file |
| `submit` | `{draftId, retryRejected?}` | Validate and submit a complete draft for review |
| `retryReview` | `{id, scope?}` | Review the installed package again. Supply scope if the ID exists in both scopes |

Call `inspect` before creating or binding a project extension. When updating an existing extension, obtain its current fingerprint from `list` and use the host's expected fingerprint field. Global extensions are visible across workspaces but their data remains workspace-scoped; project extensions are visible only for the bound project.

## Drafts and review

The normal publishing sequence is `create` → repeated `write` → `submit` → confirm `approved` with `list`. Toolbar commands are launched from the toolbar. Use the sidebar DomainRuntime for domain commands. If publication returns `stale`, reopen from the latest listed fingerprint and reapply the edit. Write the complete manifest, panel, domain entry, and runtime files before submitting. Include Agent resources when declared.

If review rejects a draft, preserve the host's reason, update the draft, and submit again. Use `retryReview` only for a rejected registered package. Never bypass review, invoke an unapproved package, treat a successful write as publication, or edit host-managed directories directly.

The manifest `version` is a package release marker. It is not a runtime API switch. Use the current contract and do not add old SDK fallbacks, legacy manifest branches, or parallel “new/old” host protocols.

## Panel and domain rules

A sidebar extension declares a sidebar surface, domain entry, data scope, and required permissions. A toolbar extension declares `commandEntry` and commands with `id`, `title`, and `handler`. The `domain` and `agent` fields are reserved for sidebar extensions. Panels use the host-injected `ma` SDK and wait for `ma.ready`.

A toolbar command module exports `createCommandRuntime({ broker })` and returns an `execute({ command, args, context })` handler. Use the absolute `context.sourceRoot` to locate project files and `context.rootsRevision` when a tool needs the source-root revision. The worker's cwd is the extension package directory.

Host AI is optional. Declare `agent` when users would benefit from the host assistant operating the domain. With `agent`, declare `agent.state`, `agent.commands` if the domain has commands, and `agent.mcp` if MCP resources are used. A panel with its own LLM workflow may omit `agent` and use the model bridge with the `models` permission. The `ma.agent.domain` SDK works with either form.

When declared, the Agent shares the panel's DomainRuntime. A domain normally exposes snapshot, query, command, and `state.changed` events:

```js
await ma.ready;
const state = await ma.agent.domain.snapshot();
const result = await ma.agent.domain.command('item.create', args);
const stop = ma.on('state.changed', refresh);
```

Persistent data must be read and written by the domain through the host broker. Panel-local state is limited to drafts, temporary selections, and rendering state. Refresh after commands and after state events. Async reads, date/tab changes, and locale changes must discard stale results instead of letting an older response overwrite the current selection.

Give the Agent only the state, queries, and declared commands needed for its task. Do not put human action history, internal debugging fields, credentials, reverse solutions, or unsolicited context into snapshots. Human clicks do not become model messages automatically; the Agent reads state when it needs it.

## Models, streaming, and media

With the declared permissions, extensions may use host text calls, text streaming, model listing/invocation, file picking, media import/URL/retain/release, export, and reveal. Use the schema returned by the current SDK or tool; do not invent unavailable endpoints.

- Streaming must handle deltas, first-byte waiting, idle chunks, cancellation, panel close, and final errors. Do not use one short total timeout for every modality.
- The host owns model configuration and credentials. Extensions select a provider/model or the host default; never send keys to the panel, Agent, or extension files.
- Text, image, TTS, and ASR may use compatible protocols. Video is usually an asynchronous submit/poll/result workflow. Report missing capability or adapters explicitly; do not assume every HTTP service is compatible.
- Use host asset IDs and media URLs for images, audio, and video. Do not move large base64 payloads through IPC. Call `retain` for assets that must survive panel close or restart; release temporary resources on close and delete with `release`.
- Local files must be authorized by the host file picker before import. Do not pass arbitrary user-supplied absolute paths to an extension worker, media service, or export function.
- Exports accept text or authorized assets. `reveal` accepts only an export reference created by the current instance. Do not implement arbitrary path opening, arbitrary URL proxying, or bypass host SSRF, size, timeout, or concurrency limits.

## UI quality rules

Use the host theme, fonts, locale, and existing interaction patterns. The panel must remain readable in dark mode, light mode, and narrow widths. Long titles, localization, and lists must not expand a fixed sidebar. Expanding or collapsing a group must not change the outer layout width; fixed inputs should disable native resize handles unless free resizing is an explicit product requirement.

For new menus, dialogs, tabs, drawers, or collapsible surfaces, use the host presence/motion primitives. Do not add literal animation durations, `transition: all`, or non-interruptible entrance/exit keyframes. Use native focusable buttons and controls with correct ARIA state.

## Failure handling and security boundaries

Declare `hostTools` in `permissions` and call `ma.tool(name, args)` from the panel or `await broker('tool', [name, args], context)` in a domain handler or toolbar command. Pass the context supplied to the current handler. Use the public names and schemas from the GUI, ACP and PTY Worker toolsets. The extension filter in Capability Management shows the hosted tool names. For example, `await ma.tool('host.browser.run', { action: 'tabs', params: {} })` lists browser tabs. Read the matching domain skill for action parameters. Worker action restrictions apply, so `host.llm.run` exposes `quota`.

The host binds calls to the extension's workspace and source root. `host.ui.notify`, mailbox reads, self updates, background tasks and Node REPL use the extension's own sidebar Agent session. Calls keep their normal approval and interactive-turn requirements. Pass `sessionId` only when the schema accepts a target reference.

Existing extension calls include `host.sessions.select`, `host.runtimes.run` (`list` and `preflight`), `host.tasks.render`, and `host.terminal.write`. Use `host.terminal.create` to open a visible shell in the bound project. Use a session ID from the bound workspace for `host.terminal.write`. Its receipt confirms input delivery. Read build output in the visible terminal.

Report missing permissions, unapproved packages, fingerprint conflicts, missing project bindings, unavailable capabilities, external service failures, platform gaps, and cancellations clearly. Never return fake success, silently switch to an unauthorized path, or describe a Windows result as verified on macOS/Linux.

Extension workers have host machine privileges but are not OS sandboxes. Sensitive operations must rely on host permissions and confirmations. Do not read host-private runtime files, credential files, or another extension's data area.
