import net from 'node:net';
import tls from 'node:tls';
import type { ImapTransport } from 'imapflow';

/** Keep the Node socket fence after ImapFlow drops its own socket references. */
export function createOwnedImapTransport(): { transport: ImapTransport; close(): Promise<void> } {
  const sockets = new Map<net.Socket, Promise<void>>();
  const track = (socket: net.Socket): net.Socket => {
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => { sockets.delete(socket); resolve(); });
    });
    sockets.set(socket, closed);
    return socket;
  };
  return {
    transport: {
      connect({ host, port, servername, secure, tls: options }, onConnect) {
        return track(secure ? tls.connect({ host, port, servername, ...options }, onConnect) : net.connect({ host, port }, onConnect));
      },
      upgrade(socket, { host, port, servername, tls: options }, onSecure) {
        return track(tls.connect({ host, port, servername, ...options, socket: socket as net.Socket }, onSecure));
      }
    },
    async close() {
      const closing = [...sockets];
      for (const [socket] of closing) if (!socket.destroyed) socket.destroy();
      await Promise.all(closing.map(([, closed]) => closed));
    }
  };
}
