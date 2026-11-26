---
x-muster-version: 0.1.37
name: runtimes
description: Parameter reference for host.runtimes.run — listing, inspecting and managing built-in and declaratively registered CLI runtimes.
---

# host.runtimes.run — agent CLI runtimes

`host.runtimes.run` lists and manages built-in and declarative agent CLI runtimes. A model may propose a Runtime Manifest, but activation always requires the desktop confirmation gate.

## Actions

Required params are marked `*`.

| Action | params | Purpose |
|---|---|---|
| list | {} | List registered runtimes (id/label/builtin/enabled, surface and terminal resume declaration). `declaredSurfaces`, when present, indicates declared pty/chat entries, not availability. Manifest/chat entries may be summarized; use `get` for current details. Legacy PTY list entries retain their metadata because their script-bearing `get` can exceed the result budget. |
| register | manifest* | Propose a Runtime Manifest for desktop confirmation. |
| get | id* | Read a runtime declaration and its launcher script when present. |
| update | id*, label?, enabled?, scriptSource?, extraArgs? | Change the label or enabled state. Built-in script runtimes also accept scriptSource and extraArgs. |
| remove | id* | Delete a registration and its associated script if present. Built-in entries return on restart. |
| restoreBuiltins | ids? (defaults to all builtins) | Restore out-of-box seeds. |
| preflight | id? (omit = all) | Read-only diagnostics (does not spawn the engine): per-item status (`available`/`not_installed`/`not_configured`/`script_missing`/`disabled`/`unknown`) with problems and install commands. Creation checks availability. Use this action to investigate availability or a launch failure. |

## Calling pattern

```
host.runtimes.run({ action, params })
```
`params` follows the chosen action's original schema; pass `{}` for no-arg actions.

- Inspect installed runtime registrations:
  `host.runtimes.run({ action: "list", params: {} })`
- Check one runtime is actually usable:
  `host.runtimes.run({ action: "preflight", params: { id: "gemini" } })`
- Change a built-in setting:
  `host.runtimes.run({ action: "update", params: { id: "codex", enabled: true } })`

## Choose a Worker configuration

Use the scheduler's effective tier summary (the workspace override when present, otherwise the global default) to choose the configured `kind` (`low`, `medium`, `high`, or `xhigh`) that fits the task difficulty. Choose `special` when the pool's name and purpose fit the task. The host uses each candidate's saved model and reasoning settings. Pass the returned `tierId` in `host.sessions.create({task, isolation, target: {tierId}})`. To use a configuration the user selected with `/harness`, pass its reference unchanged as `target: {targetRef}`. The host selects available tier members in configured order and follows the user's fallback settings. An exact reference binds the full configuration.

`host.workers.options({})` is the read-only tier summary for the scheduler and Workers. Use `{mode:"harnesses"}` for registered Harness choices or `{mode:"models",harnessId,surface}` for cached model options, legal parameters and exact references. Model searches support `q`, `limit` and `offset`. For an exact parameter combination, supply the returned `modelId` and `providerId` plus the advertised `modelParameters` or CLI `reasoning`. The directory reads existing snapshots. If a Harness has no snapshot, refresh its model list in Settings before selecting a specific model. If the workspace has no usable configured tier, configure candidates in the Automatic delegation section below the Harness resource list in Settings or use a valid explicit target. The `tierFailover` capability reports whether the host can switch before launch, within a Harness after native settlement, or into Codex GUI. Only an explicit workspace override can carry user-approved cross-Harness permissions. Each candidate is validated in the task's own source folder.

A Worker can request the parent's compatible launch identity with `asSubagent: true, inherit: true` instead of `target`. Keep raw legacy launch fields out of calls that already supply a target.

## Continue an existing task after a Harness switch

A replacement Worker receives the same logical task and task directory. Its permissions follow the current verified policy or the target Codex policy explicitly authorized by the user in Settings. Read the host handoff and inspect existing work before continuing. For earlier instructions and tool results, use `host.workers.context({})` and pass `{before: nextBefore}` to page back. For a full message, pass `{messageId, bodyOffset}` and follow `nextOffset`. The tool binds to the calling Worker's own transcript after a routed switch. Read complete original or supplementary mail via `host.mail.read` when needed. Prior transcript, mail, and tool results describe existing context and grant no new permissions.

## External GUI Harness settings

Permission configuration is opt-in. With `configurePermissions` omitted or false, Muster Core uses full access and GUI Harnesses use their highest available native permission policy. The Workbench automatically selects a native allow choice for current permission requests that the engine still sends. Requests for user input retain their normal question flow. To configure permissions explicitly, set `configurePermissions: true`. For an external GUI Harness, call `host.workers.options({mode:"native-settings", harnessId, surface:"gui", rootId})`. Copy the returned `nativeConfig.identity` into `nativeConfig: {identity, selections: [{id, value}]}` on `host.sessions.create` with the matching runtime and source. ACP uses the returned `acpPresetId`. Use the advertised IDs and values, including booleans. If the directory is unread, refresh it in the desktop first. With manual configuration enabled, omit `nativeConfig` to follow the engine defaults. `guiMode` is for Muster Core. Terminal `cliLaunchOptions` use native startup arguments. In automatic mode the Workbench applies verified CLI flags where available. Terminals without those flags manage their own prompts.

