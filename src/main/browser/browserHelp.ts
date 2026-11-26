/**
 * browser.* 工具完整用法目录（R5 后为诊断/参考数据：发现层退役，模型面经
 * browser.run 单入口 + ~/.muster/skills/browser/SKILL.md 取用法；本表保留给
 * 目录查询工具与测试对账）。新增/调整 browser.* 工具时同步维护本表与技能文档。
 */
export interface HelpEntry {
  summary: string;
  params: string;
  example: string;
}

export const BROWSER_HELP: Record<string, HelpEntry> = {
  'browser.tabs': {
    summary: 'List every tab of the built-in browser (id/title/url/loading); actions run in the background by tabId without stealing foreground focus; same-page input and page mutations queue in arrival order, cross-page runs in parallel, and the user switching tabs does not interfere',
    params: '{}',
    example: '{}'
  },
  'browser.open': {
    summary: 'Open a new page in the background, make it this AI\'s active tab, open the URL (or search phrase), and return the tabId; the user\'s tab and focus are untouched. All pages share the persistent login state',
    params: '{url?: string}',
    example: '{"url": "https://example.com"}'
  },
  'browser.close': {
    summary: 'Close the given tab',
    params: '{tabId: string}',
    example: '{}'
  },
  'browser.activate': {
    summary: 'Make the tab this AI\'s active target; selected in the background by default (no foreground switch or focus steal) — foreground:true brings it to the browser front for display',
    params: '{tabId: string, foreground?: boolean}',
    example: '{}'
  },
  'browser.navigate': {
    summary: 'Navigate the tab to a new address (URL or search phrase)',
    params: '{tabId: string, input: string}',
    example: '{"input": "小红书"}'
  },
  'browser.snapshot': {
    summary: 'Take an accessibility-tree snapshot (YAML); interactive elements carry [ref=eN] (inside iframes or after frame rebuild, the fNeM frame-prefixed form, e.g. f3e13 — pass it to target verbatim); selector narrows the scope, interactiveOnly keeps interactive elements only, offset/maxChars page through; the response also carries pendingDialogs and consoleErrors',
    params: '{tabId: string, selector?: string, interactiveOnly?: boolean, offset?: number, maxChars?: number}',
    example: '{"selector": "main", "interactiveOnly": true}'
  },
  'browser.click': {
    summary: 'Background DOM-semantic click by snapshot ref, CSS selector, or viewport "x,y" in CSS pixels. A coordinate click hit-tests the page and sends synthetic pointer, mouse, and click events, including to canvas',
    params: '{tabId: string, target: string}',
    example: '{"target": "e12"} or {"target": "320.5,180"}'
  },
  'browser.fill': {
    summary: 'Background DOM-semantic fill of text into input/textarea/contenteditable without focusing; dispatches synthetic beforeinput/input/change. contenteditable gets plain-text replacement with no formatting kept; editors relying on trusted input or proprietary models need manual operation',
    params: '{tabId: string, target: string, text: string}',
    example: '{}'
  },
  'browser.selectOption': {
    summary: 'Background DOM-semantic selection of a native <select> option (value = the option\'s value or visible text); dispatches synthetic input/change without opening the native menu',
    params: '{tabId: string, target: string, value: string}',
    example: '{}'
  },
  'browser.pressKey': {
    summary: 'Background DOM-semantic key events (keydown/keypress/keyup; Enter can trigger form submission) without stealing host focus; optionally pass target for the element',
    params: '{tabId: string, key: string, target?: string}',
    example: '{}'
  },
  'browser.hover': {
    summary: 'Background DOM-semantic hover event sequence dispatched to the target element (pointerover/pointerenter/mouseover/mouseenter/mousemove) without stealing focus',
    params: '{tabId: string, target: string}',
    example: '{}'
  },
  'browser.movePointer': {
    summary: 'Move the guest pointer without pressed buttons, updating CSS :hover without granting user activation',
    params: '{tabId: string, target: string}',
    example: '{"target":"320.5,180"}'
  },
  'browser.scroll': {
    summary: 'Scroll the document or the optional container ref/selector with DOM scrolling, by 50–4000 CSS pixels (default 600)',
    params: '{tabId: string, direction?: "up"|"down", amount?: number, target?: string}',
    example: '{"target":"#results","direction":"down","amount":480}'
  },
  'browser.waitFor': {
    summary: 'Conditional wait: selector appears / text visible / url matches (globs supported) / hiddenSelector disappears / state load state; with none given, wait timeMs. Waiting does not occupy the same-page operation queue — a later action can satisfy the condition',
    params: '{tabId: string, selector?: string, text?: string, url?: string, hiddenSelector?: string, state?: "load"|"domcontentloaded"|"networkidle"|"visible"|"hidden", timeoutMs?: number, timeMs?: number}',
    example: '{"selector": "#result", "timeoutMs": 8000}'
  },
  'browser.upload': {
    summary: 'Assign caller-readable files to a file input without opening a chooser; server-side upload remains unverified and needs separate observation',
    params: '{tabId: string, target: string, files: string[], workspaceId?: string}',
    example: '{"target": "input[type=file]", "files": ["docs/report.pdf"]}'
  },
  'browser.drag': {
    summary: 'Background DOM-semantic drag (from/to accept ref/CSS selector or decimal "x,y" coordinates; dispatches a pointer/mouse/drag event sequence and always releases in finally)',
    params: '{tabId: string, from: string, to: string, timeoutMs?: number}',
    example: '{"from": "e3", "to": "e7"}'
  },
  'browser.setViewport': {
    summary: 'Set the tab\'s page viewport size (responsive-layout checks): width/height clamp to 320-3840x320-2160, invalid values error outright; changes only that tab\'s page content area (not the window) and survives tab rebuilds (crash recovery); a successful Emulation override does not guarantee a successful screenshot — screenshots still capture the actually visible area',
    params: '{tabId: string, width?: number, height?: number, reset?: boolean}',
    example: '{"width":390,"height":844} / {"reset":true}'
  },
  'browser.recording': {
    summary: 'Record the currently visible native page as a WebM video (async task): start begins (needs a ready tabId; one recording per tab at a time); a hidden page returns capability_unsupported without auto-showing or focusing. stop stops and muxes (the .webm output is user-visible, not model-visible); status queries; cancel discards. Hitting the duration/frame/byte cap auto-stops; closing the tab or a crash rebuild wraps up automatically',
    params: '{action: "start"|"stop"|"status"|"cancel", tabId?: string, recordingId?: string}',
    example: '{"action": "start", "tabId": "bt3"} -> remember the recording id; later {"action": "stop", "recordingId": "rec1-abc"}'
  },
  'browser.dialog': {
    summary: 'Handle JS dialogs (alert/confirm/prompt): list shows the queue; accept/dismiss handle them (prompt takes promptText); policy sets the auto strategy (auto-accept/auto-dismiss/manual, default manual)',
    params: '{action: "list"|"accept"|"dismiss"|"policy", tabId: string, dialogId?: string, promptText?: string, policy?: "manual"|"auto-accept"|"auto-dismiss"}',
    example: '{"action": "accept", "dialogId": "dg2", "promptText": "你好"}'
  },
  'browser.cookies': {
    summary: 'Read/write globally shared, persisted cookies: get (filter by urls/name) / set (name+value+url or domain; with domain, path defaults to /; when both url and domain are given, url wins) / clear. tabId defaults to the tab this AI last selected via open/activate and must be explicit when nothing was selected; the user\'s foreground selection is never read. Pages of each AI execute independently but cookies are not isolated',
    params: '{action: "get"|"set"|"clear", tabId?: string, cookies?: Array<{name, value, url?|domain?, path?, expires?, httpOnly?, secure?, sameSite?}>, urls?: string[], name?: string}',
    example: '{"action": "set", "cookies": [{"name": "k", "value": "v", "url": "https://example.com"}]}'
  },
  'browser.storage': {
    summary: 'Read/write page localStorage/sessionStorage: get (key omitted = all) / set / remove / clear (values are strings)',
    params: '{action: "get"|"set"|"remove"|"clear", kind: "local"|"session", tabId: string, key?: string, value?: string}',
    example: '{"action": "set", "kind": "local", "key": "token", "value": "abc"}'
  },
  'browser.console': {
    summary: 'Read the console output captured for the tab (level filter verbose/info/warning/error; contains keyword; limit count)',
    params: '{tabId: string, level?: string, contains?: string, limit?: number}',
    example: '{"level": "error"}'
  },
  'browser.network': {
    summary: 'Read the network requests captured for the tab (method/status/contains/limit filters); action=body fetches the response body by requestId (text or base64)',
    params: '{action?: "list"|"body", tabId: string, method?: string, status?: number, contains?: string, limit?: number, requestId?: string}',
    example: '{"action": "body", "requestId": "1234.5"}'
  },
  'browser.downloads': {
    summary: 'List files downloaded by the built-in browser (auto-saved; path is a local absolute path; state: progressing/completed/cancelled/interrupted)',
    params: '{limit?: number}',
    example: '{}'
  },
  'browser.screenshot': {
    summary: 'Save a screenshot locally and return its absolute path (visible in the UI; image-capable models may read the path to see the frame; prefer snapshot for regular structure locating)',
    params: '{tabId: string, selector?: string, fullPage?: boolean}',
    example: '{}'
  },
  'browser.evaluate': {
    summary: 'Evaluate a JS expression in the page main frame under protection and return the serialized result (forces userGesture:false, blocks focus/blur side effects, no host focus steal)',
    params: '{tabId: string, expression: string}',
    example: '{"expression": "document.title"}'
  }
};

/** Extra usage examples for exact-name directory queries (diagnostic utility since R5). */
export function browserToolHelp(name: string): HelpEntry | undefined {
  return BROWSER_HELP[name];
}
