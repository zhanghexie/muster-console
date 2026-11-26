/** browser 组（内置浏览器操控）（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';

export const BROWSER_TOOL_DEFS: ToolDef[] = [
  // ---------- browser（内置浏览器操控） ----------
  {
    name: 'browser.tabs',
    description:
      'List every tab of the workbench built-in browser (id/title/url/favicon/loading/canGoBack/canGoForward). Actions address tabs by tabId and need no foreground page; same-page input and page-mutating operations queue in arrival order, different pages run in parallel, and the user switching tabs does not interfere.',
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser.open',
    description:
      'Open a new page in the background and make it the calling AI\'s active tab, returning the new tabId; it does not switch the user\'s foreground tab or steal focus. Login state is globally shared and persisted; pages of multiple AIs execute independently but cookies are not isolated.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (https://...); a search phrase also works' }
      }
    }
  },
  {
    name: 'browser.close',
    description: 'Close the given browser tab.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab id returned by browser.tabs' } },
      required: ['tabId']
    }
  },
  {
    name: 'browser.activate',
    description:
      'Make the given tab the calling AI\'s active target; by default it is selected in the background (no foreground switch or focus steal) - pass foreground:true to also bring that tab to the browser foreground (for recording or human collaboration).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        foreground: { type: 'boolean', description: 'Optional: true brings that tab to the browser foreground (default false keeps it in the background)' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.navigate',
    description: 'Navigate the given tab to a new address (input is a URL or search phrase).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        input: { type: 'string', description: 'URL or search phrase' }
      },
      required: ['tabId', 'input']
    }
  },
  {
    name: 'browser.snapshot',
    description:
      'Take an accessibility-tree snapshot of the given tab (YAML text): interactive elements carry [ref=eN] refs (inside iframes or after frame rebuild they take the fNeM frame-prefixed form, e.g. f3e13); later click/fill/selectOption locate by passing that ref verbatim. For large pages pass selector to narrow the scope, interactiveOnly to keep interactive elements only, or offset/maxChars to page through (overlong output is auto-segmented instead of failing the 12KB result cap).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string', description: 'Optional: capture only the given subtree (CSS selector like "main"/"#app" or a snapshot ref)' },
        interactiveOnly: { type: 'boolean', description: 'Optional: true keeps only interactive elements with [ref=] plus key headings/landmarks' },
        offset: { type: 'number', description: 'Optional: start character offset for paging (default 0; continue with the returned nextOffset)' },
        maxChars: { type: 'number', description: 'Optional: max characters returned per call (default 9000, range 500-10000)' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.click',
    description:
      'Background DOM-semantic click by ref, CSS selector, or viewport coordinates such as "320.5,180". Coordinates hit-test the page and send synthetic pointer, mouse, and click events, including to canvas. Observe the result after clicking.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        target: { type: 'string', description: 'Snapshot ref (e.g. e12 or f3e13), CSS selector, or "x,y" in viewport CSS pixels' }
      },
      required: ['tabId', 'target']
    }
  },
  {
    name: 'browser.fill',
    description: 'Background DOM-semantic fill of text into input/textarea/contenteditable without focusing; it dispatches synthetic input events. contenteditable gets plain-text replacement; editors relying on trusted input or proprietary models need manual operation.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        target: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['tabId', 'target', 'text']
    }
  },
  {
    name: 'browser.selectOption',
    description: 'Background DOM-semantic selection of a native <select> option (value is the option\'s value or visible text); it dispatches synthetic input/change and does not open the native menu.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        target: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['tabId', 'target', 'value']
    }
  },
  {
    name: 'browser.pressKey',
    description: 'Background DOM-semantic key events (keydown/keypress/keyup; Enter inside an input also triggers form submission) without stealing host focus. Optionally pass target for the element.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        key: { type: 'string', description: 'Key name (Enter/Escape/ArrowDown/Control+a...)' },
        target: { type: 'string', description: 'Optional: target element ref or CSS selector (defaults to the page\'s active element or body)' }
      },
      required: ['tabId', 'key']
    }
  },
  {
    name: 'browser.hover',
    description: 'Background DOM-semantic hover event sequence dispatched to the target element (pointerover/pointerenter/mouseover/mouseenter/mousemove); it does not move the system mouse or steal focus (pure CSS :hover is not triggered, JS hover listeners are).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string' }, target: { type: 'string' } },
      required: ['tabId', 'target']
    }
  },
  {
    name: 'browser.movePointer',
    description: 'Move the webview pointer to "x,y" viewport CSS pixels with no buttons pressed. Updates CSS :hover and fires pointer/mouse move events without moving the system cursor or granting user activation.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        target: { type: 'string', description: '"x,y" in viewport CSS pixels, e.g. "320.5,180"' }
      },
      required: ['tabId', 'target']
    }
  },
  {
    name: 'browser.scroll',
    description: 'Scroll a container identified by ref or CSS selector. Omit target to scroll the main document. Uses DOM scrolling (default 600px).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        direction: { type: 'string', description: 'up | down (default down)' },
        amount: { type: 'number', description: 'Pixels, 50-4000, default 600' },
        target: { type: 'string', description: 'Ref or CSS selector for the scroll container' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.waitFor',
    description:
      'Conditionally wait for the page: selector appears / text visible / url matches (supports /regex/ or globs) / hiddenSelector disappears / state load state (load|domcontentloaded|networkidle); with none given, wait timeMs milliseconds. Waiting does not occupy the same-page operation queue.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string', description: 'Wait until this CSS selector is visible' },
        text: { type: 'string', description: 'Wait until this text is visible' },
        url: { type: 'string', description: 'Wait until the URL matches (glob like **/done, or /regex/)' },
        hiddenSelector: { type: 'string', description: 'Wait until this selector disappears' },
        state: { type: 'string', description: 'load | domcontentloaded | networkidle' },
        timeoutMs: { type: 'number', description: 'Conditional-wait timeout, default 10000' },
        timeMs: { type: 'number', description: 'Unconditional wait in milliseconds (when none of the above conditions is given)' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.screenshot',
    description:
      'Save a screenshot locally and return its absolute file path (the UI also shows a preview; image-capable models may read the returned path to see the frame - for regular structure locating still prefer browser.snapshot).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string', description: 'Optional: capture only the given element (ref or CSS selector)' },
        fullPage: { type: 'boolean', description: 'Optional: true captures the full long page' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.evaluate',
    description:
      'Evaluate a JS expression in the page main frame under protection and return the serialized result (forces userGesture:false and auto-blocks focus/blur side effects; no host focus steal).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        expression: { type: 'string', description: 'JS expression (e.g. location.href, document.title)' }
      },
      required: ['tabId', 'expression']
    }
  },
  {
    name: 'browser.upload',
    description: 'Assign caller-readable local files to a file input without opening a chooser; assignment does not confirm server-side upload. Check the page or server separately.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        target: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'File path array (absolute or relative to the workspace root)' },
        workspaceId: { type: 'string', description: 'Base workspace for resolving relative paths (default: the current workspace)' }
      },
      required: ['tabId', 'target', 'files']
    }
  },
  {
    name: 'browser.drag',
    description: 'Background DOM-semantic drag (element ref/CSS selector or decimal "x,y" viewport coordinates accepted; dispatches a pointer/mouse/drag event sequence and always releases in finally).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        from: { type: 'string', description: 'Start point: ref/CSS selector, or "x,y" viewport coordinates (decimals allowed)' },
        to: { type: 'string', description: 'End point: ref/CSS selector, or "x,y" viewport coordinates (decimals allowed)' },
        timeoutMs: { type: 'number' }
      },
      required: ['tabId', 'from', 'to']
    }
  },
  {
    name: 'browser.setViewport',
    description:
      'Set the page viewport size of the given tab (responsive-layout checks): width/height clamp to 320-3840x320-2160, invalid values error; it changes only that tab\'s page content area, not the window, and survives tab rebuilds. reset=true restores the native viewport.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id returned by browser.tabs' },
        reset: { type: 'boolean', description: 'true restores the native viewport; not combinable with width/height' },
        width: { type: 'number', description: 'Viewport width (320-3840, out-of-range clamped)' },
        height: { type: 'number', description: 'Viewport height (320-2160, out-of-range clamped)' }
      },
      required: ['tabId'],
      oneOf: [{ required: ['width','height'], properties: { reset: { const: false } } }, { required: ['reset'], properties: { reset: { const: true } }, not: { anyOf: [{ required: ['width'] }, { required: ['height'] }] } }]
    }
  },
  {
    name: 'browser.recording',
    description:
      'Record the visible native page as a WebM video: start begins (needs a ready tabId) / stop stops and muxes (the .webm output is visible to the user) / status queries / cancel discards; hidden pages return capability_unsupported instead of auto-showing or focusing. Duration cap 120s.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'cancel'], description: 'start | stop | status | cancel' },
        tabId: { type: 'string', description: 'start: tab id returned by browser.tabs' },
        recordingId: { type: 'string', description: 'stop/status/cancel: recording id returned by start' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser.dialog',
    description: 'Handle JS dialogs (alert/confirm/prompt): list shows the queue / accept / dismiss (prompt takes promptText) / policy sets the auto policy. snapshot flags pending dialogs.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ["list","accept","dismiss","policy"], description: 'list | accept | dismiss | policy' },
        tabId: { type: 'string' },
        dialogId: { type: 'string', description: 'Dialog id from list; accept/dismiss default to the earliest one' },
        promptText: { type: 'string', description: 'Text filled in when accepting a prompt' },
        policy: { type: 'string', enum: ["manual","auto-accept","auto-dismiss"], description: 'policy action: manual | auto-accept | auto-dismiss' }
      },
      required: ['action', 'tabId']
    }
  },
  {
    name: 'browser.cookies',
    description: 'Read/write globally shared, persisted cookies: get / set / clear. tabId defaults to the tab this AI last selected via open/activate; pass tabId explicitly when nothing was selected; it never follows the user\'s foreground. Cookies are shared across all AIs.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ["get","set","clear"], description: 'get | set | clear (default get)' },
        tabId: { type: 'string' },
        cookies: {
          type: 'array',
          description: 'For set: each cookie needs at least name+value plus url or domain (with domain, path defaults to /; when both url and domain are given, url wins)',
          items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' }, url: { type: 'string' }, domain: { type: 'string' } } }
        },
        urls: { type: 'array', items: { type: 'string' }, description: 'get filters by these URLs' },
        name: { type: 'string', description: 'get filters by cookie name' }
      }
    }
  },
  {
    name: 'browser.storage',
    description: 'Read/write page localStorage/sessionStorage (string values): get (key omitted = all) / set / remove / clear.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ["get","set","remove","clear"], description: 'get | set | remove | clear (default get)' },
        kind: { type: 'string', enum: ["local","session"], description: 'local | session (default local)' },
        tabId: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.console',
    description: 'Read the console output captured for this tab (errors included), filtered by level/contains/limit. Use it to debug page scripts.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        level: { type: 'string', enum: ["verbose","info","warning","error"], description: 'verbose | info | warning | error' },
        contains: { type: 'string', description: 'Text-contains filter' },
        limit: { type: 'number', description: 'Return the latest N entries, default 50' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.network',
    description: 'Read the network requests captured for this tab (method/status/contains filters); action=body fetches a response body by requestId. Use it to debug APIs or inspect page requests.',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ["list","body"], description: 'list (default) | body' },
        tabId: { type: 'string' },
        method: { type: 'string' },
        status: { type: 'number' },
        contains: { type: 'string' },
        limit: { type: 'number' },
        requestId: { type: 'string', description: 'body action: requestId from list' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser.downloads',
    description: 'List files downloaded by the built-in browser (auto-saved under userData/browser-downloads; path is a local absolute path).',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number' } }
    }
  },
];