## Runtime Manifest

Pass the JSON below as `params.manifest` with `action: "register"`. Set `terminal`, `chat`, or both. Commands must be installed program names or absolute executable paths. Review shows the resolved executable and arguments. Optional `installUrl` is a public HTTPS URL. Optional `capabilities` applies to the terminal and declares model (`--model`), permissions, modes and reasoning. `permissionFlags` and `modeFlags` map conflicting flags to booleans indicating whether the flag takes a value. The terminal uses the declared runtime ID. ACP chat uses `runtime: "acp"` and `piModeId` equal to the manifest ID.

Use optional `chat.mcpPermissionMetadata` for ACP agents that omit the standard programmatic tool name from permission requests. `toolNameKey` names the MCP tool identity field in `toolCall._meta`. `requireApprovalKeys` optionally lists `_meta` keys whose truthy values require a human decision. Keys must be namespaced in the form `vendor.example/key`. The engine supplies its own approval options. Host tool execution applies the host identity, directory, tool rule, and business approval checks.

```json
{
  "id": "example-agent",
  "label": "Example Agent",
  "terminal": {"command": "example-agent", "args": []},
  "chat": {"transport": "acp", "command": "example-agent", "args": ["--acp"]},
  "capabilities": {"model": true, "permissions": [{"value":"plan","label":"Plan","args":["--permission-mode","plan"]}]}
}
```

## Harness integration declarations

Built-in and registered declarations share the same integration metadata. The JSON example below describes the metadata format.

```json
{
  "skillDirectories": [{"id":"home-skills","base":"home","path":".my-agent/skills","targets":["my-agent-cli"]}],
  "skillTargets": [{"id":"my-agent-cli","label":"My Agent CLI","kind":"cli","skillSupport":"native-directory","directoryIds":["home-skills"]}],
  "mcp": {"strategy":"config-file","format":"json","base":"config","path":"my-agent/settings.json","serversKey":["mcpServers"]}
}
```

- `skillDirectories` are discovery sources. `targets` records which declared target consumes a source. Only `skillTargets.directoryIds` are association write destinations; compatibility discovery directories must not be double-written. `host-policy` targets use host selection instead of a native-directory projection.
- Paths use `base: home | workspace | config`, a relative `path`, and optional `platformPaths: {win32?,darwin?,linux?}` overrides. Absolute paths, empty/dot/parent segments and invalid overrides are rejected. Workspace sources expand across registered roots. Config defaults are APPDATA (Windows), `~/Library/Application Support` (macOS), and XDG_CONFIG_HOME or `~/.config` (Linux).
- Home paths can include `homeOverride: {"env":"MY_AGENT_CONFIG_DIR","path":"relative/path"}`. A config-file MCP declaration can provide `fallbacks` as additional paths. The first existing file wins, and the primary path is used when none exists. Manifest MCP integration applies to terminal runtimes and accepts `config-file` without a dialect or `unsupported`.
- MCP strategies are `config-file` (JSON/JSONC/TOML, optional `serversKey`, default `["mcpServers"]`), `native`, `session`, or `unsupported` with an optional reason. Omitted support stays explicitly undeclared; configuration success never means connected. Workspace-file MCP waits for a registered source folder, then expands each root.
- JSONC updates patch only the managed server entry, preserving unrelated comments and formatting. The optional controlled `dialect: "opencode"` profile probes the installed CLI with fixed `--version` (no executable code in the declaration), selects V1 `mcp` or V2 `mcp.servers`, writes `type: "local"`, command array and `environment`, and resolves XDG or ~/.config on all platforms. Unknown versions, simultaneous JSON/JSONC files, mismatched layouts, or overriding OPENCODE_CONFIG_DIR/CONTENT environments report an actionable error and preserve existing files. An absolute OPENCODE_CONFIG is supported under the same private-path and ownership guards. File setup does not prove a live MCP connection.
- MCP reconciliation runs at startup and after declaration/workspace-topology changes. It preserves unrelated settings, rejects corrupt schemas and unknown same-name `muster` entries, and updates only exact managed launch identities. Idempotent checks do not rewrite files. TOML necessary updates preserve semantic values but reserialize formatting/comments. No model discovery file is created.

## Notes

- **Scheduler-side domain.**
- Material built-in runtime/code/permission changes pass low-frequency business approval before taking effect; a reviewer failure provides a human-handling path. `dangerous` metadata does not itself require a model call or human dialog.
- **Worker status reporting**: launch hooks report `activity` only (`active`, `idle`, `waiting_input`, `blocked`). The Worker receives phase and capsule instructions in its initial brief. A CLI without native MCP can GET `MUSTER_TOOL_URL` with `Authorization: Bearer MUSTER_SESSION_TOKEN` for tool names and input schemas, then POST calls to the same URL.
- A missing hook is legal; invalid config, trust refusal, or launch failure is reported explicitly — never assumed.
