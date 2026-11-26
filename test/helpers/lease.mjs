/** One test command per checkout, including nested runner/Vitest/typecheck stages. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireTestLease(root, env = process.env) {
  const lock = path.join(root, '.tmp', 'test-command.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const read = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { return null; } };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  const previous = read();
  if (previous && env.TEST_LEASE_TOKEN === previous.token && alive(previous.pid)) return () => {};
  if (previous && !alive(previous.pid) && read()?.token === previous.token) fs.unlinkSync(lock);
  const token = randomUUID();
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`已有测试命令占用本仓库（PID ${read()?.pid ?? '正在启动'}），本次不再开测试进程。`);
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
  fs.closeSync(fd);
  const oldToken = env.TEST_LEASE_TOKEN;
  env.TEST_LEASE_TOKEN = token;
  const release = () => {
    if (read()?.token === token) fs.unlinkSync(lock);
    if (oldToken === undefined) delete env.TEST_LEASE_TOKEN;
    else env.TEST_LEASE_TOKEN = oldToken;
  };
  process.once('exit', release);
  return () => { process.removeListener('exit', release); release(); };
}
