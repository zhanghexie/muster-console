/* Minimal extension extension SDK. The extension surface exposes only the instance-owned
 * Agent and DomainRuntime contract, so unsupported extension host calls cannot look
 * available and fail later at runtime. */
(function () {
  'use strict';
  var seq = 0;
  var pending = new Map();
  var subscriptions = new Map();
  var context = null;
  var appearanceRevision = -1;
  var localeRevision = -1;
  var latestAppearance = null;
  var readyResolve;
  var readyReject;
  var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
  var timeout = setTimeout(function () { readyReject(new Error('宿主未响应 extension 初始化握手')); }, 8000);
  // 独立窗口（placement='window'）：panel-preload 暴露的 maHost IPC 通道取代 postMessage 桥。
  var hostBridge = typeof window.maHost === 'object' && window.maHost ? window.maHost : null;
  function receive(message) {
    if (!message || typeof message !== 'object' || message.__ma !== true) return;
    if (message.type === 'init') { clearTimeout(timeout); context = message.context || {}; applyTheme(context.theme); applyAppearance(context.appearance); if (latestAppearance) context.appearance = latestAppearance; readyResolve(context); return; }
    if (message.type === 'appearance') { applyAppearance(message); return; }
    if (message.type === 'event' && context && message.generation === context.generation) {
      var handlers = subscriptions.get(message.topic);
      if (handlers) handlers.forEach(function (handler) { try { handler(message.value); } catch (error) { console.error(error); } });
      return;
    }
    if (message.type === 'reply') {
      var waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result); else waiter.reject(new Error(message.error || '调用失败'));
    }
  }
  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    var root = document.documentElement;
    if (typeof theme.accent === 'string') root.style.setProperty('--ma-accent', theme.accent);
    if (theme.tokens && typeof theme.tokens === 'object') Object.keys(theme.tokens).forEach(function (key) {
      if (/^[a-z][a-z0-9._-]{0,63}$/.test(key) && typeof theme.tokens[key] === 'string') root.style.setProperty('--ma-' + key, theme.tokens[key]);
    });
    Object.keys(theme).forEach(function (key) {
      if (/^--[\w-]+$/.test(key) && typeof theme[key] === 'string') root.style.setProperty(key, theme[key]);
    });
  }
  function applyAppearance(appearance) {
    if (!appearance || typeof appearance !== 'object') return;
    var paletteFresh = typeof appearance.revision !== 'number' || appearance.revision >= appearanceRevision;
    var incomingLocaleRevision = typeof appearance.localeRevision === 'number' ? appearance.localeRevision : undefined;
    var localeFresh = incomingLocaleRevision === undefined || incomingLocaleRevision >= localeRevision;
    if (!paletteFresh && !localeFresh) return;
    if (paletteFresh && typeof appearance.revision === 'number') {
      appearanceRevision = appearance.revision;
      document.documentElement.dataset.appearanceRevision = String(appearanceRevision);
    }
    if (paletteFresh) {
      applyTheme(appearance.theme);
      if (appearance.colorScheme === 'light' || appearance.colorScheme === 'dark') {
        document.documentElement.style.colorScheme = appearance.colorScheme;
        document.documentElement.dataset.theme = appearance.colorScheme;
      }
      var urls = Array.isArray(appearance.fontStylesheets) ? appearance.fontStylesheets : [];
      document.querySelectorAll('link[data-ma-font]').forEach(function (link) {
        if (urls.indexOf(link.getAttribute('href')) < 0) link.remove();
      });
      urls.forEach(function (url) {
        if (typeof url !== 'string' || !/^https:\/\//.test(url)) return;
        var exists = Array.from(document.querySelectorAll('link[data-ma-font]')).some(function (link) { return link.getAttribute('href') === url; });
        if (exists) return;
        var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = url; link.setAttribute('data-ma-font', ''); document.head.appendChild(link);
      });
    }
    if (localeFresh && (appearance.locale === 'zh-CN' || appearance.locale === 'en')) {
      document.documentElement.lang = appearance.locale;
      if (incomingLocaleRevision !== undefined) localeRevision = incomingLocaleRevision;
    }
    var localePatch = localeFresh && (appearance.locale !== undefined || incomingLocaleRevision !== undefined) ? { locale: appearance.locale, localeRevision: appearance.localeRevision } : {};
    latestAppearance = Object.assign({}, latestAppearance || {}, paletteFresh ? { theme: appearance.theme, colorScheme: appearance.colorScheme, fontStylesheets: Array.isArray(appearance.fontStylesheets) ? appearance.fontStylesheets : [], revision: appearance.revision } : {}, localePatch);
    if (context) Object.assign(context, { appearance: Object.assign({}, context.appearance || {}, latestAppearance) });
  }
  function call(method, args) {
    if (hostBridge) return hostBridge.call({ id: 'extension-' + (++seq), method: method, args: args || [] });
    return new Promise(function (resolve, reject) {
      var id = 'extension-' + (++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({ __ma: true, type: 'call', id: id, method: method, args: args || [] }, '*');
    });
  }
  window.addEventListener('message', function (event) { receive(event.data); });
  window.ma = {
    ready: ready,
    tool: function (name, args) { return call('tool', [name, args || {}]); },
    ui: { confirm: function (options) { return call('ui.confirm', [options]); } },
    context: function () { return context; },
    data: {
      read: function (path, area) { return call('data.read', [path, area || 'workspace']); },
      write: function (path, text, area) { return call('data.write', [path, text, area || 'workspace']); },
      list: function (path, area) { return call('data.list', [path || '', area || 'workspace']); }
    },
    files: { pick: function () { return call('files.pick', []); } },
    media: {
      import: function (path, name, mime) { return call('media.import', [path, name, mime]); },
      url: function (assetId) { return call('media.url', [assetId]); },
      retain: function (assetId) { return call('media.retain', [assetId]); },
      release: function (assetId) { return call('media.release', [assetId]); }
    },
    tasks: {
      create: function (title, draft) { return call('tasks.create', [title, draft]); },
      open: function (sessionId) { return call('tasks.open', [sessionId]); },
      preview: function (sessionId, relativePath) { return call('tasks.preview', [sessionId, relativePath]); },
      thumbnail: function (sessionId, relativePath) { return call('tasks.thumbnail', [sessionId, relativePath]); },
      /** Deterministic browser render; host-owned WebM output and progress receipt. */
      render: function (request) { return call('tool', ['host.tasks.render', request || {}]); },
      validate: function (request) { return call('tool', ['host.tasks.render', Object.assign({}, request || {}, { action: 'validate' })]); }
    },
    exports: {
      thumbnailHtml: function (html) { return call('exports.thumbnailHtml', [html]); },
      create: function (files, title) { return call('exports.create', [{ files: files, title: title }]); },
      preview: function (exportId, name) { return call('exports.preview', [exportId, name]); },
      reveal: function (exportId) { return call('exports.reveal', [exportId]); }
    },
    models: {
      list: function () { return call('models.list', []); },
      invoke: function (input) { return call('models.invoke', [input]); }
    },
    storage: {
      get: function (key) { return call('storage.get', [key]); },
      set: function (key, value) { return call('storage.set', [key, value]); },
      del: function (key) { return call('storage.del', [key]); },
      keys: function () { return call('storage.keys', []); }
    },
    llm: {
      chat: function (messages, opts) { return call('llm.chat', [messages, opts]); },
      chatStream: function (messages, opts, onDelta) {
        return call('llm.chatStream', [messages, opts]).then(function (started) {
          var requestId = started && started.requestId;
          return new Promise(function (resolve, reject) {
            var stopDelta = window.ma.on('llm.delta', function (value) {
              if (!value || value.requestId !== requestId) return;
              if (typeof onDelta === 'function' && typeof value.delta === 'string') onDelta(value.delta);
            });
            var stopDone = window.ma.on('llm.done', function (value) {
              if (!value || value.requestId !== requestId) return;
              stopDelta(); stopDone();
              if (value.error) reject(new Error(value.error)); else resolve({ text: value.text || '' });
            });
          });
        });
      },
      cancelStream: function (requestId) { return call('llm.chatStream.cancel', [requestId]); }
    },
    commands: { execute: function (command, args) { return call('commands.execute', [command, args]); } },
    journal: {
      list: function () { return call('journal.list', []); },
      read: function (date) { return call('journal.read', [date]); }
    },
    notify: function (text) { return call('notify', [text]); },
    on: function (topic, handler) {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
      subscriptions.get(topic).add(handler);
      return function () { subscriptions.get(topic).delete(handler); };
    },
    agent: {
      open: function () { return call('agent.open', []); },
      send: function (text) { return call('agent.send', [text]); },
      history: function () { return call('agent.history', []); },
      release: function () { return call('agent.release', []); },
      domain: {
        snapshot: function (args) { return call('domain.snapshot', [args || {}]); },
        query: function (name, args) { return call('domain.query', [name, args || {}]); },
        command: function (name, args) { return call('domain.command', [name, args || {}]); }
      }
    }
  };
  if (hostBridge) {
    // 独立窗口：init/外观/事件经 preload 的 IPC 订阅；ready 握手不走 postMessage。
    hostBridge.subscribe(function (message) { receive(message); });
    hostBridge.init().then(function (initContext) {
      clearTimeout(timeout);
      if (initContext) {
        applyTheme(initContext.theme);
        applyAppearance(initContext.appearance);
        context = initContext;
      }
      readyResolve(context);
    }, function (error) { clearTimeout(timeout); readyReject(error); });
  } else {
    window.parent.postMessage({ __ma: true, type: 'ready' }, '*');
  }
})();
