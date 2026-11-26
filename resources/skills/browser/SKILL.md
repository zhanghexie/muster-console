---
x-muster-version: 0.1.43
name: browser
description: Parameter reference and recipes for host.browser.run — driving the built-in browser (open tabs, navigate, click, fill, snapshot, screenshot). Read this before passing params to any host.browser.run action.
---

# host.browser.run — built-in browser control

`host.browser.run` is the single entry point for the workbench built-in browser. It addresses individual webviews and keeps the user's foreground tab and system cursor in place.

## Actions

Required params are marked `*`. `tabId` is always the stable id returned by `tabs` / `open`.

| Action | params | Purpose |
|---|---|---|
| open | url* | Open a new background page as your active tab; returns the new tabId (no foreground switch, no focus steal). Full URL or a search phrase. |
| close | tabId* | Close the given tab. |
| activate | tabId*, foreground? | Make the tab your active target. Default stays background; `foreground:true` also brings it to the browser foreground (for recording / human collaboration). |
| navigate | tabId*, input* | Navigate the tab to a URL or search phrase. |
| tabs | {} | List every tab (id/title/url/loading/canGoBack/...). |
| snapshot | tabId*, selector?, interactiveOnly?, offset?, maxChars? | Accessibility-tree snapshot (YAML) with `[ref=eN]` refs; page through with `offset`/`maxChars` (default 9000, range 500-10000). |
| click | tabId*, target* | Click a snapshot ref (e.g. `e12`, `f3e13`), CSS selector, or viewport point `"x,y"`. For canvas, coordinates send synthetic pointer, mouse, and click events. |
| fill | tabId*, target*, text* | Background DOM-semantic text fill into input/textarea/contenteditable (plain-text replacement for contenteditable). |
| selectOption | tabId*, target*, value* | Select a native `<select>` option by value or visible text (synthetic input/change). |
| pressKey | tabId*, key*, target? | Synthetic keydown/keypress/keyup (Enter in an input also submits). Key names: Enter / Escape / ArrowDown / Control+a ... |
| hover | tabId*, target* | Send synthetic JS hover events to the element. Use `movePointer` for CSS `:hover`. |
| movePointer | tabId*, target* (`"x,y"`) | Move the guest pointer to viewport CSS pixels with no buttons pressed. Updates CSS `:hover` and sends browser pointer/mouse move events without granting user activation. |
| scroll | tabId*, target?, direction? (up\|down, default down), amount? (px 50-4000, default 600) | Scroll a container by ref or CSS selector. With no target, scroll the main document. |
| waitFor | tabId*, selector? \| text? \| url? \| hiddenSelector? \| state? (load\|domcontentloaded\|networkidle), timeoutMs? (default 10000), timeMs? | Conditional wait; with no condition given, wait `timeMs` milliseconds. |
| screenshot | tabId*, selector?, fullPage? | Save PNG and return its absolute path. `selector` captures an element. `fullPage:true` captures the main document through its scroll extent, then restores its position. |
| evaluate | tabId*, expression* | Evaluate a JS expression in the page main frame (userGesture forced false, focus/blur side effects blocked); returns the serialized result. |
| upload | tabId*, target*, files*, workspaceId? | Assign caller-readable local files to a file input; file snapshots and the actual page/frame destination are checked by the safety gate. Total files must be under 50 MiB for the current Playwright transport. Assignment does not prove server-side upload: verify it separately. Empty `files` clears the input. |
| drag | tabId*, from*, to*, timeoutMs? | DOM-semantic drag; `from`/`to` accept ref/CSS selector or decimal "x,y" viewport coordinates. |
| setViewport | tabId*, (width + height) \| reset:true | Set page viewport 320-3840 x 320-2160; `reset:true` restores the native viewport (not combinable with width/height). Survives tab rebuilds. |
| dialog | action* (list\|accept\|dismiss\|policy), tabId*, dialogId?, promptText?, policy? (manual\|auto-accept\|auto-dismiss) | Answer a JavaScript dialog and resume the page. Accept/dismiss defaults to the earliest dialog. Prompt acceptance uses the supplied string, including `""`, or the default when omitted. Dismissal returns `null`. |
| recording | action* (start\|stop\|status\|cancel), tabId? (start), recordingId? (stop/status/cancel) | Record the visible page as WebM; hidden pages return `capability_unsupported`. Duration cap 120s. |
| cookies | action? (get\|set\|clear, default get), tabId?, cookies?, urls?, name? | Read/write globally shared, persisted cookies. `set` items need name+value plus url or domain (url wins). |
| storage | tabId*, action? (get\|set\|remove\|clear, default get), kind? (local\|session, default local), key?, value? | Read/write page localStorage/sessionStorage (string values); key omitted on get = all. |
| console | tabId*, level? (verbose\|info\|warning\|error), contains?, limit? (default 50) | Read captured console output (errors included). |
| network | tabId*, action? (list\|body, default list), method?, status?, contains?, limit?, requestId? | Read captured requests; `action:"body"` fetches a response body by requestId from list. |
| downloads | limit? | List files downloaded by the built-in browser (absolute local paths). |

