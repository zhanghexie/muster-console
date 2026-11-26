/** Controlled PTY leader. User code starts only after the owner confirms its container. */
export const BACKGROUND_PTY_BOOTSTRAP = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const endpoint = process.env.MUSTER_BG_OWNER_ENDPOINT;
const token = process.env.MUSTER_BG_OWNER_TOKEN;
const socket = net.createConnection(endpoint);
socket.setEncoding('utf8');
let input = '', launched = false, child;
const send = value => socket.write(JSON.stringify(value) + '\n');
socket.on('connect', () => send({ type: 'hello', token, pid: process.pid }));
const retire = code => { if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL'); } catch {} } process.exit(code); };
socket.on('error', () => retire(91));
socket.on('close', () => retire(92));
socket.on('data', chunk => {
  input += chunk.toString('utf8');
  if (input.length > 16777216) process.exit(93);
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { process.exit(94); }
    if (message.type === 'challenge') send({ type: 'proof', nonce: message.nonce, pid: process.pid });
    else if (message.type === 'stdin' || message.type === 'stdin-end') {
      const reply = error => send({ type: 'input-ack', id: message.id, ...(error ? { error: 'Command stdin write failed: ' + String(error.code || error.message) } : {}) });
      if (!child || !child.stdin) { reply(new Error('stdin unavailable')); continue; }
      try {
        if (message.type === 'stdin') child.stdin.write(Buffer.from(message.data, 'base64'), reply);
        else child.stdin.end(() => reply());
      } catch (error) { reply(error); }
    }
    else if (message.type === 'run' && !launched) {
      launched = true;
      const env = message.replaceEnv ? { ...message.env } : { ...process.env, ...message.env };
      delete env.MUSTER_BG_OWNER_ENDPOINT; delete env.MUSTER_BG_OWNER_TOKEN;
      if (!message.env || !Object.prototype.hasOwnProperty.call(message.env, 'ELECTRON_RUN_AS_NODE')) delete env.ELECTRON_RUN_AS_NODE;
      try { child = spawn(message.command, message.args, { cwd: message.cwd, env, stdio: message.pipeInput ? ['pipe', 'inherit', 'inherit'] : 'inherit', windowsHide: true, detached: false, shell: !!message.shell, windowsVerbatimArguments: !!message.windowsVerbatimArguments }); }
      catch (error) { send({ type: 'failed', error: String(error) }); continue; }
      if (child.stdin) child.stdin.on('error', error => send({ type: 'failed', error: 'stdin: ' + String(error.code || error.message) }));
      child.once('spawn', () => send({ type: 'started' }));
      child.once('error', error => send({ type: 'failed', error: String(error) }));
      child.once('exit', (code, signal) => send({ type: 'completed', code: code === null ? 1 : code, signal }));
      // Keep this authenticated leader alive after command exit. The owner can
      // still reclaim its Job/process group without using a recycled shell PID.
    }
  }
});
`;
