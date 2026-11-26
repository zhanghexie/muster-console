import { spawnOwned } from './_native.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const options = value => (Array.isArray(value) ? value : []).flatMap(item => Array.isArray(item?.options) ? item.options : [item]);
const config = (value, id, category) => (Array.isArray(value?.configOptions) ? value.configOptions : [])
  .find(item => item?.type === 'select' && (item.id === id || item.category === category));

/** Kimi's TUI lacks an effort flag. Prepare its own session over ACP and open it in the TUI. */
export async function prepareKimiSession({ cwd, env, model, reasoning, plan, additionalDirectories = [] }, spawn = spawnOwned) {
  const owner = spawn(['kimi', 'acp'], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const child = owner.child;
  let buffer = '', next = 0, sessionId = '', update, stoppedError;
  const pending = new Map();
  const fail = error => { stoppedError = error; for (const call of pending.values()) call.reject(error); pending.clear(); };
  child.stderr?.resume();
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Kimi ACP 进程提前退出')));
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > 1024 * 1024) { fail(new Error('Kimi ACP 响应过大')); child.stdout.destroy(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('Kimi ACP 返回了无效数据')); continue; }
      if (message.method === 'session/update' && message.params?.sessionId === sessionId &&
          message.params?.update?.sessionUpdate === 'config_option_update') update = message.params.update;
      if (message.method && message.id != null) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Interactive request unavailable while preparing session' } }) + '\n');
      } else if (message.id != null && pending.has(String(message.id))) {
        const call = pending.get(String(message.id)); pending.delete(String(message.id));
        if (message.error) call.reject(new Error(`Kimi ACP ${String(message.error.message || '请求失败').slice(0, 300)}`));
        else call.resolve(message.result);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (stoppedError) { reject(stoppedError); return; }
    const id = String(++next);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Kimi ACP ${method} 超时`)); }, 20_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: Number(id), method, params }) + '\n');
  });
  let prepared = false;
  let originalError;
  try {
    const init = record(await request('initialize', { protocolVersion: 1, clientInfo: { name: 'muster-console', version: '0.1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }));
    if (additionalDirectories.length && !record(record(init.agentCapabilities).sessionCapabilities).additionalDirectories) {
      throw new Error('当前 Kimi 不支持在设置思考强度时添加额外目录');
    }
    let state = record(await request('session/new', { cwd, mcpServers: [], ...(additionalDirectories.length ? { additionalDirectories } : {}) }));
    sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error('Kimi 未返回有效的会话标识');
    const set = async (id, category, value, label) => {
      const field = config(state, id, category);
      if (!field || typeof field.id !== 'string' || !options(field.options).some(item => item?.value === value)) {
        throw new Error(`当前 Kimi 模型不支持所选${label}，请刷新模型目录后重试`);
      }
      update = undefined;
      const response = record(await request('session/set_config_option', { sessionId, configId: field.id, value }));
      const confirmed = config(response, id, category) ?? config(update, id, category);
      if (!confirmed || confirmed.currentValue !== value) throw new Error(`Kimi 未确认所选${label}，请刷新模型目录后重试`);
      state = Array.isArray(response.configOptions) ? response : { ...state, configOptions: update.configOptions };
    };
    if (model) await set('model', 'model', model, '模型');
    await set('thinking', 'thought_level', reasoning, '思考强度');
    if (plan) await set('mode', 'mode', 'plan', '计划模式');
    await request('session/close', { sessionId });
    prepared = true;
  } catch (error) {
    originalError = error;
    if (sessionId) {
      // This session was created by this call and was never shown to the user.
      try { await request('session/delete', { sessionId }); }
      catch (cleanupError) {
        originalError = new Error(`${error instanceof Error ? error.message : String(error)}；Kimi 临时会话清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
      const natural = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 2000))]);
      if (!natural) {
        owner.dispose();
        const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
        if (!stopped) originalError = new Error('Kimi ACP 准备进程未能退出，请关闭该进程后重试');
      }
    }
  }
  if (originalError) throw originalError;
  if (!prepared) throw new Error('Kimi 会话准备失败');
  return sessionId;
}

/** The ACP-created session must receive the same model and workspace options as the TUI. */
export function splitKimiLaunchArgs(extraArgs) {
  const args = [], additionalDirectories = [];
  let model = '', plan = false;
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i], equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    if (['--session', '-S', '--resume', '-r', '--continue', '-c', '-C', '--agent', '--agent-file'].includes(name)) {
      throw new Error(`Kimi 思考强度不能与 ${name} 同时使用，请移除该全局启动参数`);
    }
    if (name === '--model' || name === '-m' || name === '--add-dir') {
      const value = equal < 0 ? extraArgs[++i] : arg.slice(equal + 1);
      if (!value || (equal < 0 && value.startsWith('-'))) throw new Error(`Kimi 启动参数 ${name} 缺少值`);
      if (name === '--add-dir') { additionalDirectories.push(value); args.push('--add-dir', value); } else model = value;
    } else if (arg === '--plan') plan = true;
    else args.push(arg);
  }
  return { args, model, plan, additionalDirectories };
}
