(function () {
  'use strict';
  var api = window.maUi, helper = api.components, Component = helper.Component, el = helper.element;
  function rowsFor(component, source) {
    source = source || helper.data(component);
    var rows = Array.isArray(source) ? source : source.rows || [];
    var filter = component.getAttribute('filter'), field = component.getAttribute('filter-key');
    var value = filter ? api.get(filter, '') : '';
    if (field && value !== '' && value !== 'all' && value != null) rows = rows.filter(function (row) { return Array.isArray(value) ? value.includes(row[field]) : String(row[field]) === String(value); });
    var search = component.getAttribute('search'), query = search ? String(api.get(search, '') || '').toLocaleLowerCase() : '';
    if (query) rows = rows.filter(function (row) { return Object.values(row).some(function (value) { return String(value == null ? '' : value).toLocaleLowerCase().includes(query); }); });
    return rows;
  }
  function cellText(value) { return value == null ? '' : Array.isArray(value) ? value[0] : typeof value === 'object' ? JSON.stringify(value) : String(value); }
  customElements.define('ma-table', class extends Component {
    build() {
      this._inlineSource = this.querySelector('script[type="application/json"]');
      if (this.hasAttribute('selection')) api.ensure(this.getAttribute('selection'), null, { private: this.hasAttribute('private') });
      if (this.hasAttribute('stats')) api.ensure(this.getAttribute('stats'), { totalCount: 0, filteredCount: 0, selectedCount: 0, page: 1, pageCount: 1 }, { private: this.hasAttribute('private') });
      this.classList.add('ma-table-component');
      this._templates = new Map();
      this.querySelectorAll('template[data-column]').forEach(function (template) { this._templates.set(template.getAttribute('data-column'), template.cloneNode(true)); }, this);
      this._actions = this.querySelector('template[data-actions]');
      if (this._actions) this._actions = this._actions.cloneNode(true);
      this._table = el('table', 'ma-table');
      if (this.getAttribute('label')) this._table.setAttribute('aria-label', this.getAttribute('label'));
      else api.bindAttr(this._table, 'aria-label', '数据表');
      this._head = el('thead'); this._body = el('tbody'); this._table.append(this._head, this._body);
      this._wrapper = el('div', 'ma-table-scroll'); this._wrapper.append(this._table);
      this._empty = el('p', 'ma-empty'); this._empty.setAttribute('role', 'status');
      api.bindText(this._empty, '没有符合条件的数据');
      this._pager = el('div', 'ma-table-pager'); this._pageInfo = el('span'); this._pageInfo.setAttribute('role', 'status');
      this._previous = el('button', 'ma-btn'); this._previous.type = 'button';
      this._next = el('button', 'ma-btn'); this._next.type = 'button';
      api.bindText(this._previous, '上一页'); api.bindText(this._next, '下一页');
      const move = function (delta) { api.setUi('table-page:' + this._id, { index: this._pageIndex + delta, scope: this._pageScope }).catch(api.warn); }.bind(this);
      this._previous.addEventListener('click', function () { move(-1); }); this._next.addEventListener('click', function () { move(1); });
      this._pager.append(this._pageInfo, this._previous, this._next);
      this.replaceChildren(this._wrapper, this._empty, this._pager);
      this._wrapper.addEventListener('scroll', function () { if (this.hasAttribute('virtual')) this.refreshSafely(); }.bind(this));
    }
    refresh() {
      var source = helper.data(this), variant = this.getAttribute('variant') || 'data';
      if (!['data', 'comparison', 'details'].includes(variant)) throw api.ownedError('表格 variant 须为 data/comparison/details');
      if (variant === 'details' && !Array.isArray(source) && !source.rows && !source.columns) {
        source = { columns: [{ key: 'label', label: api.text('字段') }, { key: 'value', label: api.text('内容') }], rows: Object.entries(source).map(function (entry) { return { label: entry[0], value: entry[1] }; }) };
      }
      var original = Array.isArray(source) ? source : source.rows || [];
      var columns = source.columns || (this.hasAttribute('columns') ? JSON.parse(this.getAttribute('columns')) : Object.keys(original[0] || {}).map(function (key) { return { key: key, label: key }; }));
      var sortable = this.getAttribute('sortable') === 'true' || variant === 'data' && this.getAttribute('sortable') !== 'false';
      var sort = sortable ? api.getUi('table:' + this._id, { key: null, direction: 1 }) : { key: null, direction: 1 };
      var rows = rowsFor(this, source).slice();
      if (sort.key) rows.sort(function (a, b) {
        var av = a[sort.key], bv = b[sort.key];
        return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(cellText(av)).localeCompare(String(cellText(bv)), document.documentElement.lang)) * sort.direction;
      });
      var filteredCount = rows.length, virtual = this.hasAttribute('virtual');
      if (virtual && (variant !== 'data' || this._templates.size || this._actions)) throw api.ownedError('virtual 仅支持没有自定义单元格的 data 表格；复杂单元格请使用 page-size 分页');
      var pageSize = Number(this.getAttribute('page-size') || 50);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw api.ownedError('page-size 须为 1–200 的整数');
      var scope = JSON.stringify([sort, this.getAttribute('filter') && api.get(this.getAttribute('filter')), this.getAttribute('search') && api.get(this.getAttribute('search')), filteredCount, pageSize]);
      var page = api.getUi('table-page:' + this._id, { index: 0, scope: scope });
      var pageCount = Math.max(1, Math.ceil(filteredCount / pageSize));
      this._pageScope = scope; this._pageIndex = page.scope === scope ? Math.max(0, Math.min(pageCount - 1, Number(page.index) || 0)) : 0;
      var start = virtual ? Math.max(0, Math.floor(this._wrapper.scrollTop / 40) - 4) : this._pageIndex * pageSize;
      var end = virtual ? Math.min(filteredCount, start + Math.ceil((this._wrapper.clientHeight || 320) / 40) + 8) : Math.min(filteredCount, start + pageSize);
      if (virtual && this._virtualScope !== scope) { this._wrapper.scrollTop = 0; start = 0; end = Math.min(filteredCount, 16); }
      this._virtualScope = scope;
      this._wrapper.classList.toggle('ma-table-virtual', virtual);
      if (virtual) { this._wrapper.setAttribute('data-ma-wheel', 'local'); this._wrapper.tabIndex = 0; api.bindAttr(this._wrapper, 'aria-label', '{label}，聚焦后滚动行', function () { return { label: this.getAttribute('label') || api.text('数据表') }; }.bind(this)); }
      api.bindText(this._pageInfo, '{info}', function () { return { info: api.text('共 {total} 条，筛选 {filtered} 条', { total: original.length, filtered: filteredCount }) + (virtual ? '' : api.text('，第 {page} / {pages} 页', { page: this._pageIndex + 1, pages: pageCount })) }; }.bind(this));
      this._pager.hidden = !virtual && pageCount <= 1; this._previous.hidden = virtual; this._next.hidden = virtual;
      this._previous.disabled = this._pageIndex <= 0; this._next.disabled = this._pageIndex + 1 >= pageCount;
      rows = rows.slice(start, end);
      var focus = this.contains(document.activeElement) ? document.activeElement.id : null;
      var selected = this.getAttribute('selection') ? api.get(this.getAttribute('selection'), null) : null;
      var statsKey = this.getAttribute('stats');
      if (statsKey) {
        var counts = { totalCount: original.length, filteredCount: filteredCount, selectedCount: Array.isArray(selected) ? selected.length : selected == null ? 0 : 1, page: this._pageIndex + 1, pageCount: pageCount };
        if (JSON.stringify(api.get(statsKey)) !== JSON.stringify(counts)) api.set(statsKey, counts, { private: this.hasAttribute('private') }).catch(api.warn);
      }
      var renderKey = JSON.stringify([columns, rows, sort, selected, variant, sortable, start, end, filteredCount]);
      this.removeAttribute('aria-invalid');
      if (renderKey === this._renderKey) return;
      this._renderKey = renderKey;
      this._table.dataset.variant = variant;
      this._table.toggleAttribute('data-virtual', virtual); this._table.setAttribute('aria-rowcount', String(filteredCount + 1));
      this._head.hidden = variant === 'details';
      var trh = el('tr');
      columns.forEach(function (column, index) {
        var th = el('th', column.num ? 'num' : ''); th.scope = 'col';
        th.classList.toggle('is-recommended', !!column.recommended);
        th.setAttribute('aria-sort', sort.key === column.key ? sort.direction > 0 ? 'ascending' : 'descending' : 'none');
        var button = el(sortable ? 'button' : 'span', sortable ? 'ma-sort-button' : '', column.label || column.key);
        button.id = this._id + '-sort-' + index;
        if (sortable) { button.type = 'button'; api.bindAttr(button, 'aria-label', '{label}，排序', { label: column.label || column.key }); }
        if (sort.key === column.key) button.append(el('span', 'ma-sort-direction', sort.direction > 0 ? ' ↑' : ' ↓'));
        if (sortable) button.addEventListener('click', function () {
          api.setUi('table:' + this._id, { key: column.key, direction: sort.key === column.key ? -sort.direction : 1 }).catch(api.fail);
        }.bind(this));
        th.append(button); trh.append(th);
        if (column.recommended) { var recommended = el('span', 'ma-badge'); api.bindText(recommended, '推荐'); recommended.dataset.tone = 'info'; th.append(recommended); }
      }, this);
      if (this._actions) { var actionHead = el('th'); api.bindText(actionHead, '操作'); actionHead.scope = 'col'; trh.append(actionHead); }
      this._head.replaceChildren(trh);
      var fragment = document.createDocumentFragment(), selection = this.getAttribute('selection'), rowKey = this.getAttribute('row-key') || 'id';
      var multiple = this.getAttribute('selection-mode') === 'multiple', idsOnly = this.getAttribute('selection-value') === 'id';
      const selectRow = function (row) {
        if ((multiple || idsOnly) && row[rowKey] == null) return Promise.reject(api.ownedError('ID 选择需要稳定的 row-key'));
        if (!multiple) return api.set(selection, idsOnly ? row[rowKey] : row, { private: this.hasAttribute('private') });
        if (row[rowKey] == null) return Promise.reject(api.ownedError('多选表格需要稳定的 row-key'));
        var ids = new Set(api.get(selection, []) || []); if (ids.has(row[rowKey])) ids.delete(row[rowKey]); else ids.add(row[rowKey]);
        return api.set(selection, Array.from(ids), { private: this.hasAttribute('private') });
      }.bind(this);
      const spacer = function (height) { var row = el('tr'); row.setAttribute('aria-hidden', 'true'); var cell = el('td'); cell.colSpan = columns.length; cell.style.height = height + 'px'; cell.style.padding = '0'; cell.style.border = '0'; row.append(cell); fragment.append(row); };
      if (virtual && start) spacer(start * 40);
      rows.forEach(function (row, index) {
        var sourceIndex = original.indexOf(row), tr = el('tr');
        tr.setAttribute('aria-rowindex', String(start + index + 2));
        var chosen = multiple ? Array.isArray(selected) && selected.includes(row[rowKey]) : idsOnly ? selected != null && selected === row[rowKey] : selected && (row[rowKey] != null ? selected[rowKey] === row[rowKey] : JSON.stringify(selected) === JSON.stringify(row));
        if (selection) { tr.setAttribute('aria-selected', String(!!chosen)); tr.classList.toggle('is-selected', !!chosen); }
        columns.forEach(function (column, columnIndex) {
          var td = el(variant === 'details' && columnIndex === 0 ? 'th' : 'td', (column.num ? 'num ' : '') + (column.mono ? 'mono' : ''));
          if (td.tagName === 'TH') td.scope = 'row';
          td.classList.toggle('is-recommended', !!column.recommended);
          td.setAttribute('data-ma-row', ''); td.__maRow = row;
          var template = this._templates.get(column.key);
          if (template) td.append(template.content.cloneNode(true));
          else if ((column.badge || variant === 'comparison') && Array.isArray(row[column.key])) {
            var badge = el('span', 'ma-badge', row[column.key][0]); badge.dataset.tone = row[column.key][1] || 'neutral'; td.append(badge);
          } else if (selection && columnIndex === 0) {
            var choose = el('button', 'ma-row-select', cellText(row[column.key])); choose.type = 'button';
            choose.id = this._id + '-row-' + sourceIndex; choose.setAttribute('aria-pressed', String(!!chosen));
            api.bindAttr(choose, 'aria-label', '选择 {name}', { name: cellText(row[column.key]) });
            choose.addEventListener('click', function () { selectRow(row).catch(api.warn); }); td.append(choose);
          } else td.textContent = column.format || column.unit ? helper.format(row[column.key], column) : cellText(row[column.key]);
          tr.append(td);
        }, this);
        if (selection) tr.addEventListener('click', function (event) {
          if (event.target instanceof Element && event.target.closest('button,a,input,select,textarea')) return;
          selectRow(row).catch(api.warn);
        }.bind(this));
        if (this._actions) {
          var td = el('td', 'ma-row-actions'); td.setAttribute('data-ma-row', ''); td.__maRow = row;
          td.append(this._actions.content.cloneNode(true)); tr.append(td);
        }
        fragment.append(tr);
      }, this);
      if (virtual && end < filteredCount) spacer((filteredCount - end) * 40);
      this._body.replaceChildren(fragment); this._empty.hidden = filteredCount > 0;
      this.removeAttribute('aria-invalid');
      if (focus) { var previous = document.getElementById(focus); if (previous) previous.focus({ preventScroll: true }); }
      api.report();
    }
  });
  customElements.define('ma-list', class extends Component {
    build() {
      this._inlineSource = this.querySelector('script[type="application/json"]'); this._name = this.getAttribute('name') || this._id;
      this._private = this.hasAttribute('private');
      this._list = el('ol', 'ma-list');
      this._empty = el('p', 'ma-empty'); this._empty.setAttribute('role', 'status');
      if (this.getAttribute('label')) this._list.setAttribute('aria-label', this.getAttribute('label'));
      else api.bindAttr(this._list, 'aria-label', '列表');
      api.bindText(this._empty, '没有符合条件的项目');
      this.replaceChildren(this._list, this._empty);
    }
    refresh() {
      var source = helper.data(this), rows = Array.isArray(source) ? source : source.rows || [];
      var variant = this.getAttribute('variant') || 'plain';
      if (!['plain', 'steps', 'checklist'].includes(variant)) throw api.ownedError('列表 variant 须为 plain/steps/checklist');
      this._list.dataset.variant = variant;
      var key = JSON.stringify([rows, variant]), focused = this.contains(document.activeElement) ? document.activeElement.id : null;
      if (key !== this._renderKey) {
        this._renderKey = key; var ids = new Set();
        this._records = rows.map(function (row, index) {
          var id = String(row.id ?? index); if (ids.has(id)) throw api.ownedError('列表 id 重复 ' + id); ids.add(id);
          var item = el('li', 'ma-list-item'), marker = el('span', 'ma-list-marker'); marker.setAttribute('aria-hidden', 'true');
          var title = el('label', 'ma-list-title', row.label ?? row.name ?? ''), content = el('div', 'ma-list-content'); content.append(title);
          if (row.description != null) content.append(el('span', 'ma-list-description', row.description));
          var check;
          if (variant === 'checklist') {
            check = el('input', 'ma-form-control'); check.type = 'checkbox'; check.id = this._id + '-item-' + index; title.htmlFor = check.id;
            check.disabled = this.hasAttribute('disabled') || !!row.disabled;
            check.addEventListener('change', function () {
              var checked = new Set(api.get(this._name, this._default));
              if (check.checked) checked.add(id); else checked.delete(id);
              api.set(this._name, Array.from(checked), { private: this._private }).catch(api.warn);
            }.bind(this));
          }
          item.append(check || marker, content);
          var side = el('div', 'ma-list-side'), badge = el('span', 'ma-badge'); side.append(badge);
          if (row.date != null) side.append(el('span', 'ma-list-date', row.date));
          var progress, progressText;
          if (row.progress != null) {
            progress = el('progress'); progress.max = 100;
            api.bindAttr(progress, 'aria-label', '{label}进度', function () { return { label: row.label ?? row.name ?? api.text('项目') }; }); progressText = el('span', 'ma-list-date'); side.append(progress, progressText);
          }
          item.append(side); return { row: row, id: id, position: index + 1, item: item, check: check, marker: marker, badge: badge, progress: progress, progressText: progressText };
        }, this);
        this._list.replaceChildren(...this._records.map(function (record) { return record.item; }));
        if (variant === 'checklist') {
          this._default = this._records.filter(function (record) { return record.row.status === 'done'; }).map(function (record) { return record.id; });
          api.ensure(this._name, this._default, { private: this._private });
        }
        if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
      }
      var completion = this.getAttribute('completion') || (variant === 'checklist' ? this._name : null);
      var defaultChecked = this._records.filter(function (record) { return record.row.status === 'done'; }).map(function (record) { return record.id; });
      var visible = new Set(rowsFor(this)), checked = completion ? api.get(completion, defaultChecked) : [];
      if (!Array.isArray(checked)) throw api.ownedError('列表勾选状态须为数组');
      var statuses = { done: ['已完成', 'success', '✓'], doing: ['进行中', 'info', '•'], todo: ['待开始', 'neutral', ''], blocked: ['受阻', 'warning', '!'] };
      this._records.forEach(function (record) {
        record.item.hidden = !visible.has(record.row);
        var status = completion && checked.includes(record.id) ? 'done' : record.row.status === 'done' && completion ? 'todo' : record.row.status || 'todo';
        var display = statuses[status] || [status, 'neutral', '']; record.item.dataset.status = status;
        if (Object.prototype.hasOwnProperty.call(statuses, status)) api.bindText(record.badge, display[0]);
        else { api.unbindText(record.badge); record.badge.textContent = display[0]; }
        record.badge.dataset.tone = display[1]; record.badge.hidden = variant === 'plain' && !record.row.status;
        record.marker.textContent = variant === 'steps' && !display[2] ? String(record.position) : display[2];
        if (record.check) record.check.checked = checked.includes(record.id);
        if (record.progress) {
          record.progress.value = status === 'done' ? 100 : record.row.status === 'done' && completion ? 0 : Math.max(0, Math.min(100, Number(record.row.progress) || 0));
          record.progressText.textContent = record.progress.value + '%';
        }
      }, this);
      this._empty.hidden = visible.size > 0; this.removeAttribute('aria-invalid'); api.report();
    }
  });
  function svgNode(name, attrs, text) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    if (text != null) node.textContent = String(text); return node;
  }
  customElements.define('ma-chart', class extends Component {
    build() {
      this._inlineSource = this.querySelector('script[type="application/json"]');
      this.classList.add('ma-chart-component');
      this._plot = el('div', 'ma-chart-plot'); this._legend = el('div', 'ma-chart-series');
      this._tooltip = el('div', 'ma-chart-tooltip'); this._tooltip.hidden = true; this._tooltip.setAttribute('role', 'tooltip');
      this.replaceChildren(this._plot, this._legend, this._tooltip);
      var width = 0;
      this._resize = new ResizeObserver(function () { var next = this.clientWidth; if (next !== width) { width = next; this.refresh(); } }.bind(this));
      this._resize.observe(this);
      this._appearance = this.refresh.bind(this); window.addEventListener('ma-ui:appearance', this._appearance);
      if (document.fonts) document.fonts.ready.then(function () { if (this.isConnected) this.refresh(); }.bind(this));
    }
    disconnectedCallback() {
      super.disconnectedCallback(); if (this._resize) this._resize.disconnect();
      if (this._appearance) window.removeEventListener('ma-ui:appearance', this._appearance);
    }
    refresh() {
      var d3 = api.d3;
      if (!d3) throw api.ownedError('图表公共资源未加载');
      var source = helper.data(this), type = this.getAttribute('type') || source.type || 'bar';
      var labelKey = this.getAttribute('label-key') || 'label', valueKey = this.getAttribute('value-key') || 'value';
      var labels, series;
      if (Array.isArray(source) || source.rows) {
        var rows = rowsFor(this); labels = rows.map(function (row) { return row[labelKey]; });
        series = [{ name: this.getAttribute('label') || valueKey, values: rows.map(function (row) { return Number(row[valueKey]); }) }];
      } else {
        labels = source.labels || [];
        series = source.series && source.series[0] && typeof source.series[0] === 'object' ? source.series : [{ name: this.getAttribute('label') || '', values: source.series || [] }];
      }
      if (series.some(function (item) { return item.values.length !== labels.length || item.values.some(function (value) { return !Number.isFinite(value); }); })) throw api.ownedError('图表标签与数值必须匹配，数值须为有限数字');
      var hidden = api.getUi('chart:' + this._id, []);
      var visible = series.map(function (item, index) { return { name: item.name, values: item.values, index: index }; }).filter(function (item) { return !hidden.includes(item.index); });
      var width = Math.max(160, this.clientWidth || 600), height = Number(this.getAttribute('height')) || (width < 460 ? 240 : 280);
      var unit = this.getAttribute('unit') || source.unit || '';
      var svg = svgNode('svg', { viewBox: '0 0 ' + width + ' ' + height, width: '100%', height: height, role: 'img', 'aria-label': this.getAttribute('label') || api.text('数据图表') });
      svg.append(svgNode('title', {}, unit ? api.text('{label}，单位 {unit}', { label: this.getAttribute('label') || api.text('数据图表'), unit: unit }) : this.getAttribute('label') || api.text('数据图表')));
      var focused = this.contains(document.activeElement) ? document.activeElement.id : null;
      this._plot.replaceChildren(svg); this._legend.replaceChildren(); this._tooltip.hidden = true;
      var color = function (index) {
        var token = source.colors && source.colors[index % source.colors.length];
        return token && ['blue', 'purple', 'green', 'yellow', 'red', 'text3'].includes(token) ? 'var(--' + (token === 'text3' ? 'text-3' : token) + ')' : 'var(--viz-series-' + (index % 6 + 1) + ')';
      };
      if (!labels.length || !visible.length) svg.append(svgNode('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'ma-chart-label' }, api.text(labels.length ? '选择一个系列以查看数据' : '没有符合条件的数据')));
      else if (type === 'pie' || type === 'donut') {
        if (visible[0].values.some(function (value) { return value < 0; })) throw api.ownedError('占比图不支持负值');
        var total = d3.sum(visible[0].values), radius = Math.min(width, height) / 2 - 28;
        if (!total) svg.append(svgNode('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'ma-chart-label' }, api.text('总量为 0')));
        else {
          var arc = d3.arc().innerRadius(type === 'donut' ? radius * 0.6 : 0).outerRadius(radius);
          d3.pie().sort(null)(visible[0].values).forEach(function (slice, index) {
            var path = svgNode('path', { d: arc(slice), transform: 'translate(' + width / 2 + ',' + height / 2 + ')', fill: color(index), tabindex: 0 });
            path.append(svgNode('title', {}, labels[index] + ': ' + slice.value + unit + ' (' + Math.round(slice.value / total * 100) + '%)')); svg.append(path);
          });
        }
      } else {
        var left = Math.min(76, Math.max(56, width * 0.12)), right = width - 14, top = 18, bottom = height - 52;
        var all = visible.flatMap(function (item) { return item.values; }), domain = d3.extent(all);
        if (type === 'bar') { domain[0] = Math.min(0, domain[0]); domain[1] = Math.max(0, domain[1]); }
        if (domain[0] === domain[1]) { var pad = Math.max(1, Math.abs(domain[0]) * 0.1); domain[0] -= pad; domain[1] += pad; }
        else { var pad = (domain[1] - domain[0]) * 0.1; if (domain[0] !== 0) domain[0] -= pad; if (domain[1] !== 0) domain[1] += pad; }
        var y = d3.scaleLinear().domain(domain).range([bottom, top]).nice();
        var indices = labels.map(function (_, index) { return index; });
        var band = d3.scaleBand().domain(indices).range([left, right]).padding(0.24);
        var point = d3.scalePoint().domain(indices).range([left + 8, right - 8]);
        var x = type === 'bar' ? function (index) { return band(index) + band.bandwidth() / 2; } : point;
        y.ticks(width < 460 ? 4 : 5).forEach(function (value) {
          svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'ma-chart-grid' }));
          svg.append(svgNode('text', { x: left - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'ma-chart-label' }, d3.format('~s')(value)));
        });
        var count = Math.min(labels.length, width < 460 ? 4 : 7), ticks = new Set();
        for (var i = 0; i < count; i++) ticks.add(count === 1 ? 0 : Math.round(i * (labels.length - 1) / (count - 1)));
        ticks.forEach(function (index) {
          var label = String(labels[index]), limit = Math.max(3, Math.floor((right - left) / Math.max(count, 1) / 9));
          var text = svgNode('text', { x: x(index), y: bottom + 21, 'text-anchor': 'middle', class: 'ma-chart-label' }, label.length > limit ? label.slice(0, limit - 1) + '…' : label);
          text.append(svgNode('title', {}, label)); svg.append(text);
        });
        var axisX = this.getAttribute('x-label') || source.xLabel, axisY = this.getAttribute('y-label') || source.yLabel || unit;
        if (axisX) svg.append(svgNode('text', { x: (left + right) / 2, y: height - 5, 'text-anchor': 'middle', class: 'ma-chart-label' }, axisX));
        if (axisY) svg.append(svgNode('text', { x: left, y: 13, class: 'ma-chart-label' }, axisY));
        visible.forEach(function (item, visibleIndex) {
          if (type === 'bar') item.values.forEach(function (value, index) {
            var barWidth = band.bandwidth() / visible.length;
            var rect = svgNode('rect', { x: band(index) + visibleIndex * barWidth, y: Math.min(y(value), y(0)), width: Math.max(0, barWidth - 1), height: Math.abs(y(value) - y(0)), fill: color(series.length === 1 && source.colors ? index : item.index) });
            rect.append(svgNode('title', {}, labels[index] + ': ' + value + unit)); svg.append(rect);
          });
          else {
            var line = d3.line().x(function (_, index) { return x(index); }).y(function (value) { return y(value); });
            svg.append(svgNode('path', { d: line(item.values), fill: 'none', stroke: color(item.index), 'stroke-width': 2 }));
            if (item.values.length <= 100) item.values.forEach(function (value, index) { svg.append(svgNode('circle', { cx: x(index), cy: y(value), r: 3, fill: color(item.index) })); });
          }
        });
        var guide = svgNode('line', { y1: top, y2: bottom, class: 'ma-chart-guide', visibility: 'hidden' }); svg.append(guide);
        svg.addEventListener('pointermove', function (event) {
          var rect = svg.getBoundingClientRect(), pointer = (event.clientX - rect.left) * width / (rect.width || width), nearest = 0;
          for (var i = 1; i < labels.length; i++) if (Math.abs(x(i) - pointer) < Math.abs(x(nearest) - pointer)) nearest = i;
          guide.setAttribute('x1', x(nearest)); guide.setAttribute('x2', x(nearest)); guide.setAttribute('visibility', 'visible');
          this._tooltip.textContent = String(labels[nearest]) + ' · ' + visible.map(function (item) { return (item.name ? item.name + ': ' : '') + item.values[nearest] + unit; }).join(' · ');
          this._tooltip.hidden = false;
          this._tooltip.style.left = Math.max(0, Math.min(this.clientWidth - this._tooltip.offsetWidth, event.clientX - this.getBoundingClientRect().left + 10)) + 'px';
          this._tooltip.style.top = '20px';
        }.bind(this));
        svg.addEventListener('pointerleave', function () { this._tooltip.hidden = true; guide.setAttribute('visibility', 'hidden'); }.bind(this));
      }
      if (series.length > 1) series.forEach(function (item, index) {
        var button = el('button', 'ma-series-toggle'); button.type = 'button';
        button.id = this._id + '-series-' + index;
        button.setAttribute('aria-pressed', String(!hidden.includes(index)));
        var swatch = el('span', 'ma-series-swatch'); swatch.style.background = color(index); swatch.setAttribute('aria-hidden', 'true');
        button.append(swatch, document.createTextNode(item.name || api.text('系列 {n}', { n: index + 1 })));
        button.addEventListener('click', function () { api.setUi('chart:' + this._id, hidden.includes(index) ? hidden.filter(function (value) { return value !== index; }) : hidden.concat(index)).catch(api.fail); }.bind(this));
        this._legend.append(button);
      }, this);
      if (type === 'pie' || type === 'donut') labels.forEach(function (label, index) {
        var item = el('span', 'ma-chart-legend-item'), swatch = el('span', 'ma-series-swatch');
        swatch.style.background = color(index); swatch.setAttribute('aria-hidden', 'true');
        item.append(swatch, document.createTextNode(label + ' · ' + series[0].values[index] + unit)); this._legend.append(item);
      }, this);
      if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
      this.removeAttribute('aria-invalid');
      api.report();
    }
  });
})();
