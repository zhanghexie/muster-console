/* Composable HTML components. Native controls own their semantics and keyboard behavior. */
(function () {
  'use strict';
  var api = window.maUi, sequence = 0;
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function getBound(node, key, fallback) {
    if (key && key.indexOf('row.') === 0) {
      var owner = node.closest('[data-ma-row]'), value = owner && owner.__maRow;
      key.slice(4).split('.').forEach(function (part) { value = value && Object.prototype.hasOwnProperty.call(value, part) ? value[part] : undefined; });
      return value === undefined ? fallback : value;
    }
    return api.get(key, fallback);
  }
  function template(node, text) {
    return String(text || '').replace(/\{([^{}]+)\}/g, function (_, key) {
      var value = getBound(node, key, '');
      return value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
  }
  function toneFor(node) {
    var source = node.getAttribute('tone-expr'), value;
    try {
      if (source != null) {
        if (source !== node._toneSource) { node._toneExpression = api.expression.compile(source); node._toneSource = source; }
        value = node._toneExpression.evaluate(function (key) { return getBound(node, key); });
      } else value = node.hasAttribute('tone-bind') ? getBound(node, node.getAttribute('tone-bind')) : node.getAttribute('tone') || 'neutral';
      if (!['success', 'danger', 'warning', 'info', 'neutral'].includes(value)) throw api.ownedError('tone 须为 success/danger/warning/info/neutral');
      return value;
    } catch (error) { error.attribute = source != null ? 'tone-expr' : node.hasAttribute('tone-bind') ? 'tone-bind' : 'tone'; throw error; }
  }
  function observe(component) {
    if (component._off) component._off();
    component._off = api.subscribe(function () { if (component.isConnected) component.refreshSafely(); });
    api.whenReady().then(function () { if (component.isConnected) component.refreshSafely(); });
  }
  function data(component) {
    if (component._dataOverride) return component._data;
    var source = component.getAttribute('source');
    if (source !== null) return api.source(source);
    var script = component._inlineSource || component.querySelector('script[type="application/json"]');
    if (!script) return {};
    component._inlineSource = script; // build() replaces children; keep inline JSON available for refresh.
    return api.readSource(script);
  }
  class Component extends HTMLElement {
    connectedCallback() {
      if (document.readyState === 'loading') {
        if (!this._waiting) {
          this._waiting = true;
          document.addEventListener('DOMContentLoaded', function () { this._waiting = false; if (this.isConnected) this.connectedCallback(); }.bind(this), { once: true });
        }
        return;
      }
      try {
        if (!this._built) { this._id = this.id || this._id || 'ma-component-' + (++sequence); this.build(); this._built = true; }
        observe(this); this.refreshSafely();
      } catch (error) { this.showDiagnostic(error); }
    }
    disconnectedCallback() { if (this._off) this._off(); this._off = null; api.diagnostic(this._id, null); }
    build() {}
    refresh() {}
    refreshSafely() {
      try { this.refresh(); if (!this._compileError && !this.hasAttribute('aria-invalid')) this.clearDiagnostic(); }
      catch (error) { this.showDiagnostic(error); }
    }
    showDiagnostic(error, attribute) {
      if (!this.isConnected) return;
      var detail = Object.assign({ code: 'component_value' }, error.diagnostic || {}, { component: this.tagName.toLowerCase(), id: this.id || this._id, name: this.getAttribute('name') || '', attribute: attribute || error.attribute || (this.hasAttribute('expr') ? 'expr' : '') });
      var selector = detail.component + '#' + detail.id;
      if (!detail.expression && /expr$/.test(detail.attribute)) detail.expression = this.getAttribute(detail.attribute);
      detail.message = selector + (detail.attribute ? '[' + detail.attribute + ']' : '') + '：' + error.message + (detail.position ? '（第 ' + detail.position + ' 字符）' : '') + (detail.expression ? '\n' + detail.expression : '') + (detail.hint ? '\n建议：' + detail.hint : '');
      if (!this._diagnosticNode) { this._diagnosticNode = element('span', 'ma-field-error'); this._diagnosticNode.setAttribute('role', 'alert'); this.append(this._diagnosticNode); }
      api.bindText(this._diagnosticNode, '{diagnostic}', function () {
        if (api.locale() !== 'en') return { diagnostic: detail.message };
        return { diagnostic: selector + (detail.attribute ? '[' + detail.attribute + ']' : '') + ': ' + api.displayError(error) +
          (detail.position ? ' (character ' + detail.position + ')' : '') + (detail.expression ? '\n' + detail.expression : '') +
          (detail.hint ? '\nHint: ' + (error.maUiOwned ? api.displayHint(detail.hint) : detail.hint) : '') };
      });
      this._diagnosticNode.hidden = false;
      this.setAttribute('aria-invalid', 'true'); api.diagnostic(this._id, detail); api.report();
    }
    clearDiagnostic() { if (this._diagnosticNode) this._diagnosticNode.hidden = true; api.diagnostic(this._id, null); }
    set data(next) { this._data = next; this._dataOverride = true; if (this._built) this.refreshSafely(); }
    get data() { return data(this); }
  }
  ['stack', 'row', 'grid', 'card'].forEach(function (name) {
    customElements.define('ma-' + name, class extends Component {
      build() {
        this.classList.add('ma-' + name);
        if (name === 'grid') {
          var columns = Number(this.getAttribute('columns') || 2);
          this.style.setProperty('--ma-columns', String(Math.max(1, Math.min(4, columns))));
        }
        var heading = this.getAttribute('label');
        if (heading) this.prepend(element('h3', 'ma-section-title', heading));
      }
    });
  });
  customElements.define('ma-text', class extends Component {
    build() {
      this._initial = this.getAttribute('value') ?? this.getAttribute('text') ?? this.textContent;
      this._value = element(this.hasAttribute('expr') ? 'output' : 'span', 'ma-text-value');
      this._error = element('span', 'ma-field-error'); this._error.setAttribute('role', 'alert'); this._error.hidden = true;
      this._trend = element('span', 'ma-text-trend'); this._trend.hidden = !this.hasAttribute('trend'); this._trend.dataset.tone = this.getAttribute('tone') || 'neutral';
      var label = this.getAttribute('label');
      this.replaceChildren(...(label ? [element('span', 'ma-text-label', label)] : []), this._value, this._trend, this._error);
      if (this.hasAttribute('expr')) {
        try { this._calculation = { owner: this, compiled: api.expression.compile(this.getAttribute('expr')), read: function (key) { return getBound(this, key); }.bind(this), private: this.hasAttribute('private') }; }
        catch (error) { this._compileError = error; }
        this._name = this.getAttribute('name');
        if (this._name && this._calculation) {
          if (api.expression.definitions.has(this._name)) throw api.ownedError('计算结果名称重复 ' + this._name);
          api.expression.definitions.set(this._name, this._calculation);
        }
      }
    }
    refresh() {
      if (this._publishing) return;
      var bind = this.getAttribute('bind');
      try {
        if (this._compileError) throw this._compileError;
        var value = this._calculation ? api.expression.calculate(this._calculation, this._calculation.read) : bind ? getBound(this, bind, this.getAttribute('fallback') ?? this._initial) : this._initial;
        this._value.textContent = api.format(value, { format: this.getAttribute('format'), digits: this.getAttribute('digits'), currency: this.getAttribute('currency'), unit: this.getAttribute('unit') });
        this._error.hidden = true; this._error.textContent = ''; this.removeAttribute('aria-invalid');
        this._trend.textContent = template(this, this.getAttribute('trend') || '');
        this._trend.dataset.tone = toneFor(this);
        this.clearDiagnostic();
        if (this._name) {
          var privateValue = api.expression.isPrivate(this._calculation);
          if (!Object.is(api.get(this._name), value) || api.isPrivate(this._name) !== privateValue) {
            this._publishing = true;
            api.set(this._name, value, { private: privateValue }).catch(function (error) { this.displayError(error); }.bind(this));
            this._publishing = false;
          }
        }
      } catch (error) {
        this.displayError(error);
        if (this._name && api.get(this._name) != null) {
          this._publishing = true; api.set(this._name, null, { private: true }).catch(api.warn); this._publishing = false;
        }
      }
    }
    displayError(error) { this._value.textContent = ''; this._diagnosticNode = this._error; this.showDiagnostic(error); }
    disconnectedCallback() { super.disconnectedCallback(); if (this._name && api.expression.definitions.get(this._name) === this._calculation) api.expression.definitions.delete(this._name); }
    connectedCallback() { if (this._built && this._name && this._calculation) api.expression.definitions.set(this._name, this._calculation); super.connectedCallback(); }
  });
  customElements.define('ma-badge', class extends Component {
    build() { this.classList.add('ma-badge'); this._initial = this.getAttribute('text') ?? this.textContent; }
    refresh() {
      var bind = this.getAttribute('bind');
      var value = bind ? getBound(this, bind, this.getAttribute('fallback') ?? this._initial) : this._initial;
      this.textContent = value == null ? '' : String(value);
      this.dataset.tone = toneFor(this); this.removeAttribute('aria-invalid');
    }
  });
  function defineInput(tag, fallbackType) {
    customElements.define(tag, class extends Component {
      build() {
        this._name = this.getAttribute('name') || this._id;
        this._type = this.getAttribute('type') || fallbackType;
        this._private = this.hasAttribute('private') || this._type === 'password';
        this._segmented = this._type === 'select' && this.getAttribute('appearance') === 'segmented';
        this._input = element(this._type === 'textarea' ? 'textarea' : this._type === 'select' ? 'select' : 'input', 'ma-form-control');
        if (this._input.tagName === 'INPUT') this._input.type = this._type;
        this._input.id = this._id + '-input';
        if (this._type === 'select') this.querySelectorAll('option').forEach(function (option) { this._input.append(option.cloneNode(true)); }, this);
        ['min', 'max', 'step', 'placeholder', 'rows', 'required', 'disabled', 'autocomplete'].forEach(function (key) {
          if (this.hasAttribute(key)) this._input.setAttribute(key, this.getAttribute(key));
        }, this);
        var value = this.getAttribute('value');
        if (this._type === 'checkbox') value = this.hasAttribute('checked') || value === 'true';
        else if (this._type === 'number' || this._type === 'range') value = value == null ? Number(this.getAttribute('min') || 0) : Number(value);
        else if (value == null) value = this._type === 'select' ? this._input.value : '';
        this._default = value;
        api.ensure(this._name, value, { private: this._private });
        var label = element('label', 'ma-field-label', this.getAttribute('label') || this._name);
        label.htmlFor = this._input.id;
        label.id = this._id + '-label';
        this._valueLabel = element('output', 'ma-field-value');
        this._valueLabel.htmlFor = this._input.id;
        var header = element('div', 'ma-field-header'); header.append(label);
        if (this._type === 'range') header.append(this._valueLabel);
        this.replaceChildren(header, this._input);
        if (this._segmented) {
          this._input.hidden = true;
          this._group = element('div', 'ma-segmented'); this._group.setAttribute('role', 'radiogroup'); this._group.setAttribute('aria-labelledby', label.id);
          this._segments = Array.from(this._input.options).map(function (option, index) {
            var button = element('button', 'ma-segment', option.label); button.type = 'button'; button.id = this._id + '-option-' + index;
            button.setAttribute('role', 'radio'); button.disabled = this._input.disabled || option.disabled; button.dataset.value = option.value;
            button.addEventListener('click', function () { this._input.value = option.value; this._input.dispatchEvent(new Event('change', { bubbles: true })); }.bind(this));
            this._group.append(button); return button;
          }, this);
          this._group.addEventListener('keydown', function (event) {
            var enabled = this._segments.filter(function (button) { return !button.disabled; }), index = enabled.indexOf(document.activeElement);
            if (index < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            var next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
            enabled[next].focus(); enabled[next].click();
          }.bind(this));
          this.append(this._group);
        }
        this._input.addEventListener(this._type === 'select' || this._type === 'checkbox' ? 'change' : 'input', function () {
          var next = this._type === 'checkbox' ? this._input.checked : this._input.value;
          if ((this._type === 'number' || this._type === 'range') && next !== '') next = Number(next);
          if (typeof next === 'number' && !Number.isFinite(next)) return;
          api.set(this._name, next, { private: this._private }).catch(function (error) { this.showError(error); }.bind(this));
          this.dispatchEvent(new CustomEvent('ma-change', { detail: { name: this._name, value: next }, bubbles: true }));
        }.bind(this));
      }
      showError(error) {
        if (!this._error) { this._error = element('span', 'ma-field-error'); this._error.setAttribute('role', 'status'); this.append(this._error); }
        api.bindText(this._error, '{error}', function () { return { error: api.displayError(error) }; });
      }
      refresh() {
        var value = api.get(this._name, this._default);
        if (this._type === 'checkbox') this._input.checked = !!value;
        else if (String(this._input.value) !== String(value)) this._input.value = value == null ? '' : value;
        this._valueLabel.textContent = String(value) + (this.getAttribute('unit') ? ' ' + this.getAttribute('unit') : '');
        if (this._segments) {
          var selected = this._segments.find(function (button) { return button.dataset.value === String(value) && !button.disabled; }) || this._segments.find(function (button) { return !button.disabled; });
          this._segments.forEach(function (button) { button.setAttribute('aria-checked', String(button.dataset.value === String(value))); button.tabIndex = button === selected ? 0 : -1; });
        }
      }
    });
  }
  defineInput('ma-input', 'text'); defineInput('ma-select', 'select');
  defineInput('ma-checkbox', 'checkbox'); defineInput('ma-slider', 'range');
  customElements.define('ma-button', class extends Component {
    build() {
      var authored = this.getAttribute('label') || this.textContent.trim(), initial = authored || '继续';
      this._button = element('button', 'ma-btn', initial); this._button.type = 'button';
      if (!authored) api.bindText(this._button, '继续');
      if (this.hasAttribute('primary')) this._button.classList.add('ma-btn--accent');
      if (this.hasAttribute('disabled')) this._button.disabled = true;
      this._status = element('span', 'ma-action-status'); this._status.setAttribute('role', 'status');
      this.replaceChildren(this._button, this._status);
      this._button.addEventListener('click', async function () {
        api.unbindText(this._status); this._status.textContent = ''; this._button.disabled = true; this._button.setAttribute('aria-busy', 'true');
        try {
          var kind = this.getAttribute('action') || 'followup';
          var text = template(this, this.getAttribute('prompt') || this.getAttribute('text') || initial);
          var result = await api.action({ type: kind, text: text,
            url: template(this, this.getAttribute('url') || ''),
            mode: this.getAttribute('mode') || 'draft', title: this.getAttribute('confirm-title') || text });
          if (result && result.ok === false) throw result.error ? new Error(result.error) : api.ownedError('操作失败');
          if (result && result.message) this._status.textContent = result.message;
          else api.bindText(this._status, result && result.cancelled ? '已取消' : kind === 'copy' ? '已复制' : kind === 'openUrl' ? '已打开' : this.getAttribute('mode') === 'send' ? '已提交' : '已加入输入框');
        } catch (error) { api.bindText(this._status, '{error}', function () { return { error: api.displayError(error) }; }); }
        finally { this._button.disabled = this.hasAttribute('disabled'); this._button.removeAttribute('aria-busy'); }
      }.bind(this));
    }
    refresh() {
      var visible = this.getAttribute('visible');
      if (visible) this.hidden = !getBound(this, visible, false);
    }
  });
  customElements.define('ma-tabs', class extends Component {
    build() {
      this._name = this.getAttribute('name') || this._id;
      this._panels = Array.from(this.children).filter(function (child) { return child.tagName !== 'SCRIPT'; });
      this._nav = element('div', 'ma-tabs-nav'); this._nav.setAttribute('role', 'tablist');
      if (this.getAttribute('label')) this._nav.setAttribute('aria-label', this.getAttribute('label'));
      else api.bindAttr(this._nav, 'aria-label', '内容');
      this._buttons = this._panels.map(function (panel, index) {
        panel.id = panel.id || this._id + '-panel-' + index;
        panel.setAttribute('role', 'tabpanel');
        var button = element('button', 'ma-tab', panel.getAttribute('label') || panel.getAttribute('data-label') || String(index + 1));
        button.type = 'button'; button.id = panel.id + '-tab'; button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', button.id);
        button.addEventListener('click', function () { api.setUi('tabs:' + this._name, index).catch(api.fail); }.bind(this));
        button.addEventListener('keydown', function (event) {
          var next = event.key === 'ArrowRight' ? (index + 1) % this._panels.length : event.key === 'ArrowLeft' ? (index + this._panels.length - 1) % this._panels.length : event.key === 'Home' ? 0 : event.key === 'End' ? this._panels.length - 1 : null;
          if (next != null) { event.preventDefault(); this._buttons[next].focus(); api.setUi('tabs:' + this._name, next).catch(api.fail); }
        }.bind(this));
        this._nav.append(button); return button;
      }, this);
      this.prepend(this._nav);
    }
    refresh() {
      var selected = Number(api.getUi('tabs:' + this._name, 0));
      if (selected < 0 || selected >= this._panels.length) selected = 0;
      this._panels.forEach(function (panel, index) {
        panel.hidden = index !== selected;
        this._buttons[index].setAttribute('aria-selected', String(index === selected));
        this._buttons[index].tabIndex = index === selected ? 0 : -1;
      }, this);
      api.report();
    }
  });
  customElements.define('ma-details', class extends Component {
    build() {
      this._name = this.getAttribute('name') || this._id;
      this._details = element('details', 'ma-details');
      var summary = element('summary', '', this.getAttribute('label') || '');
      if (!this.getAttribute('label')) api.bindText(summary, '更多');
      var body = element('div', 'ma-details-body');
      while (this.firstChild) body.append(this.firstChild);
      this._details.append(summary, body); this.append(this._details);
      this._details.addEventListener('toggle', function () {
        if (this._details.open !== api.getUi('details:' + this._name, this.hasAttribute('open'))) api.setUi('details:' + this._name, this._details.open).catch(api.fail);
        api.report();
      }.bind(this));
    }
    refresh() { this._details.open = !!api.getUi('details:' + this._name, this.hasAttribute('open')); }
  });
  function bind(root) {
    root.querySelectorAll('[data-ma-bind]').forEach(function (node) {
      if (!node.dataset.maBound && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')) {
        if (node.type !== 'radio' || node.checked) api.ensure(node.getAttribute('data-ma-bind'), node.type === 'checkbox' ? node.checked : (node.type === 'number' || node.type === 'range') && node.value !== '' ? Number(node.value) : node.value, { private: node.hasAttribute('data-ma-private') || node.type === 'password' });
      }
      var value = getBound(node, node.getAttribute('data-ma-bind'), '');
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') {
        if (node.type === 'checkbox') node.checked = !!value;
        else if (node.type === 'radio') node.checked = String(value) === node.value;
        else if (String(node.value) !== String(value)) node.value = value == null ? '' : value;
        if (!node.dataset.maBound) {
          node.dataset.maBound = 'true';
          node.addEventListener('input', function () {
            if (node.type === 'radio' && !node.checked) return;
            var next = node.type === 'checkbox' ? node.checked : node.value;
            if (node.type === 'number' || node.type === 'range') next = next === '' ? '' : Number(next);
            api.set(node.getAttribute('data-ma-bind'), next, { private: node.hasAttribute('data-ma-private') || node.type === 'password' }).catch(api.fail);
          });
        }
      } else if (node.tagName === 'PROGRESS') node.value = Number(value) || 0;
      else node.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
    root.querySelectorAll('[data-ma-visible]').forEach(function (node) { node.hidden = !getBound(node, node.getAttribute('data-ma-visible'), false); });
  }
  api.components = { Component: Component, element: element, bound: getBound, template: template, data: data, format: api.format };
  api.bind = function (root) { var target = root || document; bind(target); return api.subscribe(function () { bind(target); }); };
  // Parsed custom elements establish defaults during DOMContentLoaded. Bind after those listeners.
  function start() { queueMicrotask(function () { api.bind(document); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
