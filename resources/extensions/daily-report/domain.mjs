const TODAY = () => new Date().toISOString().slice(0, 10);
const clone = value => JSON.parse(JSON.stringify(value));

function todoStatus(todo) {
  if (todo?.doneDate) return 'done';
  if (todo?.doingDate) return 'doing';
  return 'todo';
}

function todosOnDate(todos, date) {
  return todos.filter(todo => todo.createDate === date || todo.doingDate === date || todo.doneDate === date);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** The daily report domain uses the generic host broker for files and journals. */
export function createDomainRuntime({ identity = {}, broker } = {}) {
  if (typeof broker !== 'function') throw new Error('日报 DomainRuntime 需要宿主 broker');
  let version = 0;
  const listeners = new Set();
  const emit = (actor, requestId, payload) => {
    const event = {
      type: 'state.changed',
      extensionId: identity.extensionId || 'daily-report',
      extensionInstanceId: identity.extensionInstanceId || '',
      workspaceId: identity.workspaceId || '',
      version,
      requestId: requestId || 'daily-report',
      actor: actor === 'agent' ? 'agent' : 'human',
      payload
    };
    for (const listener of listeners) listener(event);
  };

  async function readData(path, fallback, context) {
    const result = await broker('data.read', [path], context);
    if (!result || typeof result.content !== 'string') return fallback;
    try { return JSON.parse(result.content); } catch { return fallback; }
  }

  async function readTodos(context) {
    const value = await readData('todos.json', { todos: [] }, context);
    return Array.isArray(value?.todos) ? value.todos.filter(item => item && typeof item === 'object') : [];
  }

  async function writeTodos(todos, context) {
    await broker('data.write', ['todos.json', JSON.stringify({ version: 1, todos }, null, 2)], context);
  }

  async function journalDates(context) {
    const value = await broker('journal.list', [], context);
    return Array.isArray(value?.dates) ? [...value.dates].sort() : [];
  }

  async function reportDates(context) {
    const entries = await broker('data.list', ['reports'], context);
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(entry => entry && !entry.directory && !entry.dir)
      .map(entry => /^([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/.exec(String(entry.name ?? ''))?.[1])
      .filter(Boolean)
      .sort();
  }

  async function getSnapshot(context) {
    const date = TODAY();
    const [todos, journals, reports] = await Promise.all([
      readTodos(context), journalDates(context), reportDates(context)
    ]);
    return {
      version,
      selectedDate: date,
      state: { todos: clone(todos) },
      journalDates: journals,
      reportDates: reports,
      selection: { date },
      availableCommands: ['todo.create', 'todo.update', 'todo.setStatus', 'todo.delete', 'todo.recordDispatch'],
      capturedAt: new Date().toISOString()
    };
  }

  async function query(name, rawArgs, context) {
    const args = asRecord(rawArgs);
    if (name === 'journal.dates') return { version, dates: await journalDates(context) };
    const date = typeof args.date === 'string' ? args.date : TODAY();
    const todos = await readTodos(context);
    if (name === 'todos.list') return { version, date, todos: clone(todosOnDate(todos, date)) };
    if (name === 'todos.open') return { version, date, todos: clone(todosOnDate(todos, date).filter(todo => todoStatus(todo) !== 'done')) };
    throw new Error(`未知日报查询：${name}`);
  }

  async function execute(name, rawArgs, context) {
    const args = asRecord(rawArgs);
    const todos = await readTodos(context);
    const date = typeof args.date === 'string' ? args.date : TODAY();
    let result;
    if (name === 'todo.create') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('待办标题不能为空');
      result = {
        id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text,
        body: typeof args.body === 'string' ? args.body.trim() : '',
        createDate: date,
        doingDate: null,
        doneDate: null,
        createdAt: Date.now()
      };
      todos.push(result);
    } else {
      const todo = todos.find(item => item.id === args.id);
      if (!todo) throw new Error('待办不存在');
      if (name === 'todo.setStatus') {
        if (args.status === 'todo') { todo.doingDate = null; todo.doneDate = null; }
        else if (args.status === 'doing') { todo.doingDate = date; todo.doneDate = null; }
        else if (args.status === 'done') { todo.doingDate = todo.doingDate || todo.createDate; todo.doneDate = date; }
        else throw new Error('待办状态不合法');
        result = todo;
      } else if (name === 'todo.update') {
        if (typeof args.text === 'string') todo.text = args.text.trim();
        if (typeof args.body === 'string') todo.body = args.body.trim();
        result = todo;
      } else if (name === 'todo.delete') {
        todos.splice(todos.indexOf(todo), 1);
        result = { deletedId: todo.id };
      } else if (name === 'todo.recordDispatch') {
        todo.dispatches = [...(todo.dispatches || []), {
          runtimeId: String(args.runtimeId ?? ''), runtimeLabel: String(args.runtimeLabel ?? ''),
          sessionId: args.sessionId ?? null, at: new Date().toISOString()
        }];
        if (!todo.doingDate) todo.doingDate = date;
        result = todo;
      } else {
        throw new Error(`未知日报命令：${name}`);
      }
    }
    await writeTodos(todos, context);
    version += 1;
    const output = clone(result);
    emit(context.actor, context.requestId, { action: name, date, result: output });
    return { ok: true, version, result: output };
  }

  return {
    getSnapshot,
    query,
    execute,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { listeners.clear(); }
  };
}
