---
x-muster-version: 0.1.32
name: themes
description: Parameter reference for host.themes.run — listing, creating, patching, activating and removing workbench color themes. Read this before passing params to any host.themes.run action.
---

# host.themes.run — color themes

Themes drive both the UI and the terminal from one base; changes apply instantly. `host.themes.run` covers the full CRUD plus activation.

## Actions

Required params are marked `*`.

| Action | params | Purpose |
|---|---|---|
| list | {} | List built-in and custom themes; returns `globalThemeId`, `workspaceThemeId` (default = follow global), and `activeId` (workspace override beats global). |
| get | id* | One theme's full palette: `colors` (UI tokens) + `terminal` (xterm 22 colors). Copy as the baseline before editing. |
| create | name* | Create a custom theme by copying the default dark one (id derived from the name); then patch colors with `update`. |
| update | id*, name?, appearance? ('dark'\|'light'), colors?, terminal? | Patch a **custom** theme (built-ins are immutable): partial `colors`/`terminal` keys merge in. Values accept `#rrggbb` / `rgb()` / `rgba()`; unknown keys or invalid colors error. Common keys: `bg-canvas`, `bg-panel`, `bg-raised`, `ink`, `green/red/yellow/blue/purple`; terminal `background`/`foreground`. |
| activate | id?, scope? ('global' default \| 'workspace'), workspaceId?, followGlobal? | Switch themes; UI reskins instantly. `scope:'global'` changes the default every workspace without its own theme follows; `scope:'workspace'` sets only that workspace's override; `followGlobal:true` clears the workspace override (no id needed then). |
| remove | id* | Delete a custom theme and cascade-clean references (global default falls back to built-in dark; workspace overrides pointing here are cleared). Built-ins cannot be deleted. |

## Calling pattern

```
host.themes.run({ action, params })
```
`params` follows the chosen action's original schema; pass `{}` for no-arg actions.

- Inspect then patch: `host.themes.run({ action: "get", params: { id: "night-blue" } })`
  `host.themes.run({ action: "update", params: { id: "night-blue", colors: { "bg-canvas": "#0b1220" } } })`
- Make a theme this workspace's own:
  `host.themes.run({ action: "activate", params: { id: "night-blue", scope: "workspace" } })`
- Return a workspace to following the global default:
  `host.themes.run({ action: "activate", params: { scope: "workspace", followGlobal: true } })`

## Notes

- **Scheduler-side domain.**
- `remove` is dangerous (user confirmation required); it cascades references so nothing dangles.
- Built-in themes are immutable — use `host.themes.run` with action `create` to make a copy first, then `update` the copy.
- When a workspace has its own theme, changing the global default does not change that workspace's UI.
- `appearance` (dark/light) also affects native control look, not just CSS tokens.
- Theme files are not watched: JSON edited outside the panel is re-read on restart or when the theme is re-selected in the panel.
