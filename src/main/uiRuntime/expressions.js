/* Small declarative calculations and shared value formatting; no eval or dynamic code. */
(function () {
  'use strict';
  var api = window.maUi, derived = new Map();
  var functions = { min: Math.min, max: Math.max, abs: Math.abs, ceil: Math.ceil, floor: Math.floor, pow: Math.pow,
    round: function (value, digits) { var scale = Math.pow(10, digits || 0); return Math.round(value * scale) / scale; },
    sum: function () { var values = Array.from(arguments).flat(); if (values.length > 10000) throw api.ownedError('sum 最多计算 10000 项'); return values.reduce(function (total, value) { return total + numeric(value); }, 0); },
    len: function (value) { if (typeof value !== 'string' && !Array.isArray(value)) throw api.ownedError('len 需要字符串或数组'); return value.length; },
    count: function (items, key, value) {
      if (!Array.isArray(items)) throw api.ownedError('count 需要数组');
      if (key === undefined) return items.length;
      if (items.length > 10000) throw api.ownedError('count 条件筛选最多 10000 项，请使用表格 stats');
      if (typeof key !== 'string' || key.split('.').some(function (part) { return ['__proto__', 'prototype', 'constructor'].includes(part); })) throw api.ownedError('count 字段无效');
      return items.filter(function (item) { return key.split('.').reduce(function (item, part) { return item != null && Object.prototype.hasOwnProperty.call(item, part) ? item[part] : undefined; }, item) === value; }).length;
    },
    includes: function (value, search, fromIndex) { if (typeof value !== 'string' && !Array.isArray(value)) throw api.ownedError('includes 需要字符串或数组'); return value.includes(search, fromIndex); },
    concat: function () { var result = ''; for (var value of arguments) { result += value == null ? '' : String(value); if (result.length > 65536) throw api.ownedError('字符串结果超过 65536 字符'); } return result; },
    lower: function (value) { return String(value).toLocaleLowerCase(); },
    upper: function (value) { return String(value).toLocaleUpperCase(); },
    trim: function (value) { return String(value).trim(); },
    source: function (id) { return api.source(id); } };
  functions.contains = functions.includes;
  var methods = { includes: 'includes', toUpperCase: 'upper', toLowerCase: 'lower', trim: 'trim' };
  var numericFunctions = new Set(['min', 'max', 'abs', 'ceil', 'floor', 'pow', 'round']);
  function numeric(value) {
    if (typeof value === 'boolean') return Number(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    throw api.ownedError('计算需要有效数字');
  }
  function truthy(value) { return typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) !== 0 : !!value; }
  function compile(expression) {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 4096) throw api.ownedError('表达式为空或超过 4096 字符');
    var tokens = [], offset = 0, dependencies = new Set();
    var token = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(===|!==|<=|>=|==|!=|&&|\|\||[.+\-*/%(),<>?:!]))/uy;
    function error(message, position, code, hint) {
      var failure = api.ownedError(message);
      failure.diagnostic = { code: code || 'expression_syntax', expression: expression, position: (position == null ? tokens[index]?.position ?? offset : position) + 1, hint: hint || '检查此位置的运算符、括号和参数' };
      return failure;
    }
    while (offset < expression.length) {
      if (!expression.slice(offset).trim()) break;
      token.lastIndex = offset; var match = token.exec(expression);
      if (!match) throw error('表达式包含不支持的字符', offset + (expression.slice(offset).match(/^\s*/)[0].length), 'expression_character', '只允许白名单函数、字段引用及声明式运算符');
      tokens.push({ type: match[1] ? 'number' : match[2] ? 'name' : match[3] ? 'string' : 'operator', value: match[1] || match[2] || match[3] || match[4], position: offset + match[0].length - (match[1] || match[2] || match[3] || match[4]).length });
      offset = token.lastIndex;
      if (tokens.length > 512) throw error('表达式过于复杂');
    }
    var index = 0, depth = 0;
    function take(value) { if (tokens[index] && tokens[index].value === value) { index++; return true; } return false; }
    function requireToken(value) { if (!take(value)) throw error('表达式缺少 ' + value); }
    function safeParts(text, position) {
      var parts = text.split('.');
      if (parts.length > 32) throw error('表达式字段路径超过 32 层', position);
      if (parts.some(function (part) { return ['__proto__', 'constructor', 'prototype'].includes(part); })) throw error('表达式字段无效', position);
      return parts;
    }
    function argsForCall() {
      var args = [];
      if (!take(')')) { do { args.push(conditional()); } while (take(',')); requireToken(')'); }
      return args;
    }
    function methodCall(receiver, name, position, args) {
      if (!Object.prototype.hasOwnProperty.call(methods, name)) throw error('不支持的方法 ' + name, position, 'expression_method', Object.prototype.hasOwnProperty.call(functions, name) ? '请改写为 ' + name + '(value, ...)，不支持 .' + name + '() 方法写法' : '仅支持 .includes()/.toUpperCase()/.toLowerCase()/.trim()；长度使用 .length 或 len(value)，不执行任意方法');
      return { type: 'call', position: position, method: name, name: methods[name], args: [receiver].concat(args) };
    }
    function members(receiver, parts, position) {
      return parts.reduce(function (object, property) { return { type: 'member', object: object, property: property, position: position }; }, receiver);
    }
    function primary() {
      if (++depth > 32) throw error('表达式嵌套超过 32 层');
      var current = tokens[index++], result;
      if (!current) throw error('表达式不完整');
      if (current.type === 'number') result = { type: 'literal', value: Number(current.value) };
      else if (current.type === 'string') result = { type: 'literal', value: current.value.slice(1, -1).replace(/\\(['"\\])/g, '$1') };
      else if (current.type === 'name') {
        if (take('(')) {
          var parts = safeParts(current.value, current.position);
          if (parts.length > 1) {
            var method = parts.pop(), reference = parts.join('.'); dependencies.add(reference);
            result = methodCall({ type: 'reference', name: reference, position: current.position }, method, current.position, argsForCall());
          } else {
            if (!Object.prototype.hasOwnProperty.call(functions, current.value)) throw error('不支持的计算函数 ' + current.value, current.position, 'expression_function', '可用函数：' + Object.keys(functions).join(', '));
            result = { type: 'call', name: current.value, args: argsForCall() };
          }
        } else if (current.value === 'true' || current.value === 'false') result = { type: 'literal', value: current.value === 'true' };
        else if (current.value === 'null') result = { type: 'literal', value: null };
        else {
          safeParts(current.value, current.position);
          dependencies.add(current.value); result = { type: 'reference', name: current.value };
        }
      } else if (current.value === '(') { result = conditional(); requireToken(')'); }
      else if (['-', '+', '!'].includes(current.value)) result = { type: 'unary', operator: current.value, child: primary() };
      else throw error('表达式语法错误', current.position);
      var postfixDepth = 0;
      while (take('.')) {
        var property = tokens[index++];
        if (!property || property.type !== 'name') throw error('点号后需要字段或白名单方法名');
        var path = safeParts(property.value, property.position);
        postfixDepth += path.length;
        if (postfixDepth > 32) throw error('表达式字段路径超过 32 层', property.position);
        if (take('(')) { var name = path.pop(); result = methodCall(members(result, path, property.position), name, property.position, argsForCall()); }
        else result = members(result, path, property.position);
      }
      result.position = current.position; depth--; return result;
    }
    var precedence = { '||': 1, '&&': 2, '==': 3, '!=': 3, '===': 3, '!==': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
    function binary(minimum) {
      var left = primary();
      while (tokens[index] && precedence[tokens[index].value] >= minimum) {
        var operation = tokens[index++], operator = operation.value;
        left = { type: 'binary', position: operation.position, operator: operator, left: left, right: binary(precedence[operator] + 1) };
      }
      return left;
    }
    var conditionalDepth = 0;
    function conditional() {
      if (++conditionalDepth > 32) throw error('表达式嵌套超过 32 层');
      var condition = binary(1);
      if (!take('?')) { conditionalDepth--; return condition; }
      var yes = conditional(); requireToken(':'); var no = conditional(); conditionalDepth--;
      return { type: 'conditional', position: condition.position, condition: condition, yes: yes, no: no };
    }
    var tree = conditional(); if (index !== tokens.length) throw error('表达式存在多余内容');
    var evaluationPosition = 0;
    function evaluate(node, read) {
      evaluationPosition = node.position || 0;
      if (node.type === 'literal') return node.value;
      if (node.type === 'reference') { var value = read(node.name); if (value === undefined) throw api.ownedError('缺少参数 ' + node.name); return value; }
      if (node.type === 'member') {
        var object = evaluate(node.object, read); evaluationPosition = node.position || 0;
        if (object == null || !Object.prototype.hasOwnProperty.call(object, node.property)) throw api.ownedError('数据中不存在字段 ' + node.property);
        return object[node.property];
      }
      if (node.type === 'conditional') return evaluate(truthy(evaluate(node.condition, read)) ? node.yes : node.no, read);
      if (node.type === 'call') {
        var args = node.args.map(function (arg) { var value = evaluate(arg, read); return numericFunctions.has(node.name) ? numeric(value) : value; });
        evaluationPosition = node.position || 0;
        if (node.method && (node.method === 'includes' ? typeof args[0] !== 'string' && !Array.isArray(args[0]) : typeof args[0] !== 'string')) throw api.ownedError('.' + node.method + '() 的接收值类型不正确');
        return functions[node.name].apply(null, args);
      }
      if (node.type === 'unary') { var value = evaluate(node.child, read); return node.operator === '!' ? !truthy(value) : (node.operator === '-' ? -1 : 1) * numeric(value); }
      var left = evaluate(node.left, read), operator = node.operator;
      if (operator === '&&') return truthy(left) ? evaluate(node.right, read) : left;
      if (operator === '||') return truthy(left) ? left : evaluate(node.right, read);
      var right = evaluate(node.right, read);
      evaluationPosition = node.position || 0;
      if (operator === '===' || operator === '!==') return operator === '===' ? left === right : left !== right;
      if (operator === '==' || operator === '!=') {
        var same; try { same = numeric(left) === numeric(right); } catch (_) { same = String(left) === String(right); }
        return operator === '==' ? same : !same;
      }
      if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) return String(left) + String(right);
      left = numeric(left); right = numeric(right);
      if (operator === '/') { if (!right) throw api.ownedError('除数不能为零'); return left / right; }
      if (operator === '%') { if (!right) throw api.ownedError('除数不能为零'); return left % right; }
      return operator === '+' ? left + right : operator === '-' ? left - right : operator === '*' ? left * right :
        operator === '<' ? left < right : operator === '>' ? left > right : operator === '<=' ? left <= right : left >= right;
    }
    return { dependencies: Array.from(dependencies), evaluate: function (read) {
      try {
        var value = evaluate(tree, read); if (typeof value === 'number' && !Number.isFinite(value)) throw api.ownedError('计算结果不是有限数值'); if (typeof value === 'string' && value.length > 65536) throw api.ownedError('字符串结果超过 65536 字符'); return value;
      } catch (failure) { if (!failure.diagnostic) failure.diagnostic = error(failure.message, evaluationPosition, 'expression_value', '检查参数的值、类型和除数；修改输入后会重新计算').diagnostic; throw failure; }
    } };
  }
  function calculate(definition, read, stack) {
    stack = stack || [];
    if (stack.length > 32 || stack.includes(definition)) throw api.ownedError('计算结果存在循环引用');
    return definition.compiled.evaluate(function (key) {
      var dependency = derived.get(key);
      return dependency ? calculate(dependency, dependency.read, stack.concat(definition)) : read(key);
    });
  }
  function isPrivate(definition, seen) {
    seen = seen || new Set(); if (seen.has(definition)) return false;
    seen.add(definition);
    return definition.private || definition.compiled.dependencies.some(function (key) {
      return derived.has(key) ? isPrivate(derived.get(key), seen) : api.isPrivate(key);
    });
  }
  function format(value, options) {
    options = options || {};
    if (value == null) return '';
    var type = options.format, digits = options.digits == null ? 2 : Number(options.digits);
    if (!Number.isInteger(digits) || digits < 0 || digits > 8) throw api.ownedError('小数位数须为 0–8');
    var text;
    if (type === 'number' || type === 'currency' || type === 'percent') {
      var settings = { minimumFractionDigits: digits, maximumFractionDigits: digits };
      if (type === 'currency') { settings.style = 'currency'; settings.currency = options.currency || 'CNY'; }
      if (type === 'percent') settings.style = 'percent';
      text = new Intl.NumberFormat(document.documentElement.lang || 'zh-CN', settings).format(numeric(value));
    } else if (type === 'duration') {
      var seconds = Math.round(numeric(value)); if (seconds < 0) throw api.ownedError('时长不能为负数');
      text = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    } else if (type && type !== 'text') throw api.ownedError('不支持的显示格式 ' + type);
    else text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text + (options.unit ? ' ' + options.unit : '');
  }
  api.expression = { compile: compile, calculate: calculate, isPrivate: isPrivate, definitions: derived };
  api.format = format;
})();
