import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { session, type Session } from 'electron';

export interface FeedProxy {
  resolve(url: string): Promise<string | null>;
  fetch(url: string, proxy: string, init: RequestInit): Promise<Response>;
  hasFakeIpTunnel(): boolean;
}

/** An OS-configured synthetic-address interface is evidence of a local transparent proxy. */
export function hasFakeIpTunnel(interfaces = networkInterfaces()): boolean {
  return Object.values(interfaces).some(rows => rows?.some(row => !row.internal && row.family === 'IPv4' && /^198\.(18|19)\./.test(row.address)));
}

/** PAC/system settings are trusted host configuration, never supplied by feed content. */
export function selectFeedProxy(pac: string): string | null {
  const first = pac.split(';').map(part => part.trim()).find(Boolean);
  if (!first || first === 'DIRECT') return null;
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error('RSS system proxy type is unsupported');
  const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5' }[match[1].toUpperCase()];
  const proxy = new URL(`${scheme}://${match[2]}`);
  if (!proxy.hostname || proxy.username || proxy.password || proxy.pathname && proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('RSS system proxy configuration is invalid');
  return `${scheme}://${proxy.host}`;
}

/** Separate cookie-free sessions pin each selected proxy, excluding PAC's DIRECT fallback. */
export function createSystemFeedProxy(): FeedProxy {
  const sessions = new Map<string, Promise<Session>>();
  return {
    hasFakeIpTunnel,
    resolve: async url => selectFeedProxy(await session.defaultSession.resolveProxy(url)),
    async fetch(url, proxy, init) {
      let ready = sessions.get(proxy);
      if (!ready) {
        if (sessions.size >= 32) throw new Error('RSS proxy configuration changed too often; restart the workbench');
        ready = (async () => {
          const partition = `agent-apps-rss-${createHash('sha256').update(proxy).digest('hex')}`;
          const isolated = session.fromPartition(partition, { cache: false });
          await isolated.setProxy({ mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: '<-loopback>' });
          return isolated;
        })();
        sessions.set(proxy, ready);
        ready.catch(() => sessions.delete(proxy));
      }
      const isolated = await ready;
      init.signal?.throwIfAborted();
      return isolated.fetch(url, { ...init, redirect: 'manual', credentials: 'omit', cache: 'no-store', bypassCustomProtocolHandlers: true });
    }
  };
}
