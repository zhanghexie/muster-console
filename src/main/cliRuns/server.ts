import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { AcceptedWork } from '../net/acceptedWork';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CliError, CLI_PROTOCOL_VERSION, CLI_TERMINAL_STATES, cliCommand, validateCliArgs } from '../../shared/cli';
import type { CliRunService } from './service';
import type { CliInstance } from './discovery';

export class CliServer {
  private server?: http.Server;
  private descriptor?: string;
  private instance?: CliInstance;
  private closed = false;
  private readonly work = new AcceptedWork();
  private stopping?: Promise<void>;
  constructor(readonly service: CliRunService) {}
  async start(home: string, id: string, version: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid CLI instance ID');
    const token = randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => {
      if (!this.work.accepting) { res.writeHead(503); res.end(); return; }
      void this.work.run(() => this.request(req, res, token)).catch(error => { console.error('[cli] request failed', error); if (!res.destroyed) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ ok: false, error: { code: 'host_error', message: 'CLI request failed; inspect workbench logs' } })); } });
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    this.server = server;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('CLI listen failed');
    this.instance = { protocolVersion: CLI_PROTOCOL_VERSION, id, version, pid: process.pid, port: address.port, token, startedAt: Date.now() };
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    this.descriptor = path.join(home, `${id}.json`);
    try {
      // Exclusive temp file + atomic publish; POSIX permissions and Windows user's
      // private profile ACL protect the local capability. Never print the token.
      const temporary = `${this.descriptor}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(this.instance), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.descriptor); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    } catch (error) { await this.stop(); throw error; }
    this.service.start();
    server.on('error', error => console.error('[cli] server error', error));
  }
  stopAdmission(): void { this.closed = true; this.service.stop(); this.work.stopAdmission(); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true; this.service.stop();
    this.work.stopAdmission();
    const server = this.server;
    this.stopping = (async () => {
      const errors: unknown[] = [];
      try {
        if (this.descriptor && fs.existsSync(this.descriptor)) {
          const value = JSON.parse(fs.readFileSync(this.descriptor, 'utf8')) as CliInstance;
          if (value.token === this.instance?.token) fs.unlinkSync(this.descriptor);
        }
      } catch (error) { errors.push(error); }
      const closed = server ? new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()); server.closeAllConnections();
      }) : Promise.resolve();
      const results = await Promise.allSettled([closed, this.work.drain(), this.service.stopAndWait()]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, 'CLI shutdown failed');
      this.server = undefined;
    })();
    void this.stopping.catch(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async request(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    const auth = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? ''), expected = Buffer.from(token);
    if (this.closed || req.headers.origin || req.socket.remoteAddress !== '127.0.0.1' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: 'not_authorized', message: 'A local CLI connection credential is required' } })); return; }
    if (req.method !== 'POST' || req.url !== '/v1/command') { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'Unknown CLI endpoint' } })); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new CliError('invalid_arguments', 'Request exceeds 2 MiB'); chunks.push(Buffer.from(chunk)); }
      let body: { command?: unknown; args?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CliError('invalid_arguments', 'Invalid JSON request'); }
      if (!body || typeof body.command !== 'string') throw new CliError('invalid_arguments', 'Command is required');
      const definition = cliCommand(body.command);
      if (definition.local) throw new CliError('invalid_arguments', 'This command runs offline in the CLI');
      const args = validateCliArgs(definition, body.args ?? {});
      const result = await this.command(body.command, args, () => res.destroyed);
      if (!res.destroyed) res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      const problem = error instanceof CliError ? error : new CliError('host_error', error instanceof Error ? error.message : String(error));
      if (!res.destroyed) { res.writeHead(problem.code === 'invalid_arguments' ? 400 : 409); res.end(JSON.stringify({ ok: false, error: { code: problem.code, message: problem.message, hint: problem.hint } })); }
    }
  }
  private async command(command: string, args: Record<string, string | number>, disconnected: () => boolean): Promise<unknown> {
    const service = this.service, id = String(args.runId ?? '');
    if (command === 'status' || command === 'doctor') { const { token: _token, ...instance } = this.instance!; return { ...instance, workspaces: service.deps.workspaces(), transport: 'local-loopback', connected: true }; }
    if (command === 'workspace list') { const all = service.deps.workspaces(), offset = Number(args.offset), limit = Number(args.limit); return { workspaces: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null }; }
    if (command === 'run submit') return service.submit(String(args.workspace), String(args.text), args['idempotency-key'] as string | undefined);
    if (command === 'run list') { service.workspace(String(args.workspace)); return service.store.list(String(args.workspace), Number(args.offset), Number(args.limit)); }
    if (command === 'run get') return service.store.view(id);
    if (command === 'run reply') { const run = service.store.get(id); service.workspace(run.workspaceId); const result = service.store.reply(id, String(args.text), args['question-id'] as string | undefined, args['idempotency-key'] as string | undefined); void service.pump(); return result; }
    if (command === 'run cancel') return service.cancel(id);
    if (command === 'run result') { const run = service.store.view(id); return { ...run, ready: run.state === 'delivered' }; }
    if (command === 'run logs') return service.logs(id, Number(args.after), Number(args.limit));
    if (command === 'open') { const run = service.store.get(id); service.workspace(run.workspaceId); await service.deps.open(run); return { runId: id, opened: true, workspaceId: run.workspaceId }; }
    if (command === 'run wait') {
      const deadline = Date.now() + Math.min(25, Number(args.timeout)) * 1000;
      while (!this.closed && !disconnected()) {
        const run = service.store.view(id);
        if (CLI_TERMINAL_STATES.includes(run.state) || run.state === 'waiting') return run;
        if (Date.now() >= deadline) return { ...run, timedOut: true };
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      }
      throw new CliError('disconnected', 'Local CLI connection ended; task continues');
    }
    throw new CliError('invalid_arguments', 'Unsupported command');
  }
}
