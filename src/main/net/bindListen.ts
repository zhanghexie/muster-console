import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

function listenOnce(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    server.once('error', onErr);
    server.listen(port, host, () => {
      server.off('error', onErr);
      const addr = server.address() as AddressInfo | null;
      resolve(addr?.port ?? port);
    });
  });
}

/**
 * 绑定 HTTP 端口：先试 preferred；EADDRINUSE 时改 listen(0) 系统分配，避免多实例互踩。
 * preferred=0 直接系统分配。
 */
export async function listenPreferred(
  server: Server,
  preferred: number,
  host: string
): Promise<{ port: number; fallback: boolean }> {
  const first = preferred >= 0 ? preferred : 0;
  try {
    const port = await listenOnce(server, first, host);
    return { port, fallback: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (first !== 0 && code === 'EADDRINUSE') {
      const port = await listenOnce(server, 0, host);
      return { port, fallback: true };
    }
    throw err;
  }
}
