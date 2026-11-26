---
name: muster-extensions
description: Product and runtime guide for inspecting, authoring, reviewing, publishing, and invoking current workbench extensions.
x-muster-skill: extensions
x-muster-version: 0.2.9
---


# Extension Runtime Operations

Use `host.extensions.run({ action, params })` for extension operations. The host binds the current workspace, project, source root, and draft owner; never spoof these identities or reuse one project's binding, data, or credentials for another project.

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

## Product and UI reasoning

An extension is a product surface with a user outcome, not only a manifest, panel, and DomainRuntime. Before writing UI code, inspect the current extension and its running surface, identify the user's recurring task, and write a short layout rationale. If the user supplied a screenshot, prototype, reference site, or existing implementation, extract the task flow, information hierarchy, density, and interaction pattern from it. Do not copy decoration while missing the work the user is trying to complete.

The pre-coding design note must answer five questions in a few lines: what outcome the user is pursuing, what object they work on, whether the task is browse/compare, create/edit, manage/organize, monitor/triage, or inspect/review, what information and action must stay together, and how loading, empty, error, saved, and large-data states will behave. Resolve these decisions before choosing components or visual styling.

Classify the dominant task before choosing a layout. Use these as starting points and adapt them to the actual data and actions:

| task shape | useful default | primary design question |
|---|---|---|
| browse or compare | repeated compact units, search/filter controls, shortlist or comparison state, secondary detail | how quickly can the user scan and decide among many items? |
| create or edit | dominant work area, focused preview, nearby inspector or controls | can the user see the effect of the current edit without losing context? |
| manage or organize | list or grid with status, search/sort, per-item or batch actions | can the user locate, classify, and act on an existing item? |
| monitor or triage | summary, ordered queue or timeline, severity and next action | can the user recognize what needs attention and act from the same surface? |
| inspect or review | content first, context and metadata nearby, history and explicit actions | can the user understand the item before changing it? |

Derive information hierarchy from task frequency and decision cost. Keep the primary object and the information required for its next decision visible together. Use progressive disclosure for full text, history, advanced settings, and rarely used actions. Let repeated comparison tasks stay information-dense, and give focused creation tasks room for manipulation. Do not use a generic dashboard, oversized preview, or text-only list as the default when it hides the information needed for the primary task.

Design the full state model before polishing the happy path. Account for loading, empty, error, disabled, saved, unsaved, long-content, and large-collection states. Use representative real data during design and verification, including items with missing media, long titles, unavailable sources, and older saved records. Keep host theme, locale, accessibility, and motion rules, while allowing the extension's layout to follow its domain task.

For an existing extension, preserve working behavior and data while improving the user's main workflow. Confirm that the first interaction leads toward the primary outcome, that navigation preserves useful context, and that commands visibly update the panel through DomainRuntime state. A minimal implementation is complete only when the primary user task works end to end, including persistence and recovery from ordinary failures.

When the surface changes, use the available UI verification workflow to exercise the real panel with representative data. Check the main task, narrow layouts, both color schemes, keyboard and focus behavior, empty and error states, and any changed dialogs, tabs, menus, or transitions. After a package update, reload or reopen the extension and verify that the new version and visible behavior are actually loaded. Do not report a source-file edit as a runtime result.

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

## Building a project artifact workflow

- For “Create” or “Make a copy”, declare `project.tasks` and call `ma.tasks.create(title, draft)`. Start the draft with the declared skill name, e.g. `/guizang-ppt-skill Make a deck about …`. The New Task dialog shows the skill chip and lets the user edit the request. Cancel leaves the session list unchanged. Use the existing sidebar conversation for follow-up on work made there.
- Bundle the files each skill reads relative to its `SKILL.md`, including templates, scripts and sample assets. The skill-read tool returns `skillRoot` and accepts a relative `resource` for UTF-8 files. Exercise a real template from the installed package. Document any extra dependency required to render the requested output.
- Write the deliverable in the originating project task directory. In the domain command that registers a work, save its project-relative path and `const target = context.taskRef ?? context.sessionId` from the host. Use a stable work ID for subsequent edits. The panel uses `ma.tasks.open(target)` to resume, `ma.tasks.preview(target, relativePath)` to open the original, and `ma.tasks.thumbnail(target, relativePath)` for its HTML cover. This also preserves the working directory of isolated tasks.
- For a bundled HTML example or standalone HTML string, create an export containing the entry and its relative assets, then call `ma.exports.preview(exportId, fileName)`. The right-hand browser runs the page scripts. Use `ma.exports.thumbnailHtml(html)` for a standalone cover. On library removal, await `ma.ui.confirm({ title, detail, confirmLabel, danger: true })` before changing the index. Specify whether the underlying file is kept.
- For deterministic HTML animation work, an extension declaring `hostTools` may call `ma.tasks.validate({ tabId })` and `ma.tasks.render({ action: 'start'|'preview'|'status'|'cancel', tabId, renderId?, width?, height?, durationMs?, fps?, times? })`. The host uses the workbench built-in browser and Node/WebCodecs/WebM path; do not add Python, Playwright, or external Chrome/Chromium as an extension dependency. `start` is asynchronous and must be polled by `status` (`times` and `durationMs` are milliseconds; the page contract still receives seconds). A completed result must include a `video/webm` artifact with its actual dimensions and frame count; failed/cancelled jobs expose a `failure` stage, frame/time and next step. Only a completed artifact may be registered as a work result. A generated artifact path returned by the trusted render receipt may be passed through the existing media import bridge; arbitrary panel paths remain unauthorized.
- Test through the installed panel. Cancel a prefilled task, then open a real artifact and operate its controls (for slides, advance one page with an arrow key). Fully quit and reopen the host, then use the same card to load its thumbnail, preview, and resume editing. Include an older saved entry when changing the catalog format. If its original session is gone, show the proposed project file and get confirmation before saving a replacement reference.
