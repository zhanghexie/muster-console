/* Shared runtime. This executes before author content so script failures are observable. */
(function () {
  'use strict';
  var componentHost = window.maUi && window.maUi.version === 2 ? window.maUi : null;
  if (componentHost && typeof componentHost.onLocaleChange !== 'function') return;
  var framed = window.parent !== window;
  var nativeHost = !framed && window.__maUiHost;
  var post = window.parent.postMessage.bind(window.parent);
  var values = Object.create(null), defaults = Object.create(null), model = Object.create(null), ui = Object.create(null);
  var definitions = Object.create(null), stateWrites = new Set();
  var listeners = new Set(), pending = new Map(), requestId = 0, queuedState = null;
  var ready = !framed && !nativeHost, domReady = false, hostVisible = false, revision = 0, localVersion = 0, lastHeight = 0;
  var failure = '', lastWarning = null, stats = { ok: 0, degraded: 0 };
  var diagnostics = new Map();
  // Only runtime-owned labels and errors are projected; author content and
  // diagnostic records keep their original text and identity.
  var locale = 'zh-CN', bindings = new WeakMap();
  var english = {
    '继续': 'Continue', '内容': 'Content', '更多': 'More', '操作失败': 'Action failed',
    '已取消': 'Cancelled', '已复制': 'Copied', '已打开': 'Opened', '已提交': 'Submitted', '已加入输入框': 'Added to the input',
    '数据表': 'Data table', '没有符合条件的数据': 'No matching data', '上一页': 'Previous', '下一页': 'Next',
    '字段': 'Field', '推荐': 'Recommended', '操作': 'Actions', '列表': 'List', '没有符合条件的项目': 'No matching items',
    '已完成': 'Done', '进行中': 'In progress', '待开始': 'Not started', '受阻': 'Blocked',
    '数据图表': 'Chart', '选择一个系列以查看数据': 'Select a series to view the data', '总量为 0': 'Total is 0',
    '日期范围': 'Date range', '级联选择': 'Cascading selection', '请选择': 'Select', '树形选择': 'Tree selection',
    '导入文件': 'Import file', '选择文件': 'Choose file', '重新导入文件': 'Import another file', '移除文件': 'Remove file',
    '将已选文件内容提供给模型': 'Share selected file contents with the model', '尚未选择文件': 'No file selected',
    '本地导入 UTF-8 文本/Markdown/CSV/JSON，每文件最多 64 KiB，总计最多 128 KiB。勾选前内容仅用于本地恢复。': 'Import local UTF-8 text, Markdown, CSV, or JSON files, up to 64 KiB per file and 128 KiB total. Contents stay local until you select the checkbox.',
    '{label} · 开始日期': '{label} · Start date', '{label} · 结束日期': '{label} · End date',
    '{label} · 第 {n} 级': '{label} · Level {n}', '{label} · {level}': '{label} · {level}', '展开 {name}': 'Expand {name}',
    '{label}，聚焦后滚动行': '{label}, focus to scroll rows', '{label}，排序': '{label}, sort', '选择 {name}': 'Select {name}',
    '共 {total} 条，筛选 {filtered} 条': '{total} total, {filtered} matching', '，第 {page} / {pages} 页': ', page {page} of {pages}',
    '{label}进度': '{label} progress', '项目': 'Item', '{label}，单位 {unit}': '{label}, unit {unit}', '系列 {n}': 'Series {n}',
    '{name}（{size} 字节）': '{name} ({size} bytes)', '{files}': '{files}',
    'source 需要非空 JSON script id（最多 200 字符）': 'source requires a nonempty JSON script ID (at most 200 characters)',
    'source 必须引用 application/json script': 'source must reference an application/json script',
    'JSON 数据源超过 2 MiB，请拆分或精简': 'JSON source exceeds 2 MiB; split or reduce it',
    'JSON 数据源超过 100000 个容器节点，请精简': 'JSON source exceeds 100,000 container nodes; reduce it',
    '交互状态保存超时': 'Saving the interactive state timed out', '交互状态名称无效': 'Invalid interactive state name',
    '界面状态名称无效': 'Invalid interface state name', '未知交互动作': 'Unknown interactive action',
    '请点击或用键盘触发此操作': 'Click or use the keyboard to perform this action', '链接只支持 http 或 https': 'Links must use HTTP or HTTPS',
    '请在会话中继续提问，当前独立预览未连接会话': 'Continue in a session; this standalone preview is not connected to one',
    '交互操作超时': 'The interactive action timed out', '内容渲染失败': 'Could not render content', '交互状态保存失败': 'Could not save interactive state', '交互操作失败': 'Interactive action failed',
    'sum 最多计算 10000 项': 'sum accepts at most 10,000 items', 'len 需要字符串或数组': 'len requires a string or array',
    'count 需要数组': 'count requires an array', 'count 条件筛选最多 10000 项，请使用表格 stats': 'Conditional count accepts at most 10,000 items; use table stats',
    'count 字段无效': 'Invalid count field', 'includes 需要字符串或数组': 'includes requires a string or array',
    '字符串结果超过 65536 字符': 'String result exceeds 65,536 characters', '计算需要有效数字': 'Calculation requires valid numbers',
    '表达式为空或超过 4096 字符': 'Expression is empty or exceeds 4,096 characters',
    '检查此位置的运算符、括号和参数': 'Check the operator, parentheses, and arguments at this position',
    '表达式包含不支持的字符': 'Expression contains an unsupported character', '只允许白名单函数、字段引用及声明式运算符': 'Only allowed functions, field references, and declarative operators are supported',
    '表达式过于复杂': 'Expression is too complex', '表达式字段路径超过 32 层': 'Expression field path exceeds 32 levels',
    '表达式字段无效': 'Invalid expression field', '表达式嵌套超过 32 层': 'Expression nesting exceeds 32 levels',
    '表达式不完整': 'Expression is incomplete', '表达式语法错误': 'Expression syntax error',
    '点号后需要字段或白名单方法名': 'A field or allowed method name must follow the dot', '表达式存在多余内容': 'Expression contains extra content',
    '除数不能为零': 'Cannot divide by zero', '计算结果不是有限数值': 'Calculation result is not finite',
    '检查参数的值、类型和除数；修改输入后会重新计算': 'Check argument values, types, and divisors; the result recalculates when input changes',
    '计算结果存在循环引用': 'Calculated values contain a circular reference', '小数位数须为 0–8': 'Decimal places must be between 0 and 8', '时长不能为负数': 'Duration cannot be negative',
    'tone 须为 success/danger/warning/info/neutral': 'tone must be success, danger, warning, info, or neutral',
    '表格 variant 须为 data/comparison/details': 'Table variant must be data, comparison, or details',
    'virtual 仅支持没有自定义单元格的 data 表格；复杂单元格请使用 page-size 分页': 'virtual requires a data table without custom cells; use page-size for complex cells',
    'page-size 须为 1–200 的整数': 'page-size must be an integer from 1 to 200',
    'ID 选择需要稳定的 row-key': 'ID selection requires a stable row-key', '多选表格需要稳定的 row-key': 'Multi-select tables require a stable row-key',
    '列表 variant 须为 plain/steps/checklist': 'List variant must be plain, steps, or checklist', '列表勾选状态须为数组': 'List checked state must be an array',
    '图表公共资源未加载': 'Chart resources did not load', '图表标签与数值必须匹配，数值须为有限数字': 'Chart labels and values must match, and values must be finite', '占比图不支持负值': 'Pie charts do not support negative values',
    '日期须为有效的 YYYY-MM-DD': 'Dates must be valid YYYY-MM-DD values', '开始日期不能晚于结束日期': 'Start date cannot be after end date', '日期超出 min/max 范围': 'Date is outside the min/max range',
    '层级数据须为数组，最多 16 层': 'Hierarchy must be an array with at most 16 levels', '层级节点需要唯一非空字符串 value，最多 10000 项': 'Hierarchy nodes need unique nonempty string values, at most 10,000 items',
    '级联选择状态须为 value 数组': 'Cascade selection state must be an array of values', '树形多选状态须为 value 数组': 'Tree multi-select state must be an array of values',
    'max-files 须为 1–4，max-bytes 须为 1–65536': 'max-files must be 1–4 and max-bytes must be 1–65536',
    '文件数量或总大小超限': 'File count or total size exceeds the limit', '文件状态须为数组': 'File state must be an array',
    '仅支持 .includes()/.toUpperCase()/.toLowerCase()/.trim()；长度使用 .length 或 len(value)，不执行任意方法': 'Only .includes(), .toUpperCase(), .toLowerCase(), and .trim() are supported; use .length or len(value) for length',
  };
  function text(key, values) {
    var value = locale === 'en' && Object.prototype.hasOwnProperty.call(english, key) ? english[key] : key;
    return value.replace(/\{([^{}]+)\}/g, function (_, name) { return values && values[name] != null ? String(values[name]) : '{' + name + '}'; });
  }
  function updateBinding(node, entry) {
    var values = typeof entry.values === 'function' ? entry.values() : entry.values;
    if (entry.attribute) node.setAttribute(entry.attribute, text(entry.key, values));
    else node.textContent = text(entry.key, values);
  }
  function bind(node, key, values, attribute) {
    var entries = bindings.get(node) || {}, id = attribute || '';
    entries[id] = { key: key, values: values, attribute: attribute };
    bindings.set(node, entries); updateBinding(node, entries[id]);
  }
  function unbind(node, attribute) { var entries = bindings.get(node); if (entries) delete entries[attribute || '']; }
  function updateBindings() {
    document.querySelectorAll('*').forEach(function (node) {
      var entries = bindings.get(node); if (entries) Object.values(entries).forEach(function (entry) { updateBinding(node, entry); });
    });
  }
  function ownedError(message) { var error = new Error(message); error.maUiOwned = true; return error; }
  function displayError(error) {
    var value = String(error && error.message != null ? error.message : error || '');
    if (locale !== 'en' || !error || !error.maUiOwned) return value;
    if (Object.prototype.hasOwnProperty.call(english, value)) return english[value];
    var patterns = [
      [/^JSON 数据源不存在：([\s\S]*)$/, 'JSON data source not found: $1'],
      [/^JSON 数据源 ([\s\S]*) 格式错误：([\s\S]*)$/, 'Invalid JSON data source $1: $2'],
      [/^交互状态超出 256 KiB：已用 (\d+) 字节，上限 (\d+) 字节；请只保存选择 ID 和界面参数$/, 'Interactive state exceeds 256 KiB: $1 bytes used, limit $2 bytes; save only selection IDs and interface parameters'],
      [/^表达式缺少 ([\s\S]*)$/, 'Expression is missing $1'], [/^不支持的方法 ([\s\S]*)$/, 'Unsupported method $1'],
      [/^不支持的计算函数 ([\s\S]*)$/, 'Unsupported calculation function $1'], [/^缺少参数 ([\s\S]*)$/, 'Missing parameter $1'],
      [/^数据中不存在字段 ([\s\S]*)$/, 'Data does not contain field $1'], [/^\.([\w]+)\(\) 的接收值类型不正确$/, 'Invalid receiver type for .$1()'],
      [/^不支持的显示格式 ([\s\S]*)$/, 'Unsupported display format $1'], [/^计算结果名称重复 ([\s\S]*)$/, 'Duplicate calculated value name $1'],
      [/^列表 id 重复 ([\s\S]*)$/, 'Duplicate list ID $1'], [/^无法读取文件 ([\s\S]*)$/, 'Could not read file $1'],
      [/^([\s\S]*) 不是有效 UTF-8 文本$/, '$1 is not valid UTF-8 text'], [/^([\s\S]*) 超过单文件大小上限 (\d+) 字节$/, '$1 exceeds the per-file limit of $2 bytes'],
      [/^([\s\S]*) 的文件类型不受支持$/, '$1 has an unsupported file type'], [/^([\s\S]*) 包含二进制内容$/, '$1 contains binary content'], [/^([\s\S]*) 不是有效 JSON$/, '$1 is not valid JSON']
    ];
    for (var pair of patterns) if (pair[0].test(value)) return value.replace(pair[0], pair[1]);
    return value;
  }
  function displayHint(value) {
    if (locale !== 'en' || typeof value !== 'string') return value;
    if (Object.prototype.hasOwnProperty.call(english, value)) return english[value];
    var rewrite = /^请改写为 ([\w]+)\(value, \.\.\.\)，不支持 \.\1\(\) 方法写法$/.exec(value);
    if (rewrite) return 'Use ' + rewrite[1] + '(value, ...) instead of .' + rewrite[1] + '()';
    if (value.startsWith('可用函数：')) return 'Available functions: ' + value.slice('可用函数：'.length);
    return value;
  }
  var resolveReady;
  var readiness = new Promise(function (resolve) { resolveReady = resolve; });
  var storageKey = 'ma-ui-state:' + window.location.pathname;
  var unsafe = new Set(['__proto__', 'prototype', 'constructor']);
  var sourceCache = new WeakMap();
  function source(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw ownedError('source 需要非空 JSON script id（最多 200 字符）');
    var script = document.getElementById(id);
    if (!script) throw ownedError('JSON 数据源不存在：' + id);
    return readSource(script);
  }
  function readSource(script) {
    if (!script || script.tagName !== 'SCRIPT' || script.type !== 'application/json') throw ownedError('source 必须引用 application/json script');
    var text = script.textContent || '{}', cached = sourceCache.get(script);
    if (cached && cached.text === text) return cached.value;
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw ownedError('JSON 数据源超过 2 MiB，请拆分或精简');
    var value;
    try { value = JSON.parse(text); } catch (error) { throw ownedError('JSON 数据源 ' + (script.id || '(内嵌)') + ' 格式错误：' + error.message); }
    // Freeze iteratively: expressions and components share one read-only parse,
    // without copying datasets into persistence or recursing through hostile depth.
    var queue = [value], count = 0;
    while (queue.length) {
      var item = queue.pop(); if (!item || typeof item !== 'object') continue;
      if (++count > 100000) throw ownedError('JSON 数据源超过 100000 个容器节点，请精简');
      Object.freeze(item); Object.keys(item).forEach(function (key) { if (item[key] && typeof item[key] === 'object') queue.push(item[key]); });
    }
    sourceCache.set(script, { text: text, value: value }); return value;
  }
  var STATE_MAX_BYTES = 256 * 1024;
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function send(message) {
    if (framed) { post(Object.assign({ __ma: true, v: 2 }, message), '*'); return; }
    if (!nativeHost) return;
    if (message.type === 'ready') nativeHost.read().then(function (snapshot) { receive({ type: 'init', state: snapshot.state }); }).catch(fail);
    else if (message.type === 'state' || message.type === 'action') {
      var operation = message.type === 'state' ? nativeHost.save(message.state) : nativeHost.action(message.action, message.state);
      Promise.resolve(operation).then(function (result) { if (message.type === 'state') lastWarning = null; receive({ type: message.type + '-result', id: message.id, ok: true, state: message.type === 'state' ? result.state : null, result: message.type === 'action' ? result : null }); })
        .catch(function (error) { receive({ type: message.type + '-result', id: message.id, ok: false, error: error.message }); });
    } else if (message.type === 'render' || message.type === 'error') {
      nativeHost.receipt({ status: message.type === 'error' ? 'failed' : message.status, visible: hostVisible, ...(message.message ? { error: message.message } : {}), ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}) }).catch(function (error) { console.warn(error); });
    }
  }
  function validKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length < 200 && key.split('.').every(function (part) { return part && !unsafe.has(part); });
  }
  function readPath(source, key) {
    if (!validKey(key)) return undefined;
    var path = key.split('.'), value = source;
    for (var i = 0; i < path.length; i++) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, path[i])) return undefined;
      value = value[path[i]];
    }
    return value;
  }
  function publish(restored) {
    var event = { values: clone(values), modelContent: clone(model), restored: !!restored };
    listeners.forEach(function (listener) { try { listener(event); } catch (error) { fail(error); } });
    window.dispatchEvent(new CustomEvent('ma-ui:state', { detail: event }));
  }
  function snapshot(compact) {
    var savedValues = clone(values);
    if (compact) Object.keys(model).forEach(function (key) { if (JSON.stringify(savedValues[key]) === JSON.stringify(model[key])) delete savedValues[key]; });
    return { modelContent: Object.keys(model).length ? clone(model) : null, privateContent: { values: savedValues, ui: clone(ui) } };
  }
  function stateUsage() { var used = new TextEncoder().encode(JSON.stringify(snapshot(true))).length; return { usedBytes: used, maxBytes: STATE_MAX_BYTES, remainingBytes: Math.max(0, STATE_MAX_BYTES - used) }; }
  function checkBudget() { var usage = stateUsage(); if (usage.usedBytes > usage.maxBytes) { var error = ownedError('交互状态超出 256 KiB：已用 ' + usage.usedBytes + ' 字节，上限 ' + usage.maxBytes + ' 字节；请只保存选择 ID 和界面参数'); error.maUiState = true; throw error; } }
  function applyState(saved) {
    if (!saved || typeof saved !== 'object') return;
    var privateContent = saved.privateContent || {};
    var nextValues = Object.assign(Object.create(null), defaults, saved.modelContent || {}, privateContent.values || {});
    var nextUi = Object.assign(Object.create(null), privateContent.ui || {});
    var nextModel = Object.assign(Object.create(null), saved.modelContent && typeof saved.modelContent === 'object' && !Array.isArray(saved.modelContent) ? saved.modelContent : {});
    var changed = JSON.stringify([values, ui, model]) !== JSON.stringify([nextValues, nextUi, nextModel]);
    values = nextValues; ui = nextUi; model = nextModel;
    revision = Number.isSafeInteger(saved.revision) ? saved.revision : revision;
    if (changed || !ready) publish(true);
  }
  function replayState() {
    if (pending.size || !queuedState) return;
    var saved = queuedState; queuedState = null;
    if (saved.revision >= revision) applyState(saved);
  }
  function persist(patch) {
    var state = patch || snapshot(true);
    try {
      checkBudget();
    } catch (error) { error.maUiState = true; return Promise.reject(error); }
    localVersion += 1;
    if (!framed && !nativeHost) {
      try { localStorage.setItem(storageKey, JSON.stringify(snapshot(true))); lastWarning = null; return Promise.resolve(); }
      catch (error) { error.maUiState = true; return Promise.reject(error); }
    }
    var id = ++requestId, version = localVersion;
    var operation = new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () { pending.delete(id); replayState(); reject(ownedError('交互状态保存超时')); }, 30000);
      pending.set(id, { resolve: resolve, reject: reject, timeout: timeout, version: version });
      send({ type: 'state', id: id, state: state, revision: revision });
    });
    stateWrites.add(operation);
    operation.then(function () { stateWrites.delete(operation); }, function () { stateWrites.delete(operation); });
    return operation;
  }
  function set(key, value, options) {
    if (!validKey(key)) return Promise.reject(ownedError('交互状态名称无效'));
    var previousValue = values[key], previousModel = model[key], hadValue = Object.prototype.hasOwnProperty.call(values, key), hadModel = Object.prototype.hasOwnProperty.call(model, key);
    values[key] = clone(value);
    if (options && options.private) delete model[key]; else model[key] = clone(value);
    try { checkBudget(); } catch (error) { if (hadValue) values[key] = previousValue; else delete values[key]; if (hadModel) model[key] = previousModel; else delete model[key]; return Promise.reject(error); }
    if (definitions[key]) definitions[key].private = !!(options && options.private);
    publish(false);
    var changes = {}; changes[key] = { value: clone(value), private: !!(options && options.private) };
    return persist({ valueChanges: changes });
  }
  function get(key, fallback) {
    var result = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : readPath(values, key);
    return result === undefined ? fallback : clone(result);
  }
  function getUi(key, fallback) { return Object.prototype.hasOwnProperty.call(ui, key) ? clone(ui[key]) : fallback; }
  function setUi(key, value) {
    if (!validKey(key)) return Promise.reject(ownedError('界面状态名称无效'));
    ui[key] = clone(value); publish(false); var changes = {}; changes[key] = clone(value); return persist({ uiChanges: changes });
  }
  function subscribe(listener) { listeners.add(listener); return function () { listeners.delete(listener); }; }
  function ensure(key, value, options) {
    if (validKey(key)) {
      defaults[key] = clone(value); definitions[key] = { value: clone(value), private: !!(options && options.private) };
      if (!Object.prototype.hasOwnProperty.call(values, key)) values[key] = clone(value);
      if (definitions[key].private) delete model[key]; else if (!Object.prototype.hasOwnProperty.call(model, key)) model[key] = clone(values[key]);
    }
    return get(key, value);
  }
  function interpolate(text) {
    return String(text == null ? '' : text).replace(/\{([^{}]+)\}/g, function (_, key) {
      var value = get(key, '');
      return value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
  }
  async function action(request) {
    if (!request || !['followup', 'copy', 'openUrl'].includes(request.type)) throw ownedError('未知交互动作');
    if (navigator.userActivation && !navigator.userActivation.isActive) throw ownedError('请点击或用键盘触发此操作');
    var payload = Object.assign({}, request);
    if (payload.text != null) payload.text = interpolate(payload.text);
    if (payload.url != null) payload.url = interpolate(payload.url);
    if (payload.type === 'openUrl' && !/^https?:\/\//i.test(payload.url || '')) throw ownedError('链接只支持 http 或 https');
    if (!framed && !nativeHost) {
      if (payload.type === 'copy') return navigator.clipboard.writeText(payload.text || '');
      if (payload.type === 'openUrl') { window.open(payload.url, '_blank', 'noopener,noreferrer'); return; }
      throw ownedError('请在会话中继续提问，当前独立预览未连接会话');
    }
    // Wait for this surface's changes; copying a full snapshot here would overwrite peer edits.
    await Promise.all(Array.from(stateWrites));
    var id = ++requestId;
    return new Promise(function (resolve, reject) {
      // Human confirmation stays pending until the host resolves it; do not report a timeout and then send later.
      var timeout = payload.type === 'followup' && payload.mode === 'send' ? null : setTimeout(function () { pending.delete(id); replayState(); reject(ownedError('交互操作超时')); }, 30000);
      pending.set(id, { resolve: resolve, reject: reject, timeout: timeout });
      send({ type: 'action', id: id, action: payload });
    });
  }
  function fail(error, location) {
    if (error && error.maUiState) { warning(error); return; }
    failure = (String(error && error.message ? error.message : error || '内容渲染失败') + (location ? '（' + location + '）' : '')).slice(0, 1000);
    stats.degraded += 1;
    send({ type: 'error', message: failure, stats: clone(stats) });
  }
  function warning(error) {
    if (typeof document === 'undefined' || !document) return;
    lastWarning = error || ownedError('交互状态保存失败');
    showWarning();
  }
  function showWarning() {
    if (!lastWarning) return;
    send({ type: 'state-warning', message: displayError(lastWarning) });
    if (!framed) {
      var node = document.getElementById('ma-ui-warning');
      if (!node) { node = document.createElement('p'); node.id = 'ma-ui-warning'; node.className = 'ma-field-error'; node.setAttribute('role', 'status'); (document.getElementById('ma-ui-content') || document.body).append(node); }
      var recorded = lastWarning;
      bind(node, '{warning}', function () { return { warning: displayError(recorded) }; }); report();
    }
  }
  function report() {
    if (typeof document === 'undefined' || !document) return;
    var content = document.getElementById('ma-ui-content') || document.body;
    if (!content) return;
    var height = Math.max(1, Math.ceil(Math.max(content.getBoundingClientRect().height, content.scrollHeight)));
    if (height !== lastHeight) { lastHeight = height; send({ type: 'resize', height: height, stats: clone(stats) }); }
  }
  function rendered(nextStats) {
    if (typeof document === 'undefined' || !document) return;
    if (nextStats) stats = { ok: Number(nextStats.ok) || 0, degraded: Number(nextStats.degraded) || 0 };
    else if (!stats.ok && !stats.degraded) stats.ok = 1;
    if (!ready || !domReady) return;
    var issues = Array.from(diagnostics.values());
    send({ type: 'render', status: failure ? 'failed' : stats.degraded || issues.length ? 'degraded' : 'rendered', recoverable: !failure && !stats.degraded && issues.length > 0, stats: { ok: stats.ok, degraded: stats.degraded + issues.length }, message: failure || issues[0]?.message || '', diagnostics: issues });
    report();
  }

  function setLocale(next) {
    if ((next !== 'en' && next !== 'zh-CN') || next === locale) return;
    locale = next;
    updateBindings();
    if (lastWarning) showWarning();
    window.dispatchEvent(new CustomEvent('ma-ui:locale'));
  }
  function diagnostic(key, detail) {
    if (detail) {
      if (JSON.stringify(diagnostics.get(key)) === JSON.stringify(detail)) return;
      diagnostics.set(key, clone(detail));
      if (!componentHost) send({ type: 'diagnostic', recoverable: true, message: detail.message, diagnostics: [clone(detail)], stats: { ok: stats.ok, degraded: stats.degraded + diagnostics.size } });
    } else if (!diagnostics.delete(key)) return;
    if (!componentHost) rendered();
  }
  var componentApi = {
    source: source, readSource: readSource, text: text,
    bindText: function (node, key, values) { bind(node, key, values); },
    bindAttr: function (node, attribute, key, values) { bind(node, key, values, attribute); },
    unbindText: function (node) { unbind(node); }, locale: function () { return locale; },
    ownedError: ownedError, displayError: displayError, displayHint: displayHint,
    diagnostic: diagnostic, getDiagnostics: function () { return clone(Array.from(diagnostics.values())); }
  };
  if (componentHost) {
    // Phone App frames already own the state, actions, and parent message protocol.
    Object.assign(componentHost, componentApi);
    componentHost.onLocaleChange(setLocale);
    return;
  }
  window.addEventListener('error', function (event) { if (event.error || event.message) fail(event.error || event.message, event.lineno ? '行 ' + event.lineno + (event.colno ? ':' + event.colno : '') : ''); });
  window.addEventListener('unhandledrejection', function (event) { fail(event.reason); });
  function receive(data) {
    if (data.type === 'init') {
      applyState(data.state);
      if (!ready) { ready = true; resolveReady(window.maUi); }
      if (Object.keys(definitions).length) persist({ defaults: clone(definitions) }).catch(warning);
      requestAnimationFrame(function () { rendered(); });
    } else if (data.type === 'probe') {
      rendered(); report();
    } else if (data.type === 'state-sync') {
      if (pending.size) {
        if (data.state && (!queuedState || data.state.revision >= queuedState.revision)) queuedState = data.state;
      } else if (data.state && data.state.revision >= revision) applyState(data.state);
    } else if (data.type === 'state-result' || data.type === 'action-result') {
      var item = pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timeout); pending.delete(data.id);
      if (data.ok === false) { var error = data.error ? new Error(data.error) : ownedError('交互操作失败'); error.maUiState = data.type === 'state-result'; item.reject(error); }
      else {
        if (data.type === 'state-result') lastWarning = null;
        if (data.state) {
          revision = data.state.revision;
          if (item.version === localVersion) applyState(data.state);
        }
        item.resolve(data.result);
      }
      replayState();
    }
    if (data.type === 'appearance' || data.type === 'init') {
      setLocale(data.locale);
      if (typeof data.visible === 'boolean') { hostVisible = data.visible; if (ready && domReady) rendered(); }
      if (data.theme === 'dark' || data.theme === 'light') document.documentElement.dataset.theme = data.theme;
      if (data.cssVars && typeof data.cssVars === 'object') Object.keys(data.cssVars).forEach(function (name) {
        if (/^--[a-z0-9-]+$/.test(name) && typeof data.cssVars[name] === 'string') document.documentElement.style.setProperty(name, data.cssVars[name]);
      });
      if (Array.isArray(data.fontStylesheets)) {
        document.querySelectorAll('link[data-ma-font]').forEach(function (link) { if (!data.fontStylesheets.includes(link.href)) link.remove(); });
        data.fontStylesheets.forEach(function (url) {
          if (typeof url !== 'string' || !/^https:\/\/(cdn-font\.hyperos\.mi\.com|cdn\.jsdelivr\.net)\//.test(url)) return;
          if (Array.from(document.querySelectorAll('link[data-ma-font]')).some(function (link) { return link.href === url; })) return;
          var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = url; link.dataset.maFont = 'true'; document.head.append(link);
        });
      }
      window.dispatchEvent(new CustomEvent('ma-ui:appearance'));
      requestAnimationFrame(report);
    }
  }
  window.addEventListener('message', function (event) {
    if (!framed || event.source !== window.parent || !event.data || event.data.__ma !== true) return;
    receive(event.data);
  });
  function initialize() {
    domReady = true;
    if (framed) document.documentElement.classList.add('in-frame');
    else if (nativeHost) {
      nativeHost.onAppearance(function (appearance) { receive(Object.assign({ type: 'appearance' }, appearance)); });
      nativeHost.onState(function (state) { receive({ type: 'state-sync', state: state }); });
    } else {
      try { applyState(JSON.parse(localStorage.getItem(storageKey) || 'null')); } catch (_) { /* standalone storage may be unavailable */ }
      resolveReady(window.maUi);
    }
    var content = document.getElementById('ma-ui-content') || document.body;
    if (typeof ResizeObserver !== 'undefined' && content) new ResizeObserver(report).observe(content);
    if (typeof MutationObserver !== 'undefined' && content) new MutationObserver(function (mutations) {
      const isSource = function (node) { return node.nodeType === 1 && node.tagName === 'SCRIPT' && node.type === 'application/json'; };
      const changed = mutations.some(function (mutation) {
        var node = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
        return isSource(node) || mutation.type === 'attributes' && node.tagName === 'SCRIPT' || Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some(function (node) { return isSource(node) || node.nodeType === 1 && node.querySelector('script[type="application/json"]'); });
      });
      if (changed) publish(false); report();
    }).observe(document.documentElement, { childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'type'], subtree: true });
    document.addEventListener('wheel', function (event) {
      if (!framed || !event.isTrusted || event.ctrlKey || event.metaKey) return;
      var local = event.target instanceof Element ? event.target.closest('[data-ma-wheel="local"]') : null;
      if (local && local.contains(document.activeElement)) return;
      // A horizontal table remains native; ordinary vertical wheel belongs to the chat.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) return;
      event.preventDefault();
      send({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode });
    }, { passive: false, capture: true });
    if (framed || nativeHost) send({ type: 'ready' });
    requestAnimationFrame(function () { rendered(); });
  }
  window.maUi = Object.assign({
    version: 2, get: get, set: set, ensure: ensure, getUi: getUi, setUi: setUi,
    subscribe: subscribe, interpolate: interpolate, getWidgetState: function () { return snapshot(false); }, stateUsage: stateUsage,
    isPrivate: function (key) {
      var root = Object.prototype.hasOwnProperty.call(values, key) ? key : key.split('.')[0];
      return !!(definitions[root] && definitions[root].private) || Object.prototype.hasOwnProperty.call(values, root) && !Object.prototype.hasOwnProperty.call(model, root);
    },
    setWidgetState: function (state) { applyState(state); return persist(); },
    whenReady: function () { return readiness; }, action: action,
    followup: function (text) { return action({ type: 'followup', text: text, mode: 'draft' }); },
    sendFollowup: function (text, title) { return action({ type: 'followup', text: text, title: title, mode: 'send' }); },
    copy: function (text) { return action({ type: 'copy', text: text }); }, warn: warning,
    openUrl: function (url) { return action({ type: 'openUrl', url: url }); },
    report: report, rendered: rendered, fail: fail, d3: window.d3 || null, three: window.THREE || null
  }, componentApi);
  Object.defineProperty(window.maUi, 'state', { get: function () { return clone(values); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
