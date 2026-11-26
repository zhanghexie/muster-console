/* Render author-declared Mermaid hosts with the same Pele engine as chat Markdown. */
(function () {
  'use strict';
  var sourceCache = new WeakMap(), sequence = 0;
  var selector = 'pre.mermaid, div.mermaid, ma-mermaid';

  function message(error) {
    return String(error && error.message != null ? error.message : error || 'Mermaid 图表无法渲染').slice(0, 500);
  }

  function fallback(host, source, error, key) {
    host.classList.add('ma-mermaid-fallback');
    host.classList.remove('ma-mermaid-rendered');
    host.setAttribute('data-ma-mermaid-state', 'error');
    host.replaceChildren();
    var code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = source;
    host.append(code);
    if (error) host.title = message(error);
    if (window.maUi && window.maUi.diagnostic) {
      window.maUi.diagnostic(key, {
        id: key, component: 'mermaid', code: 'mermaid_parse',
        message: 'Mermaid 图表无法渲染：' + message(error), hint: '检查 Mermaid 图表语法'
      });
    }
  }

  function renderHost(host) {
    var source = sourceCache.get(host);
    if (source === undefined) {
      source = host.textContent || '';
      sourceCache.set(host, source);
    }
    var key = host.getAttribute('data-ma-mermaid-id');
    if (!key) { key = 'mermaid-' + (++sequence); host.setAttribute('data-ma-mermaid-id', key); }
    host.classList.add('ma-mermaid');
    if (!source.trim()) {
      host.classList.add('ma-mermaid-fallback');
      host.setAttribute('data-ma-mermaid-state', 'empty');
      return;
    }
    try {
      if (!window.pele || typeof window.pele.render !== 'function') throw new Error('Pele 渲染引擎未加载');
      var fontFamily = getComputedStyle(host).getPropertyValue('--font-sans').trim();
      var result = window.pele.render(source, fontFamily ? { fontFamily: fontFamily } : {});
      host.innerHTML = result.svg;
      host.classList.remove('ma-mermaid-fallback');
      host.classList.add('ma-mermaid-rendered');
      host.removeAttribute('title');
      host.setAttribute('data-ma-mermaid-state', 'rendered');
      if (window.maUi && window.maUi.diagnostic) window.maUi.diagnostic(key, null);
    } catch (error) {
      fallback(host, source, error, key);
    }
  }

  function renderAll() {
    document.querySelectorAll(selector).forEach(renderHost);
    if (window.maUi && window.maUi.report) window.maUi.report();
  }

  function ready() {
    renderAll();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderAll, function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
  window.addEventListener('ma-ui:appearance', renderAll);
})();
