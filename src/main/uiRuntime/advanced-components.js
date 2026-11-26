/* Native, accessible compound controls. All content remains in the artifact sandbox. */
(function () {
  'use strict';
  var api = window.maUi, helper = api.components, Component = helper.Component, el = helper.element;
  function field(owner, suffix, text, type) {
    var wrap = el('div', 'ma-compound-field'), label = el('label', 'ma-field-label', text), input = el('input', 'ma-form-control');
    input.type = type; input.id = owner._id + '-' + suffix; label.htmlFor = input.id;
    wrap.append(label, input); return { wrap: wrap, input: input, label: label };
  }
  function dateValid(value) { return !value || /^\d{4}-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
  customElements.define('ma-date-range', class extends Component {
    build() {
      this._name = this.getAttribute('name') || this._id; this._private = this.hasAttribute('private');
      this._start = field(this, 'start', '', 'date'); this._end = field(this, 'end', '', 'date');
      var currentLabel = function () { return { label: this.getAttribute('label') || api.text('日期范围') }; }.bind(this);
      api.bindText(this._start.label, '{label} · 开始日期', currentLabel); api.bindText(this._end.label, '{label} · 结束日期', currentLabel);
      [this._start, this._end].forEach(function (field) { ['min', 'max', 'disabled', 'required'].forEach(function (attr) { if (this.hasAttribute(attr)) field.input.setAttribute(attr, this.getAttribute(attr)); }, this); }, this);
      var row = el('div', 'ma-compound-row'); row.append(this._start.wrap, this._end.wrap); this.replaceChildren(row);
      api.ensure(this._name, { start: this.getAttribute('start') || '', end: this.getAttribute('end') || '' }, { private: this._private });
      const change = function () {
        var value = { start: this._start.input.value, end: this._end.input.value };
        try {
          this.validate(value); this._draft = null; this.removeAttribute('aria-invalid'); this.clearDiagnostic();
          api.set(this._name, value, { private: this._private }).catch(this.showDiagnostic.bind(this));
        } catch (error) { this._draft = value; this.showDiagnostic(error); }
      }.bind(this);
      this._start.input.addEventListener('input', change); this._end.input.addEventListener('input', change);
    }
    validate(value) {
      if (!value || typeof value.start !== 'string' || typeof value.end !== 'string' || !dateValid(value.start) || !dateValid(value.end)) throw api.ownedError('日期须为有效的 YYYY-MM-DD');
      if (value.start && value.end && value.start > value.end) throw api.ownedError('开始日期不能晚于结束日期');
      for (var key of ['start', 'end']) if (value[key] && (this.getAttribute('min') && value[key] < this.getAttribute('min') || this.getAttribute('max') && value[key] > this.getAttribute('max'))) throw api.ownedError('日期超出 min/max 范围');
    }
    refresh() {
      var value = this._draft || api.get(this._name, { start: '', end: '' });
      this._start.input.value = value.start || ''; this._end.input.value = value.end || '';
      this.validate(value); this.removeAttribute('aria-invalid');
    }
  });

  function nodesFor(component) {
    var source = helper.data(component), nodes = Array.isArray(source) ? source : source.nodes;
    var ids = new Set(), count = 0;
    function visit(nodes, depth) {
      if (!Array.isArray(nodes) || depth > 16) throw api.ownedError('层级数据须为数组，最多 16 层');
      nodes.forEach(function (node) {
        if (++count > 10000 || !node || typeof node.value !== 'string' || !node.value || ids.has(node.value)) throw api.ownedError('层级节点需要唯一非空字符串 value，最多 10000 项');
        ids.add(node.value); if (node.children !== undefined) visit(node.children, depth + 1);
      });
    }
    visit(nodes, 0); return nodes;
  }
  customElements.define('ma-cascade', class extends Component {
    build() {
      this._name = this.getAttribute('name') || this._id; this._private = this.hasAttribute('private');
      this._fields = el('div', 'ma-compound-row'); this.replaceChildren(this._fields);
      api.ensure(this._name, [], { private: this._private });
    }
    refresh() {
      var nodes = nodesFor(this), chosen = api.get(this._name, []), levels = [], labels = this.hasAttribute('labels') ? JSON.parse(this.getAttribute('labels')) : [];
      if (!Array.isArray(chosen)) throw api.ownedError('级联选择状态须为 value 数组');
      while (nodes && nodes.length) {
        var current = chosen[levels.length], match = nodes.find(function (node) { return node.value === current && !node.disabled; });
        levels.push({ nodes: nodes, value: match ? current : '' }); nodes = match?.children;
      }
      var valid = levels.map(function (level) { return level.value; }).filter(Boolean);
      if (JSON.stringify(valid) !== JSON.stringify(chosen)) { api.set(this._name, valid, { private: this._private }).catch(api.warn); return; }
      var key = JSON.stringify([levels, labels]); if (key === this._renderKey) return; this._renderKey = key;
      var focus = this.contains(document.activeElement) ? document.activeElement.id : null;
      this._fields.replaceChildren(...levels.map(function (level, index) {
        var wrap = el('div', 'ma-compound-field'), label = el('label', 'ma-field-label');
        api.bindText(label, labels[index] ? '{label} · {level}' : '{label} · 第 {n} 级', function () { return { label: this.getAttribute('label') || api.text('级联选择'), level: labels[index], n: index + 1 }; }.bind(this));
        var select = el('select', 'ma-form-control'); select.id = this._id + '-level-' + index; label.htmlFor = select.id; select.disabled = this.hasAttribute('disabled');
        var empty = el('option'); api.bindText(empty, '请选择'); empty.value = ''; select.append(empty);
        level.nodes.forEach(function (node) { var option = el('option', '', node.label || node.value); option.value = node.value; option.disabled = !!node.disabled; select.append(option); }); select.value = level.value;
        select.addEventListener('change', function () { var next = chosen.slice(0, index); if (select.value) next.push(select.value); api.set(this._name, next, { private: this._private }).catch(api.warn); }.bind(this));
        wrap.append(label, select); return wrap;
      }, this));
      if (focus) document.getElementById(focus)?.focus({ preventScroll: true }); this.removeAttribute('aria-invalid'); api.report();
    }
  });

  customElements.define('ma-tree', class extends Component {
    build() {
      this._name = this.getAttribute('name') || this._id; this._private = this.hasAttribute('private'); this._multiple = this.hasAttribute('multiple');
      var heading = el('legend', 'ma-field-label', this.getAttribute('label') || ''); if (!this.getAttribute('label')) api.bindText(heading, '树形选择'); this._group = el('fieldset', 'ma-tree'); this._list = el('ul'); this._group.append(heading, this._list); this.replaceChildren(this._group);
      api.ensure(this._name, this._multiple ? [] : null, { private: this._private });
    }
    refresh() {
      var nodes = nodesFor(this), key = JSON.stringify(nodes), selected = api.get(this._name, this._multiple ? [] : null);
      if (this._multiple && !Array.isArray(selected)) throw api.ownedError('树形多选状态须为 value 数组');
      if (key !== this._renderKey) {
        this._renderKey = key; this._records = [];
        var opened = new Set(api.getUi('tree:' + this._id, []));
        const render = function (nodes, target) { nodes.forEach(function (node) {
          var item = el('li'), row = el('div', 'ma-tree-row'), input = el('input'), label = el('label', '', node.label || node.value);
          input.type = this._multiple ? 'checkbox' : 'radio'; input.name = this._id; input.value = node.value; input.id = this._id + '-node-' + this._records.length; input.disabled = !!node.disabled || this.hasAttribute('disabled'); label.htmlFor = input.id;
          row.append(input, label); item.append(row); target.append(item);
          var record = { node: node, input: input, details: null }; this._records.push(record);
          input.addEventListener('change', function () {
            var next = node.value;
            if (this._multiple) { var ids = new Set(api.get(this._name, [])); if (input.checked) ids.add(node.value); else ids.delete(node.value); next = Array.from(ids); }
            api.set(this._name, next, { private: this._private }).catch(api.warn);
          }.bind(this));
          if (node.children?.length) {
            var details = el('details'), summary = el('summary'), children = el('ul'); api.bindText(summary, '展开 {name}', { name: node.label || node.value });
            details.open = opened.has(node.value); details.append(summary, children); item.append(details); record.details = details;
            details.addEventListener('toggle', function () { if (!this.isConnected) return; var next = new Set(api.getUi('tree:' + this._id, [])); if (details.open) next.add(node.value); else next.delete(node.value); api.setUi('tree:' + this._id, Array.from(next)).catch(api.warn); api.report(); }.bind(this)); render(node.children, children);
          }
          input.addEventListener('keydown', function (event) {
            var visible = this._records.filter(function (record) { if (record.input.disabled) return false; for (var parent = record.input.closest('details'); parent; parent = parent.parentElement.closest('details')) if (!parent.open) return false; return true; });
            var index = visible.findIndex(function (entry) { return entry.input === input; }), destination;
            if (event.key === 'ArrowDown') destination = visible[Math.min(visible.length - 1, index + 1)];
            else if (event.key === 'ArrowUp') destination = visible[Math.max(0, index - 1)];
            else if (event.key === 'Home') destination = visible[0]; else if (event.key === 'End') destination = visible.at(-1);
            else if (event.key === 'ArrowRight' && record.details) record.details.open = true;
            else if (event.key === 'ArrowLeft') { var details = record.details?.open ? record.details : input.closest('details'); if (details) details.open = false; }
            else return;
            event.preventDefault(); destination?.input.focus();
          }.bind(this));
        }, this); }.bind(this);
        this._list.replaceChildren(); render(nodes, this._list);
      }
      this._records.forEach(function (record) { record.input.checked = this._multiple ? selected.includes(record.node.value) : selected === record.node.value; }, this);
      var valid = new Set(this._records.filter(function (record) { return !record.node.disabled; }).map(function (record) { return record.node.value; }));
      var next = this._multiple ? selected.filter(function (value) { return valid.has(value); }) : selected == null || valid.has(selected) ? selected : null;
      if (JSON.stringify(next) !== JSON.stringify(selected)) api.set(this._name, next, { private: this._private }).catch(api.warn);
      this.removeAttribute('aria-invalid');
    }
  });

  function readText(file) { return new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onerror = function () { reject(api.ownedError('无法读取文件 ' + file.name)); }; reader.onload = function () { try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(reader.result)); } catch (_) { reject(api.ownedError(file.name + ' 不是有效 UTF-8 文本')); } }; reader.readAsArrayBuffer(file); }); }
  customElements.define('ma-file', class extends Component {
    build() {
      this._name = this.getAttribute('name') || this._id; this._readVersion = 0;
      this._field = field(this, 'files', this.getAttribute('label') || '', 'file'); this._field.input.accept = this.getAttribute('accept') || '.txt,.md,.csv,.json,.log'; this._field.input.multiple = this.hasAttribute('multiple');
      if (!this.getAttribute('label')) api.bindText(this._field.label, '导入文件');
      this._field.input.disabled = this.hasAttribute('disabled');
      this._field.input.hidden = true; this._choose = el('button', 'ma-btn'); this._choose.type = 'button'; this._choose.disabled = this._field.input.disabled;
      this._choose.setAttribute('aria-controls', this._field.input.id); this._choose.addEventListener('click', function () { this._field.input.click(); }.bind(this)); this._field.wrap.append(this._choose);
      this._share = el('input'); this._share.type = 'checkbox'; this._share.id = this._id + '-share'; this._share.checked = !this.hasAttribute('private') && api.getUi('file-share:' + this._id, false);
      this._share.disabled = this.hasAttribute('disabled');
      var shareLabel = el('label', 'ma-file-share'), shareText = el('span'); api.bindText(shareText, '将已选文件内容提供给模型'); shareLabel.append(this._share, shareText); shareLabel.htmlFor = this._share.id; shareLabel.hidden = this.hasAttribute('private');
      this._summary = el('p', 'ma-file-summary'); this._summary.setAttribute('role', 'status');
      this._clear = el('button', 'ma-btn'); this._clear.type = 'button';
      var help = el('p', 'ma-text-label');
      api.bindText(this._clear, '移除文件'); api.bindText(help, '本地导入 UTF-8 文本/Markdown/CSV/JSON，每文件最多 64 KiB，总计最多 128 KiB。勾选前内容仅用于本地恢复。');
      this.replaceChildren(this._field.wrap, help, shareLabel, this._summary, this._clear);
      api.ensure(this._name, [], { private: !this._share.checked });
      this._field.input.addEventListener('change', async function () {
        var files = Array.from(this._field.input.files || []), version = ++this._readVersion; if (!files.length) return;
        try {
          var maxFiles = Number(this.getAttribute('max-files') || (this.hasAttribute('multiple') ? 4 : 1)), maxBytes = Number(this.getAttribute('max-bytes') || 65536);
          if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 4 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw api.ownedError('max-files 须为 1–4，max-bytes 须为 1–65536');
          if (files.length > maxFiles || files.reduce(function (sum, file) { return sum + file.size; }, 0) > 131072) throw api.ownedError('文件数量或总大小超限');
          var accepted = this._field.input.accept.split(',').map(function (value) { return value.trim().toLowerCase(); }).filter(Boolean);
          var values = [];
          for (var file of files) {
            var extension = '.' + file.name.split('.').pop().toLowerCase();
            if (file.size > maxBytes) throw api.ownedError(file.name + ' 超过单文件大小上限 ' + maxBytes + ' 字节');
            if (!['.txt', '.md', '.csv', '.json', '.log'].includes(extension) || !accepted.some(function (rule) { return rule === extension || rule === file.type.toLowerCase() || rule === 'text/*' && file.type.startsWith('text/'); })) throw api.ownedError(file.name + ' 的文件类型不受支持');
            var text = await readText(file); if (text.includes('\u0000')) throw api.ownedError(file.name + ' 包含二进制内容'); if (extension === '.json') { try { JSON.parse(text); } catch (_) { throw api.ownedError(file.name + ' 不是有效 JSON'); } }
            values.push({ name: file.name, type: file.type, size: file.size, text: text });
          }
          if (version !== this._readVersion || !this.isConnected) return;
          this._share.checked = false; await api.setUi('file-share:' + this._id, false);
          await api.set(this._name, values, { private: true }); this.removeAttribute('aria-invalid'); this.clearDiagnostic(); this.refreshSafely();
        } catch (error) { if (version === this._readVersion && this.isConnected) this.showDiagnostic(error); }
        finally { if (version === this._readVersion) this._field.input.value = ''; }
      }.bind(this));
      this._share.addEventListener('change', async function () {
        try { await api.setUi('file-share:' + this._id, this._share.checked); await api.set(this._name, api.get(this._name, []), { private: !this._share.checked }); }
        catch (error) { this.showDiagnostic(error); }
      }.bind(this));
      this._clear.addEventListener('click', async function () { ++this._readVersion; this._field.input.value = ''; try { await api.set(this._name, [], { private: !this._share.checked }); this.removeAttribute('aria-invalid'); this.clearDiagnostic(); } catch (error) { this.showDiagnostic(error); } }.bind(this));
    }
    refresh() {
      var files = api.get(this._name, []); if (!Array.isArray(files)) throw api.ownedError('文件状态须为数组');
      var shared = !this.hasAttribute('private') && !!api.getUi('file-share:' + this._id, false);
      if (this._share.checked !== shared) { this._share.checked = shared; api.ensure(this._name, [], { private: !shared }); }
      if (files.length) api.bindText(this._summary, '{files}', function () { return { files: files.map(function (file) { return api.text('{name}（{size} 字节）', { name: file.name, size: file.size }); }).join(api.locale() === 'en' ? ', ' : '、') }; });
      else api.bindText(this._summary, '尚未选择文件');
      this._clear.disabled = !files.length || this.hasAttribute('disabled');
      api.bindText(this._choose, files.length ? '重新导入文件' : '选择文件');
    }
    disconnectedCallback() { ++this._readVersion; super.disconnectedCallback(); }
  });
})();
