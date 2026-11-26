import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { parsePublishingOrigin } from '../../shared/extensionPublishing';
import { t } from '../../shared/i18n';

const required = ['MUSTER_PUBLISH_ORIGIN', 'MUSTER_PUBLISH_DATA', 'MUSTER_PUBLISH_REVIEWERS_FILE',
  'MUSTER_PUBLISH_GITHUB_CLIENT_ID', 'MUSTER_PUBLISH_GITHUB_CLIENT_SECRET'] as const;
const inherited = /^(PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|SSL_CERT_FILE)$/i;
const exec = promisify(execFile);

function requirePublishingConfig(config: ReturnType<typeof parseEnv>): asserts config is ReturnType<typeof parseEnv> & Record<(typeof required)[number], string> {
  for (const key of required) {
    if (!config[key]?.trim()) throw new Error(t('发布服务配置缺少 {{key}}。', { key }));
  }
}

/** Own only the loopback service started by this app. An externally started service keeps its own lifecycle. */
export class ExtensionPublishingLocalService {
  private child?: ChildProcess;
  private flight?: Promise<void>;
  private disposed = false;
  private active?: URL;

  constructor(private readonly checkout: string | undefined, private readonly onChange: (origin?: URL) => void) {}

  get origin(): URL | undefined { return this.active; }

  start(file: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(t('应用正在退出')));
    if (this.flight) return this.flight;
    if (this.active) return Promise.resolve();
    if (this.child) return Promise.reject(new Error(t('发布服务正在停止，请稍后重试。')));
    this.flight = this.launch(file).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async launch(file: string): Promise<void> {
    const folder = path.dirname(file);
    const checkout = this.checkout ?? folder;
    const script = path.join(checkout, 'scripts', 'extension-publishing-service.mjs');
    try {
      await fs.access(script);
      createRequire(script).resolve('esbuild');
    } catch { throw new Error(t('找不到发布服务源码或依赖。请在服务源码目录运行 npm ci，再选择该目录下的配置文件。')); }
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 64 * 1024) throw new Error(t('无法读取发布服务配置文件。'));
    const config = parseEnv(await fs.readFile(file, 'utf8').catch(() => { throw new Error(t('无法读取发布服务配置文件。')); }));
    requirePublishingConfig(config);
    const port = Number(config.MUSTER_PUBLISH_PORT ?? '8791');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('发布服务端口应为 1 到 65535。'));
    let publicOrigin: URL;
    try { publicOrigin = parsePublishingOrigin(config.MUSTER_PUBLISH_ORIGIN); }
    catch { throw new Error(t('发布服务地址须为 HTTPS 或 127.0.0.1 上的 HTTP 地址。')); }
    if (publicOrigin.protocol === 'http:' && Number(publicOrigin.port || 80) !== port) {
      throw new Error(t('本机回调地址的端口须与服务监听端口一致。'));
    }
    const reviewersFile = path.resolve(folder, config.MUSTER_PUBLISH_REVIEWERS_FILE);
    try {
      const reviewers: unknown = JSON.parse(await fs.readFile(reviewersFile, 'utf8'));
      if (!Array.isArray(reviewers) || !reviewers.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error();
    } catch { throw new Error(t('审核员文件须为 GitHub 数字 ID 的 JSON 数组。')); }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.test(key)));
    try { await exec('git', ['--version'], { env, timeout: 5000, windowsHide: true }); }
    catch { throw new Error(t('找不到 Git。请安装 Git，重启应用后重试。')); }
    if (this.disposed) throw new Error(t('应用正在退出'));

    const child = spawn(process.execPath, [script], { cwd: folder, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...env, ...Object.fromEntries(required.map(key => [key, config[key]])), ELECTRON_RUN_AS_NODE: '1',
        MUSTER_PUBLISH_GITHUB_APP: config.MUSTER_PUBLISH_GITHUB_APP,
        MUSTER_PUBLISH_DATA: path.resolve(folder, config.MUSTER_PUBLISH_DATA), MUSTER_PUBLISH_REVIEWERS_FILE: reviewersFile,
        MUSTER_PUBLISH_PORT: String(port),
      } });
    this.child = child;
    const release = () => {
      this.child = undefined;
      if (this.active) { this.active = undefined; this.onChange(); }
    };
    child.on('error', error => {
      if (!child.pid) release();
      console.error('[extension-publishing] local process error', error.name);
    });
    child.once('exit', release);
    try {
      const startup = new AbortController();
      const signal = AbortSignal.any([startup.signal, AbortSignal.timeout(10_000)]);
      const message = await Promise.race([
        once(child, 'message', { signal }).then(([message]) => message as { type?: string; code?: string }),
        once(child, 'exit', { signal }).then(() => undefined),
      ]).catch(() => undefined).finally(() => startup.abort());
      if (message?.code === 'EADDRINUSE') throw new Error(t('端口 {{port}} 已占用。请停止占用进程或更换服务端口。', { port }));
      if (message?.type !== 'extension-publishing-ready') throw new Error(t('发布服务无法启动，请检查配置文件和数据目录。'));
      if (this.disposed) throw new Error(t('应用正在退出'));
      this.active = new URL(`http://127.0.0.1:${port}`);
      this.onChange(this.active);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    // Both endpoints can disconnect IPC during a bind failure. Wait for the process itself.
    const exited = new Promise<void>(resolve => child.once('exit', resolve));
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      if (child.connected) child.disconnect();
      await exited;
    } finally { clearTimeout(timer); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    await this.flight?.catch(() => {});
  }
}