## Calling pattern

```
host.browser.run({ action, params })
```
`params` follows the chosen action's original schema (see table); pass `{}` for no-arg actions (`tabs`, `downloads` without a limit).

- Open, snapshot, then click by ref:
  `host.browser.run({ action: "open", params: { url: "https://example.com" } })` → use the returned tabId
  `host.browser.run({ action: "click", params: { tabId: "t3", target: "e12" } })`
- Wait for navigation, then screenshot the full page:
  `host.browser.run({ action: "waitFor", params: { tabId: "t3", url: "**/done", timeoutMs: 15000 } })`
  `host.browser.run({ action: "screenshot", params: { tabId: "t3", fullPage: true } })`
- Scroll an independently scrollable element with `host.browser.run({ action: "scroll", params: { tabId: "t3", target: "#results", amount: 480 } })`.
- For CSS hover or canvas, use viewport CSS pixels from the top-left of the current view. For example, `host.browser.run({ action: "movePointer", params: { tabId: "t3", target: "320.5,180" } })`. Pass the same point to `click` to send synthetic click events. Divide viewport screenshot pixel coordinates by the page's device pixel ratio.
- If an action returns `pendingDialogs`, answer the matching dialog before continuing page actions. For example, `host.browser.run({ action: "dialog", params: { tabId: "t3", action: "accept", dialogId: "dg2", promptText: "Yes" } })`.
- List tabs: `host.browser.run({ action: "tabs", params: {} })`

## Notes

- **Visibility & permission tiers**: available to Worker sessions on all presets (GUI / PTY / ACP). Read-class actions (`tabs`, `snapshot`, `console`, `network`, `downloads`) pass automatically; all other (operation-class) actions route through the browser permission tier and may pop an approval card depending on the session's permission tier.
- **tabId semantics**: every action addresses a tab by its stable `tabId` (from `tabs`/`open`), resolved via the authoritative guest binding — never by URL, never by the user's foreground tab. Your active tab (last `open`/`activate`) is private to your caller identity; the user switching tabs does not interfere.
- **Refs** are `e12` or frame-prefixed, e.g. `f3e13`. Pass them verbatim to click, fill, selectOption, hover, and targeted scroll. For cross-origin frames, use refs to operate on elements.
- **Queuing** is per tab. Mutations and screenshots run FIFO. Dialog handling, snapshot, and waitFor can run while an action is waiting. Unanswered manual dialogs expire after 120 seconds.
- **Input** uses synthetic button and key events. `movePointer` sends only button-free browser pointer motion. Browser controls that require activation, and editors needing trusted presses, need manual operation.
- **Full-page captures** cover the document size at capture start. Scroll handlers may run during capture and fixed or sticky elements can appear in multiple segments. For pages over 40 million output pixels or a 32,767-pixel dimension, capture a viewport or a specific element.
- **Shared state**: login state, cookies and storage are globally shared and persisted across all AIs and workspaces (no isolation).
